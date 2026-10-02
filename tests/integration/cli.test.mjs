import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi, capture, runCli, tempDir, write, buildTinyMappings } from '../helpers/harness.mjs';

const api = createApi();

function fabricProject(name, { minecraft = '1.20.1', loader = '0.15.11', extraDependencies = [] } = {}) {
  const root = tempDir(name);
  write(
    root,
    'build.gradle',
    [
      'plugins {',
      "    id 'fabric-loom' version '1.6-SNAPSHOT'",
      '}',
      '',
      "version = '1.0.0'",
      "group = 'com.example'",
      '',
      'repositories {',
      '    mavenCentral()',
      '    maven { name = "example"; url = "https://repo.example.invalid/maven" }',
      '}',
      '',
      'dependencies {',
      '    minecraft "com.mojang:minecraft:${project.minecraft_version}"',
      '    mappings "net.fabricmc:yarn:${project.minecraft_version}:v2"',
      '    modImplementation "net.fabricmc:fabric-loader:${project.loader_version}"',
      ...extraDependencies,
      '}',
      '',
      "tasks.register('remapJar') {",
      "    dependsOn 'jar'",
      '}',
    ].join('\n'),
  );
  write(root, 'gradle.properties', `minecraft_version=${minecraft}\nloader_version=${loader}\n`);
  write(root, 'settings.gradle', "rootProject.name = 'fixture'\n");
  write(
    root,
    'src/main/java/com/example/FixtureMod.java',
    ['package com.example;', '', 'public final class FixtureMod {', '    public static String id() {', '        return "fixture";', '    }', '}', ''].join('\n'),
  );
  write(
    root,
    'src/main/resources/fabric.mod.json',
    JSON.stringify({ schemaVersion: 1, id: 'fixture', version: '1.0.0', environment: '*', depends: { minecraft: minecraft } }, null, 2),
  );
  return root;
}

function legacyForgeProject(name) {
  const root = tempDir(name);
  write(
    root,
    'build.gradle',
    [
      'buildscript {',
      '    repositories {',
      '        maven { url = "https://maven.minecraftforge.net" }',
      '    }',
      "    dependencies { classpath 'net.minecraftforge.gradle:ForgeGradle:5.1.+' }",
      '}',
      '',
      "apply plugin: 'net.minecraftforge.gradle'",
      '',
      "archivesBaseName = 'legacyforge'",
      'dependencies {',
      '    minecraft "net.minecraftforge:forge:1.12.2-14.23.5.2859"',
      '}',
    ].join('\n'),
  );
  write(root, 'gradle.properties', 'minecraft_version=1.12.2\norg.gradle.jvmargs=-Xmx3G\n');
  write(root, 'settings.gradle', "rootProject.name = 'legacyforge'\n");
  write(root, 'src/main/java/com/example/Legacy.java', 'package com.example;\npublic class Legacy {}\n');
  write(root, 'src/main/resources/META-INF/mods.toml', 'modLoader="javafml"\nloaderVersion="[36,)"\nlicense="MIT"\n[[mods]]\nmodId="legacy"\nversion="1.0.0"\n');
  return root;
}

function modernNeoForgeProject(name) {
  const root = tempDir(name);
  write(
    root,
    'build.gradle.kts',
    [
      'plugins {',
      '    id("net.neoforged.moddev") version "2.0.0"',
      '}',
      '',
      'neoForge {',
      '    version = "21.1.72"',
      '}',
    ].join('\n'),
  );
  write(root, 'gradle.properties', 'minecraft_version=21.1.72\norg.gradle.jvmargs=-Xmx3G\n');
  write(root, 'settings.gradle.kts', 'rootProject.name = "modernforge"\n');
  write(root, 'src/main/java/com/example/Modern.java', 'package com.example;\npublic class Modern {}\n');
  write(root, 'src/main/resources/META-INF/neoforge.mods.toml', 'modLoader="javafml"\n[[mods]]\nmodId="modern"\nversion="1.0.0"\n');
  return root;
}

function quiltProject(name) {
  const root = tempDir(name);
  write(
    root,
    'build.gradle',
    ['plugins {', "    id 'org.quiltmc.loom' version '1.0.+'", '}', '', "group = 'com.example'", "version = '1.0.0'"].join('\n'),
  );
  write(root, 'gradle.properties', 'minecraft_version=1.20.4\nloader_version=0.22.0\n');
  write(root, 'settings.gradle', "rootProject.name = 'quiltmod'\n");
  write(root, 'src/main/java/com/example/QuiltMod.java', 'package com.example;\npublic class QuiltMod {}\n');
  write(root, 'src/main/resources/quilt.mod.json', JSON.stringify({ schema_version: 1, id: 'quiltmod', version: '1.0.0' }));
  return root;
}

function mappingsDirectory(name, version = '1.20.1') {
  const root = tempDir(name);
  write(root, `${version}.tiny`, buildTinyMappings(3, 200, version));
  return root;
}

test('a modern Fabric project is detected across every dimension', async () => {
  const root = fabricProject('cli-fabric');
  const result = await runCli(['detect', root]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Build System:\s*\n\s*Gradle/);
  assert.match(result.stdout, /Language:\s*\n\s*java/);
  assert.match(result.stdout, /1\.20\.1/);
  assert.match(result.stdout, /Loader:\s*\n\s*Fabric/);
  assert.match(result.stdout, /fabric\.mod\.json/);
});

test('detect emits only JSON in json mode', async () => {
  const root = fabricProject('cli-fabric-json');
  const result = await runCli(['detect', root, '--json']);
  assert.equal(result.code, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.project.buildSystem, 'gradle');
  assert.equal(parsed.minecraft.version, '1.20.1');
  assert.equal(parsed.loader.kind, 'fabric');
  assert.equal(parsed.project.languages, 'java');
});

test('a 1.12 Forge project is detected', async () => {
  const root = legacyForgeProject('cli-forge');
  const parsed = JSON.parse((await runCli(['detect', root, '--json'])).stdout);
  assert.equal(parsed.minecraft.version, '1.12.2');
  assert.equal(parsed.loader.kind, 'forge');
  assert.match(parsed.metadata[0].path, /mods\.toml$/);
});

test('a modern NeoForge project is detected', async () => {
  const root = modernNeoForgeProject('cli-neoforge');
  const parsed = JSON.parse((await runCli(['detect', root, '--json'])).stdout);
  assert.equal(parsed.loader.kind, 'neoforge');
  assert.equal(parsed.project.buildSystem, 'gradle');
  assert.match(parsed.metadata[0].path, /neoforge\.mods\.toml$/);
});

test('a Quilt project is detected', async () => {
  const root = quiltProject('cli-quilt');
  const parsed = JSON.parse((await runCli(['detect', root, '--json'])).stdout);
  assert.equal(parsed.loader.kind, 'quilt');
  assert.equal(parsed.minecraft.version, '1.20.4');
});

test('mappings inspection is available in text and json form', async () => {
  const mappings = mappingsDirectory('cli-mappings', '1.21.4');
  const text = await runCli(['mappings', mappings]);
  assert.equal(text.code, 0);
  assert.match(text.stdout, /Mapping format: tiny-v2/);
  assert.match(text.stdout, /Target namespace: named/);

  const json = await runCli(['mappings', mappings, '--json']);
  assert.equal(json.code, 0);
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.format, 'tiny-v2');
  assert.equal(parsed.targetNamespace, 'named');
  assert.equal(parsed.minecraft.version, '1.21.4');
  assert.ok(parsed.entryCounts.classes > 0);
});

test('mappings on a missing path fails with a non zero exit code', async () => {
  const result = await runCli(['mappings', '/nonexistent/mappings']);
  assert.notEqual(result.code, 0);
  assert.match(result.stdout + result.stderr, /does not exist/);
});

test('an unknown flag produces an invalid usage exit code', async () => {
  const result = await runCli(['detect', '.', '--not-a-flag']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /Unknown option/);
});

test('a missing output path produces an invalid usage exit code', async () => {
  const root = fabricProject('cli-no-output');
  const result = await runCli([root]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /output artifact path is required/);
});

test('a missing mappings path fails during discovery', async () => {
  const root = fabricProject('cli-bad-mappings');
  const result = await runCli(['./does-not-exist', 'mod.jar', '--project', root, '--offline', '--json', '--yes']);
  assert.notEqual(result.code, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.status, 'failed');
  assert.equal(parsed.failedStage, 'DISCOVER');
  assert.ok(parsed.diagnostics.some((diagnostic) => diagnostic.id === 'mappings-path-missing'));
});

test('json mode reports the full stage list', async () => {
  const root = fabricProject('cli-json-stages');
  const mappings = mappingsDirectory('cli-json-mappings');
  const result = await runCli([mappings, 'mod.jar', '--project', root, '--offline', '--json', '--yes']);
  const parsed = JSON.parse(result.stdout);
  assert.equal(typeof parsed.buildId, 'string');
  assert.ok(Array.isArray(parsed.stages));
  assert.ok(parsed.stages.length > 0);
  for (const stage of parsed.stages) {
    assert.equal(typeof stage.stage, 'string');
    assert.equal(typeof stage.status, 'string');
    assert.equal(typeof stage.durationMs, 'number');
  }
  assert.ok(parsed.diagnostics !== undefined);
  assert.equal(typeof parsed.buildPassed, 'boolean');
});

test('json mode contains no human status text on stdout', async () => {
  const root = fabricProject('cli-json-pure');
  const mappings = mappingsDirectory('cli-json-pure-mappings');
  const result = await runCli([mappings, 'mod.jar', '--project', root, '--offline', '--json', '--yes']);
  assert.doesNotThrow(() => JSON.parse(result.stdout));
  assert.doesNotMatch(result.stdout, /\[PASS\]/);
  assert.doesNotMatch(result.stdout, /\[FAILED\]/);
  assert.doesNotMatch(result.stdout, /\[DOWNLOAD\]/);
});

test('quiet mode suppresses progress output but keeps the final status', async () => {
  const root = fabricProject('cli-quiet');
  const mappings = mappingsDirectory('cli-quiet-mappings');
  const result = await runCli([mappings, 'mod.jar', '--project', root, '--offline', '--quiet', '--yes']);
  assert.doesNotMatch(result.stdout, /\[PASS\]/);
  assert.doesNotMatch(result.stdout, /\[INFO\]/);
});

test('offline mode never reaches the network for dependencies', async () => {
  const root = fabricProject('cli-offline', {
    extraDependencies: ["    implementation 'com.example.absent:absent:1.0.0'"],
  });
  const mappings = mappingsDirectory('cli-offline-mappings');
  const result = await runCli([mappings, 'mod.jar', '--project', root, '--offline', '--json', '--yes']);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.status, 'failed');
  assert.equal(parsed.failedStage, 'RESOLVE');
  const diagnostic = parsed.diagnostics.find((entry) => entry.id === 'dependency-resolution');
  assert.ok(diagnostic !== undefined);
  assert.match(diagnostic.title, /Dependency Resolution/);
  assert.ok(diagnostic.evidence.length > 0);
  assert.equal(result.code, 6);
});

test('doctor returns a machine readable report', async () => {
  const result = await runCli(['doctor', '--offline', '--json']);
  const parsed = JSON.parse(result.stdout);
  assert.equal(typeof parsed.ok, 'boolean');
  assert.ok(parsed.checks.length >= 8);
  for (const check of parsed.checks) {
    assert.equal(typeof check.name, 'string');
    assert.ok(['pass', 'warning', 'failed'].includes(check.status));
    assert.ok(Array.isArray(check.detail));
  }
});

test('help output documents every command and flag', async () => {
  const result = await runCli(['--help']);
  assert.equal(result.code, 0);
  for (const fragment of [
    'jmc <mappings> <output.jar>',
    'jmc doctor',
    'jmc detect',
    'jmc mappings',
    'jmc dependencies',
    '--project',
    '--minecraft',
    '--loader',
    '--java',
    '--offline',
    '--debug',
    '--verbose',
    '--quiet',
    '--json',
    '--keep-workspace',
    '--runtime-test',
    '--no-cache',
    '--clean',
    '--force',
  ]) {
    assert.ok(result.stdout.includes(fragment), `help must mention ${fragment}`);
  }
});

test('version output is available in both modes', async () => {
  const text = await runCli(['--version']);
  assert.equal(text.code, 0);
  assert.match(text.stdout, /^jmc \d+\.\d+\.\d+$/m);
  const json = await runCli(['--version', '--json']);
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.name, 'jmc');
  assert.match(parsed.version, /^\d+\.\d+\.\d+$/);
});

test('plugins command reports the builtin adapters', async () => {
  const result = await runCli(['plugins', '--json']);
  assert.equal(result.code, 0);
  const parsed = JSON.parse(result.stdout);
  const ids = parsed.builtInAdapters.map((adapter) => adapter.id);
  for (const expected of ['fabric', 'quilt', 'neoforge', 'forge', 'generic-gradle']) {
    assert.ok(ids.includes(expected), `builtin adapter ${expected} must be registered`);
  }
  assert.equal(typeof parsed.pluginDirectory, 'string');
});

test('cache command reports every cache section', async () => {
  const result = await runCli(['cache', '--json']);
  assert.equal(result.code, 0);
  const parsed = JSON.parse(result.stdout);
  const sections = parsed.sections.map((section) => section.section);
  for (const expected of ['maven', 'minecraft', 'mappings', 'loaders', 'gradle', 'java', 'transformed', 'remapped', 'artifacts']) {
    assert.ok(sections.includes(expected), `cache section ${expected} must exist`);
  }
});

test('build script execution requires explicit authorization in a non interactive session', async () => {
  const root = fabricProject('cli-authorization');
  const mappings = mappingsDirectory('cli-authorization-mappings');
  const previous = process.env.JMC_NON_INTERACTIVE;
  process.env.JMC_NON_INTERACTIVE = '1';
  try {
    const result = await runCli([mappings, 'mod.jar', '--project', root, '--offline', '--json']);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.status, 'failed');
    assert.equal(parsed.failedStage, 'DISCOVER');
    const diagnostic = parsed.diagnostics.find((entry) => entry.id === 'authorization-denied');
    assert.ok(diagnostic !== undefined);
    assert.match(diagnostic.summary, /not authorized/i);
    assert.match(diagnostic.title, /Authorization/);
    assert.equal(result.code, 3);
  } finally {
    if (previous === undefined) delete process.env.JMC_NON_INTERACTIVE;
    else process.env.JMC_NON_INTERACTIVE = previous;
  }
});

test('detect on a directory that does not exist is an invalid usage error', async () => {
  const result = await runCli(['detect', '/nonexistent/project']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /does not exist/);
});

void capture;
void api;
void buildTinyMappings;