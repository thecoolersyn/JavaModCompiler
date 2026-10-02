import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createApi, tempDir, write, buildTinyMappings, zip } from '../helpers/harness.mjs';

const api = createApi();
const JAVA_HOME = path.join(tempDir('e2e-home'), '.umc');

test('a Gradle project compiles, packages, validates and reports', { timeout: 1_800_000 }, async () => {
  const project = tempDir('e2e-gradle');
  write(
    project,
    'build.gradle',
    [
      'plugins {',
      "    id 'java'",
      '}',
      '',
      "group = 'com.example'",
      "version = '1.2.3'",
      '',
      "tasks.register('remapJar') {",
      "    dependsOn 'jar'",
      '}',
    ].join('\n'),
  );
  write(project, 'gradle.properties', 'minecraft_version=1.20.1\n');
  write(project, 'settings.gradle', "rootProject.name = 'e2emod'\n");
  write(
    project,
    'src/main/java/com/example/e2e/E2eMod.java',
    [
      'package com.example.e2e;',
      '',
      'public final class E2eMod {',
      '    public static String id() {',
      '        return "e2emod";',
      '    }',
      '}',
      '',
    ].join('\n'),
  );
  write(
    project,
    'src/main/resources/fabric.mod.json',
    JSON.stringify({ schemaVersion: 1, id: 'e2emod', version: '1.2.3', environment: '*', depends: { minecraft: '1.20.1' } }),
  );
  write(project, 'src/main/resources/META-INF/MANIFEST.MF', 'Manifest-Version: 1.0\n');

  const output = path.join(project, 'e2e.jar');
  const result = await runJson([project, '--java', '21', '--out', output, '--yes', '--debug', '--json']);
  const summary = JSON.parse(result.stdout);

  assert.equal(summary.failedStage, undefined, `build failed at ${summary.failedStage}: ${JSON.stringify(summary.diagnostics.slice(0, 2))}`);
  assert.equal(summary.status, 'pass');
  assert.equal(summary.buildPassed, true);
  assert.equal(result.code, 0);
  assert.equal(summary.output, 'e2e.jar');

  assert.equal(fs.existsSync(output), true, 'the requested output path must exist');
  const inspection = await api.inspectJar(output);
  assert.ok(inspection.classCount >= 1);
  assert.ok(inspection.classes.includes('com/example/e2e/E2eMod.class'));
  assert.equal(inspection.crcOk, true);

  const stageIds = summary.stages.map((stage) => stage.stage);
  assert.deepEqual(stageIds, ['DISCOVER', 'RESOLVE', 'PREPARE', 'COMPILE', 'TRANSFORM', 'REMAP', 'PACKAGE', 'VALIDATE', 'RUNTIME_TEST']);
  for (const stage of summary.stages) {
    assert.notEqual(stage.status, 'failed', `stage ${stage.stage} failed`);
    assert.ok(Number.isFinite(stage.durationMs));
    assert.equal(typeof stage.label, 'string');
    assert.ok(Array.isArray(stage.artifacts));
  }
  const packaged = summary.stages.find((stage) => stage.stage === 'PACKAGE');
  assert.equal(packaged.status, 'pass');
  assert.ok(packaged.artifacts.some((artifact) => artifact.endsWith('e2e.jar')));

  assert.ok(fs.existsSync(path.join(JAVA_HOME, 'runtimes')), 'a managed JDK must be stored under JMC_HOME/runtimes');
  assert.ok(fs.existsSync(path.join(JAVA_HOME, 'cache', 'gradle')), 'Gradle must be cached under JMC_HOME');
});

test('the build produces json and html reports plus a lock file', { timeout: 1_800_000 }, async () => {
  const project = tempDir('e2e-reports');
  write(project, 'build.gradle', "plugins { id 'java' }\n");
  write(project, 'gradle.properties', 'minecraft_version=1.20.1\n');
  write(project, 'settings.gradle', "rootProject.name = 'reportmod'\n");
  write(project, 'src/main/java/com/example/R.java', 'package com.example;\npublic class R {}\n');

  const result = await runJson([project, '--java', '21', '--out', 'report.jar', '--yes', '--keep-workspace', '--debug', '--json']);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.failedStage, undefined);

  const workspace = summary.workspace;
  assert.equal(typeof workspace, 'string');
  const logs = path.join(workspace, 'logs');
  for (const file of ['build.log', 'build-report.json', 'build-report.html', 'build-lock.json']) {
    assert.equal(fs.existsSync(path.join(logs, file)), true, `${file} must be produced`);
  }

  const report = JSON.parse(fs.readFileSync(path.join(logs, 'build-report.json'), 'utf8'));
  assert.equal(report.schemaVersion, 1);
  assert.equal(typeof report.buildId, 'string');
  assert.equal(report.project.buildSystem, 'gradle');
  assert.equal(report.project.minecraftVersion, '1.20.1');
  assert.equal(typeof report.toolchain.javaVersion, 'string');
  assert.ok(Array.isArray(report.stages));
  assert.ok(Array.isArray(report.diagnostics));
  assert.equal(report.artifact.path.endsWith('report.jar'), true);
  assert.match(report.artifact.sha256, /^[0-9a-f]{64}$/);

  const lock = JSON.parse(fs.readFileSync(path.join(logs, 'build-lock.json'), 'utf8'));
  assert.equal(lock.minecraft.version, '1.20.1');
  assert.equal(typeof lock.gradle.version, 'string');
  assert.equal(typeof lock.java.major, 'number');
  assert.ok(Array.isArray(lock.repositories));
  assert.ok(Array.isArray(lock.dependencies));

  const html = fs.readFileSync(path.join(logs, 'build-report.html'), 'utf8');
  assert.match(html, /<!DOCTYPE html>/);
  assert.match(html, /FINAL STATUS/);
  assert.match(html, /report\.jar/);

  const log = fs.readFileSync(path.join(logs, 'build.log'), 'utf8');
  assert.match(log, /Stage summary/);
});

test('the runtime test runs only inside a disposable sandbox', { timeout: 1_800_000 }, async () => {
  const project = tempDir('e2e-sandbox');
  write(project, 'build.gradle', "plugins { id 'java' }\n");
  write(project, 'gradle.properties', 'minecraft_version=1.20.1\n');
  write(project, 'settings.gradle', "rootProject.name = 'sandboxmod'\n");
  write(project, 'src/main/java/com/example/S.java', 'package com.example;\npublic class S {}\n');

  const result = await runJson([project, '--java', '21', '--out', 'sandbox.jar', '--runtime-test', '--yes', '--debug', '--json']);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.failedStage, undefined, `build failed: ${JSON.stringify(summary.diagnostics.slice(0, 2))}`);
  const runtimeStage = summary.stages.find((stage) => stage.stage === 'RUNTIME_TEST');
  assert.equal(runtimeStage.status, 'skipped', 'an unprovisioned sandbox must be skipped, not reported as a pass');
  assert.equal(summary.runtimeTest.executed, false);
  assert.equal(summary.runtimeTestPassed, undefined, 'an unprovisioned sandbox must not report a runtime pass');
  assert.ok(
    summary.runtimeTest.messages.some((message) => /not executed/i.test(message)),
    `the runtime stage must state why it was skipped: ${JSON.stringify(summary.runtimeTest.messages)}`,
  );

  const sandbox = path.join(JAVA_HOME, 'sandboxes');
  assert.equal(fs.existsSync(sandbox), true, 'the sandbox must live under JMC_HOME/sandboxes');
  const builds = fs.readdirSync(sandbox);
  assert.ok(builds.length >= 1);
  const projectDirectory = path.join(sandbox, builds[0]);
  const versions = fs.readdirSync(projectDirectory);
  const versionDirectory = path.join(projectDirectory, versions[0]);
  const artifacts = fs.readdirSync(versionDirectory);
  const buildDirectory = path.join(versionDirectory, artifacts[0]);
  assert.equal(fs.existsSync(path.join(buildDirectory, 'mods')), true);
  assert.equal(fs.existsSync(path.join(buildDirectory, 'jmc-sandbox.json')), true);
  const manifest = JSON.parse(fs.readFileSync(path.join(buildDirectory, 'jmc-sandbox.json'), 'utf8'));
  assert.match(manifest.note, /never launches a user Minecraft installation/);
});

test('a failing compile produces an actionable diagnostic and a non zero exit code', { timeout: 1_800_000 }, async () => {
  const project = tempDir('e2e-failure');
  write(project, 'build.gradle', "plugins { id 'java' }\n");
  write(project, 'gradle.properties', 'minecraft_version=1.20.1\n');
  write(project, 'settings.gradle', "rootProject.name = 'brokenmod'\n");
  write(
    project,
    'src/main/java/com/example/Broken.java',
    ['package com.example;', '', 'public class Broken {', '    MissingType field;', '}', ''].join('\n'),
  );

  const result = await runJson([project, '--java', '21', '--out', 'broken.jar', '--yes', '--json']);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.status, 'failed');
  assert.equal(summary.failedStage, 'COMPILE');
  assert.notEqual(result.code, 0);
  const diagnostic = summary.diagnostics.find((entry) => entry.severity === 'error');
  assert.ok(diagnostic !== undefined);
  assert.equal(typeof diagnostic.title, 'string');
  assert.ok(diagnostic.suggestions.length > 0);
  assert.ok(diagnostic.detected.length > 0);
  assert.equal(fs.existsSync(path.join(project, 'broken.jar')), false, 'a failed build must not produce an artifact');
});

test('mappings with a mismatched Minecraft version are reported, not silently used', { timeout: 1_800_000 }, async () => {
  const project = tempDir('e2e-mapping-mismatch');
  write(project, 'build.gradle', "plugins { id 'java' }\n");
  write(project, 'gradle.properties', 'minecraft_version=1.20.1\n');
  write(project, 'settings.gradle', "rootProject.name = 'mismatchmod'\n");
  write(project, 'src/main/java/com/example/M.java', 'package com.example;\npublic class M {}\n');

  const mappings = tempDir('e2e-mismatch-mappings');
  write(mappings, 'mappings-26.2.tiny', buildTinyMappings(3, 300, '26.2'));
  write(
    mappings,
    'parchment-26.2.json',
    JSON.stringify({ name: 'Parchment for 26.2', version: '26.2+build.7', targetNamespace: 'named', minecraftVersion: '26.2' }),
  );

  const result = await runJson([mappings, 'mismatch.jar', '--project', project, '--java', '21', '--yes', '--offline', '--json']);
  const summary = JSON.parse(result.stdout);
  const mappingDiagnostic = summary.diagnostics.find((entry) => entry.id === 'minecraft-mapping-mismatch');
  assert.ok(mappingDiagnostic !== undefined, 'a mapping version mismatch must be diagnosed');
  assert.equal(mappingDiagnostic.stage, 'DISCOVER');
  assert.equal(summary.failedStage, 'DISCOVER');
  assert.notEqual(result.code, 0);
  assert.equal(mappingDiagnostic.expected, '1.20.1');
  assert.equal(mappingDiagnostic.actual, '26.2');
});

test('a repeated build reuses the isolated workspace and cached toolchain', { timeout: 1_800_000 }, async () => {
  const project = tempDir('e2e-repeat');
  write(project, 'build.gradle', "plugins { id 'java' }\n");
  write(project, 'gradle.properties', 'minecraft_version=1.20.1\n');
  write(project, 'settings.gradle', "rootProject.name = 'repeatmod'\n");
  write(project, 'src/main/java/com/example/Rp.java', 'package com.example;\npublic class Rp {}\n');

  const first = JSON.parse((await runJson([project, '--java', '21', '--out', 'repeat.jar', '--yes', '--debug', '--json'])).stdout);
  assert.equal(first.failedStage, undefined);
  const firstWorkspace = first.workspace;
  const firstReport = JSON.parse(fs.readFileSync(path.join(firstWorkspace, 'logs', 'build-report.json'), 'utf8'));

  const second = JSON.parse((await runJson([project, '--java', '21', '--out', 'repeat.jar', '--yes', '--debug', '--json'])).stdout);
  assert.equal(second.failedStage, undefined);
  assert.notEqual(second.buildId, first.buildId);
  const secondReport = JSON.parse(fs.readFileSync(path.join(second.workspace, 'logs', 'build-report.json'), 'utf8'));

  assert.equal(secondReport.lock.minecraft.version, firstReport.lock.minecraft.version);
  assert.equal(secondReport.lock.gradle.version, firstReport.lock.gradle.version);
  assert.equal(secondReport.lock.java.major, firstReport.lock.java.major);
  assert.deepEqual(
    secondReport.lock.repositories.map((entry) => entry.url),
    firstReport.lock.repositories.map((entry) => entry.url),
  );
  assert.equal(fs.existsSync(path.join(project, 'repeat.jar')), true);
});

test('a jar with a duplicate class fails validation', async () => {
  const project = tempDir('e2e-duplicate');
  const artifact = path.join(project, 'duplicate.jar');
  const classBytes = Buffer.from('CAFEBABE00000041', 'hex');
  fs.writeFileSync(
    artifact,
    zip([
      { name: 'META-INF/MANIFEST.MF', data: Buffer.from('Manifest-Version: 1.0\n') },
      { name: 'com/example/Dup.class', data: classBytes },
      { name: 'com/example/Dup.class', data: classBytes },
    ]),
  );
  const analysis = await api.analyzeBytecode({ jarPath: artifact });
  assert.equal(analysis.duplicateClasses.length, 1);
  assert.ok(analysis.diagnostics.some((diagnostic) => diagnostic.id === 'duplicate-class'));
});

async function runJson(args) {
  const { runCli } = await import('../helpers/harness.mjs');
  return runCli(args, { env: { JMC_HOME: JAVA_HOME }, stdin: { isTTY: false } });
}