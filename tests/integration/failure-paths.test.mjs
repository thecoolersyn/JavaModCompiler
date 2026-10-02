import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir, write, runCli } from '../helpers/harness.mjs';

const JAVA_HOME = path.join(tempDir('failure-home'), '.umc');

const EXIT_SUCCESS = 0;
const EXIT_GENERAL_FAILURE = 1;
const EXIT_AUTHORIZATION_REQUIRED = 3;
const EXIT_OFFLINE_MISSING_ARTIFACTS = 6;

function gradleProject(name, extra = {}) {
  const project = tempDir(name);
  write(project, 'build.gradle', "plugins { id 'java' }\n");
  write(project, 'settings.gradle', `rootProject.name = '${name}'\n`);
  write(project, 'gradle.properties', 'minecraft_version=1.20.1\n');
  write(project, 'src/main/java/com/example/Simple.java', 'package com.example;\npublic class Simple {}\n');
  for (const [relative, content] of Object.entries(extra)) write(project, relative, content);
  return project;
}

async function runJson(args) {
  return runCli(args, { env: { JMC_HOME: JAVA_HOME }, stdin: { isTTY: false } });
}

function assertFailedWith(result, { stage, diagnosticId, exitCode }) {
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.status, 'failed', `expected a failed build: ${result.stdout.slice(0, 400)}`);
  assert.equal(summary.failedStage, stage, `expected the failure at ${stage}, got ${summary.failedStage}`);
  assert.equal(result.code, exitCode, `expected exit code ${exitCode}, got ${result.code}: ${result.stderr.slice(0, 300)}`);
  const diagnostic = summary.diagnostics.find((entry) => entry.id === diagnosticId);
  assert.ok(diagnostic !== undefined, `expected diagnostic ${diagnosticId}, got ${summary.diagnostics.map((entry) => entry.id).join(', ')}`);
  assert.equal(diagnostic.severity, 'error');
  assert.equal(diagnostic.stage, stage);
  assert.ok(diagnostic.suggestions.length > 0, 'a failure must carry actionable suggestions');
  assert.notEqual(diagnostic.title, 'Unexpected Error', 'failures must not be reported as a generic error');
  return { summary, diagnostic };
}

test('denied build script authorization fails at DISCOVER with exit code 3', async () => {
  const project = gradleProject('denied');
  const result = await runJson([project, '--out', 'denied.jar', '--offline', '--json']);
  const { diagnostic } = assertFailedWith(result, {
    stage: 'DISCOVER',
    diagnosticId: 'authorization-denied',
    exitCode: EXIT_AUTHORIZATION_REQUIRED,
  });
  assert.match(diagnostic.cause, /build scripts would run/);
  assert.ok(
    diagnostic.evidence.some((entry) => entry.includes('build.gradle')),
    `the diagnostic must name the scripts that would run: ${JSON.stringify(diagnostic.evidence)}`,
  );
  assert.equal(fs.existsSync(path.join(project, 'denied.jar')), false);
});

test('a missing dependency fails at RESOLVE with exit code 6 in offline mode', async () => {
  const project = gradleProject('missing-dependency', {
    'build.gradle': [
      "plugins { id 'java' }",
      '',
      'repositories {',
      "    maven { url = 'https://example.invalid/repository' }",
      '}',
      '',
      'dependencies {',
      "    implementation 'com.example.absent:definitely-not-published:9.9.9'",
      '}',
      '',
    ].join('\n'),
  });
  const result = await runJson([project, '--out', 'missing.jar', '--yes', '--offline', '--json']);
  const { diagnostic } = assertFailedWith(result, {
    stage: 'RESOLVE',
    diagnosticId: 'dependency-resolution',
    exitCode: EXIT_OFFLINE_MISSING_ARTIFACTS,
  });
  assert.match(diagnostic.detected.join(' '), /com\.example\.absent:definitely-not-published/);
});

test('a mappings path that does not exist fails with a specific diagnostic', async () => {
  const project = gradleProject('mappings-missing');
  const mappings = path.join(tempDir('mappings-missing-dir'), 'absent.tiny');
  const result = await runJson([mappings, 'absent.jar', '--project', project, '--yes', '--java', '21', '--json']);
  const { diagnostic } = assertFailedWith(result, {
    stage: 'DISCOVER',
    diagnosticId: 'mappings-path-missing',
    exitCode: EXIT_GENERAL_FAILURE,
  });
  assert.match(diagnostic.summary, /does not exist/);
  assert.ok(diagnostic.suggestions.some((entry) => /mappings/i.test(entry)));
});

test('a mappings file JMC cannot read fails with a specific diagnostic', async () => {
  const project = gradleProject('mappings-garbage');
  const mappings = tempDir('mappings-garbage-file');
  write(mappings, 'broken.tiny', 'this is not a mapping document\n');
  const result = await runJson([path.join(mappings, 'broken.tiny'), 'garbage.jar', '--project', project, '--yes', '--java', '21', '--json']);
  const { diagnostic } = assertFailedWith(result, {
    stage: 'DISCOVER',
    diagnosticId: 'mappings-format-unknown',
    exitCode: EXIT_GENERAL_FAILURE,
  });
  assert.match(diagnostic.summary, /mapping provider/i);
  assert.ok(diagnostic.suggestions.length > 0);
});

test('an unavailable JDK fails at PREPARE with a JDK specific diagnostic', async () => {
  const project = gradleProject('jdk-unavailable');
  const result = await runJson([project, '--out', 'jdk.jar', '--yes', '--java', '99', '--json']);
  const { diagnostic } = assertFailedWith(result, {
    stage: 'PREPARE',
    diagnosticId: 'java-unavailable',
    exitCode: EXIT_GENERAL_FAILURE,
  });
  assert.match(diagnostic.expected, /^Java 99/);
  assert.match(diagnostic.title, /JDK/);
});

test('an unavailable JDK is also reported without --java when a rule demands one', async () => {
  const project = gradleProject('jdk-rule', {
    'build.gradle': "plugins { id 'java' }\njava { toolchain { languageVersion = JavaLanguageVersion.of(99) } }\n",
  });
  const result = await runJson([project, '--out', 'jdkrule.jar', '--yes', '--json']);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.status, 'failed');
  assert.equal(summary.failedStage, 'PREPARE');
  const diagnostic = summary.diagnostics.find((entry) => entry.id === 'java-unavailable');
  assert.ok(diagnostic !== undefined, `expected java-unavailable, got ${summary.diagnostics.map((entry) => entry.id).join(', ')}`);
  assert.equal(result.code, EXIT_GENERAL_FAILURE);
});

test('a Gradle distribution checksum mismatch fails at PREPARE with a verification diagnostic', { timeout: 600_000 }, async (t) => {
  const version = '8.10.2';
  const project = gradleProject('checksum');
  write(
    project,
    'gradle/wrapper/gradle-wrapper.properties',
    `distributionUrl=https\\://services.gradle.org/distributions/gradle-${version}-bin.zip\ndistributionSha256Sum=${'a'.repeat(64)}\n`,
  );
  const reachable = await networkAvailable(`https://services.gradle.org/distributions/gradle-${version}-bin.zip.sha256`);
  if (reachable !== true) {
    t.skip(`the Gradle distribution host is unreachable, so the published-checksum comparison cannot be exercised: ${reachable}`);
    return;
  }
  const result = await runJson([project, '--out', 'checksum.jar', '--yes', '--json']);
  const { diagnostic } = assertFailedWith(result, {
    stage: 'PREPARE',
    diagnosticId: 'gradle-checksum-mismatch',
    exitCode: EXIT_GENERAL_FAILURE,
  });
  assert.match(diagnostic.detected.join(' '), /gradle-8\.10\.2-bin\.zip/);
});

test('an offline build with a corrupt cached Gradle archive fails closed', async () => {
  const home = path.join(tempDir('corrupt-cache-home'), '.umc');
  const cache = path.join(home, 'cache', 'gradle');
  fs.mkdirSync(cache, { recursive: true });
  const version = '8.10.2';
  const archive = path.join(cache, `gradle-${version}-bin.zip`);
  fs.writeFileSync(archive, 'corrupt');
  fs.writeFileSync(`${archive}.sha256`, `${'0'.repeat(64)}\n`);

  const project = gradleProject('corrupt-cache');
  write(
    project,
    'gradle/wrapper/gradle-wrapper.properties',
    `distributionUrl=https\\://services.gradle.org/distributions/gradle-${version}-bin.zip\n`,
  );
  const result = await runCli([project, '--out', 'corrupt.jar', '--yes', '--offline', '--json'], {
    env: { JMC_HOME: home },
    stdin: { isTTY: false },
  });
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.status, 'failed');
  assert.equal(summary.failedStage, 'PREPARE');
  assert.equal(result.code, EXIT_OFFLINE_MISSING_ARTIFACTS);
  assert.equal(fs.existsSync(archive), false, 'a corrupt cached archive must be discarded');
  const { diagnostic } = assertFailedWith(result, {
    stage: 'PREPARE',
    diagnosticId: 'gradle-offline-missing',
    exitCode: EXIT_OFFLINE_MISSING_ARTIFACTS,
  });
  assert.match(diagnostic.cause, /offline/i);
  assert.ok(diagnostic.suggestions.some((entry) => /--offline/.test(entry)));
});

test('a successful build still exits 0 so the failure codes stay meaningful', { timeout: 1_800_000 }, async (t) => {
  const project = gradleProject('success');
  const reachable = await networkAvailable('https://services.gradle.org/distributions/gradle-8.10.2-bin.zip.sha256');
  if (reachable !== true) {
    t.skip(`the Gradle distribution host is unreachable, so a real build cannot be run: ${reachable}`);
    return;
  }
  const result = await runJson([project, '--java', '21', '--out', 'success.jar', '--yes', '--json']);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.status, 'pass', result.stdout.slice(0, 400));
  assert.equal(result.code, EXIT_SUCCESS);
  assert.equal(fs.existsSync(path.join(project, 'success.jar')), true);
});

test('a build that produces only a development jar fails with a remapping diagnostic', { timeout: 1_800_000 }, async (t) => {
  const reachable = await networkAvailable('https://services.gradle.org/distributions/gradle-8.10.2-bin.zip.sha256');
  if (reachable !== true) {
    t.skip(`the Gradle distribution host is unreachable, so the delegated build cannot be run: ${reachable}`);
    return;
  }
  const project = tempDir('dev-only');
  write(
    project,
    'build.gradle',
    [
      "plugins { id 'java' }",
      '',
      "version = '1.0.0'",
      '',
      "tasks.named('jar') {",
      "    archiveFileName = 'devonly-dev.jar'",
      '}',
      "tasks.register('remapJar') { dependsOn 'jar' }",
      '',
    ].join('\n'),
  );
  write(project, 'settings.gradle', "rootProject.name = 'devonly'\n");
  write(project, 'gradle.properties', 'minecraft_version=1.20.1\n');
  write(project, 'src/main/java/com/example/DevOnly.java', 'package com.example;\npublic class DevOnly {}\n');

  const result = await runJson([project, '--java', '21', '--out', 'devonly.jar', '--yes', '--json']);
  const { diagnostic } = assertFailedWith(result, {
    stage: 'PACKAGE',
    diagnosticId: 'only-dev-artifact-produced',
    exitCode: EXIT_GENERAL_FAILURE,
  });
  assert.match(diagnostic.cause, /remap task/i);
  assert.ok(diagnostic.suggestions.some((entry) => /remap/i.test(entry)));
});

test('a remapping build that ships an unmapped artifact fails validation', { timeout: 1_800_000 }, async (t) => {
  const reachable = await networkAvailable('https://services.gradle.org/distributions/gradle-8.10.2-bin.zip.sha256');
  if (reachable !== true) {
    t.skip(`the Gradle distribution host is unreachable, so the delegated build cannot be run: ${reachable}`);
    return;
  }
  const project = tempDir('unmapped-selected');
  write(
    project,
    'build.gradle',
    [
      "plugins { id 'java' }",
      '',
      "version = '1.0.0'",
      '',
      "tasks.named('jar') {",
      "    archiveFileName = 'unmapped-dev.jar'",
      '}',
      "tasks.register('remapJar', Jar) {",
      "    archiveFileName = 'unmapped-plain.jar'",
      '    from sourceSets.main.output',
      "    dependsOn 'jar'",
      '}',
      '',
    ].join('\n'),
  );
  write(project, 'settings.gradle', "rootProject.name = 'unmapped'\n");
  write(project, 'gradle.properties', 'minecraft_version=1.20.1\n');
  write(project, 'src/main/java/com/example/Unmapped.java', 'package com.example;\npublic class Unmapped {}\n');


  const result = await runJson([project, '--java', '21', '--out', 'unmapped.jar', '--yes', '--json']);
  const { diagnostic } = assertFailedWith(result, {
    stage: 'PACKAGE',
    diagnosticId: 'remapped-artifact-expected',
    exitCode: EXIT_GENERAL_FAILURE,
  });
  assert.match(diagnostic.cause, /remap task \(remapJar\)/);
  assert.ok(diagnostic.evidence.some((entry) => entry.includes('unmapped-dev.jar')));
});

test('a remapping build that ships a remapped artifact is accepted', { timeout: 1_800_000 }, async (t) => {
  const reachable = await networkAvailable('https://services.gradle.org/distributions/gradle-8.10.2-bin.zip.sha256');
  if (reachable !== true) {
    t.skip(`the Gradle distribution host is unreachable, so the delegated build cannot be run: ${reachable}`);
    return;
  }
  const project = tempDir('remapped-selected');
  write(
    project,
    'build.gradle',
    [
      "plugins { id 'java' }",
      '',
      "version = '1.0.0'",
      '',
      "tasks.named('jar') {",
      "    archiveFileName = 'remapped-dev.jar'",
      '}',
      "tasks.register('remapJar', Jar) {",
      "    archiveFileName = 'remapped-remapped.jar'",
      '    from sourceSets.main.output',
      "    dependsOn 'jar'",
      '}',
      '',
    ].join('\n'),
  );
  write(project, 'settings.gradle', "rootProject.name = 'remapped'\n");
  write(project, 'gradle.properties', 'minecraft_version=1.20.1\n');
  write(project, 'src/main/java/com/example/Remapped.java', 'package com.example;\npublic class Remapped {}\n');

  write(project, 'src/main/resources/META-INF/MANIFEST.MF', 'Manifest-Version: 1.0\n');

  const result = await runJson([project, '--java', '21', '--out', 'remapped.jar', '--yes', '--json']);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.status, 'pass', JSON.stringify(summary.diagnostics.slice(0, 2)));
  assert.equal(result.code, EXIT_SUCCESS);
  assert.equal(fs.existsSync(path.join(project, 'remapped.jar')), true);
});

async function networkAvailable(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    return response.status < 500;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
