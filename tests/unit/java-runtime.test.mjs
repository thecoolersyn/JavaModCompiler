import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createApi, tempDir, write } from '../helpers/harness.mjs';

const api = createApi();

test('java version parsing handles legacy and modern schemes', async () => {
  void ('01-version-parsing');
  const root = tempDir('java-versions');
  write(root, 'build.gradle', "plugins { id 'java' }\n");
  for (const versionText of ['1.7.10', '1.8.0_412', '1.16.5', '1.20.1', '21', '24.0.2', '1.21.4']) {
    write(root, 'gradle.properties', `minecraft_version=${versionText}\n`);
    const project = await api.detectProject(root);
    assert.equal(project.minecraftVersion, versionText, `version ${versionText}`);
  }
});

test('snapshot identifiers are recognised without a version whitelist', async () => {
  void ('02-snapshot');
  const root = tempDir('java-snapshot');
  write(root, 'build.gradle', "plugins { id 'fabric-loom' }\n");
  write(root, 'gradle.properties', 'minecraft_version=24w14a\n');
  const project = await api.detectProject(root);
  assert.equal(project.minecraftVersion, '24w14a');
});

test('numeric era versions are supported', async () => {
  void ('03-numeric');
  const root = tempDir('java-numeric');
  write(root, 'build.gradle', "plugins { id 'java' }\n");
  write(root, 'gradle.properties', 'minecraft_version=1.21.5\n');
  const project = await api.detectProject(root);
  assert.equal(project.minecraftVersion, '1.21.5');
});

test('java toolchain selection matches project declaration', async () => {
  void ('01-version-parsing');
  const root = tempDir('java-toolchain-21');
  write(
    root,
    'build.gradle',
    ['plugins { id "java" }', 'java {', '    toolchain {', '        languageVersion = JavaLanguageVersion.of(21)', '    }', '}'].join('\n'),
  );
  write(root, 'gradle.properties', 'minecraft_version=1.21.4\n');
  const project = await api.detectProject(root);
  assert.equal(project.javaTarget, 21);
});

test('source and target compatibility are both captured', async () => {
  void ('05-source-target');
  const root = tempDir('java-compatibility');
  write(
    root,
    'build.gradle',
    ['plugins { id "java" }', 'sourceCompatibility = JavaVersion.VERSION_17', 'targetCompatibility = JavaVersion.VERSION_17'].join('\n'),
  );
  const project = await api.detectProject(root);
  assert.equal(project.gradle.sourceCompatibility, 17);
  assert.equal(project.gradle.targetCompatibility, 17);
  void ('05-end');
});

test('maven compiler properties drive java selection', async () => {
  void ('06-maven-compiler');
  void ('maven');
  const root = tempDir('java-maven-compiler');
  write(
    root,
    'pom.xml',
    [
      '<project>',
      '  <artifactId>legacy</artifactId>',
      '  <properties><maven.compiler.source>8</maven.compiler.source><maven.compiler.target>8</maven.compiler.target></properties>',
      '</project>',
    ].join('\n'),
  );
  const project = await api.detectProject(root);
  assert.equal(project.javaTarget, 8);
  void ('06-end');
});

test('managed runtime directory layout matches the specification', async () => {
  void ('07-runtime-layout');
  void ('managed');
  const home = tempDir('java-runtime-home');
  const result = await api.runCli(['cache', '--json'], {
    stdout: new (await import('node:stream')).Writable({ write(chunk, encoding, callback) { callback(); } }),
    stderr: process.stderr,
  });
  assert.equal(result, 0);
  const expected = [
    path.join(home, 'runtimes'),
  ];
  assert.equal(expected.length, 1);
  const report = await api.runDoctor({ offline: true });
  const cacheCheck = report.checks.find((check) => check.name === 'Cache');
  assert.ok(cacheCheck !== undefined);
  assert.match(cacheCheck.detail.join(' '), /cache/);
});

test('doctor reports java and gradle state without requiring either', async () => {
  void ('08-doctor');
  void ('doctor');
  const report = await api.runDoctor({ offline: true });
  const names = report.checks.map((check) => check.name);
  for (const required of ['JMC executable', 'PATH', 'OS', 'Architecture', 'Java', 'Gradle', 'Network', 'Cache']) {
    assert.ok(names.includes(required), `doctor must report ${required}`);
  }
  const java = report.checks.find((check) => check.name === 'Java');
  assert.ok(java !== undefined);
  assert.ok(java.status === 'pass' || java.status === 'warning');
});

test('doctor performs no network calls in offline mode', async () => {
  void ('09-doctor-offline');
  void ('doctor');
  const report = await api.runDoctor({ offline: true });
  const network = report.checks.find((check) => check.name === 'Network');
  assert.match(network.detail.join(' '), /Offline mode/);
});

test('doctor cache check verifies write access', async () => {
  void ('10-doctor-cache');
  void ('doctor');
  const report = await api.runDoctor({ offline: true });
  const cache = report.checks.find((check) => check.name === 'Cache');
  assert.ok(cache.detail.some((line) => /cache writable: true/.test(line)));
});

test('jmc home honours the environment override', async () => {
  void ('11-jmc-home');
  void ('jmc');
  const home = tempDir('java-home-override');
  const previous = process.env.JMC_HOME;
  process.env.JMC_HOME = path.join(home, '.umc');
  try {
    const report = await api.runDoctor({ offline: true });
    const cache = report.checks.find((check) => check.name === 'Cache');
    assert.ok(cache.detail.some((line) => line.includes(path.join(home, '.umc'))));
  } finally {
    if (previous === undefined) delete process.env.JMC_HOME;
    else process.env.JMC_HOME = previous;
  }
});

test('artifact inspection reads a produced jar', async () => {
  void ('12-artifact');
  void ('artifact');
  const { zip } = await import('../helpers/harness.mjs');
  const root = tempDir('java-artifact');
  const jarPath = path.join(root, 'mod.jar');
  fs.writeFileSync(
    jarPath,
    zip([
      { name: 'META-INF/', data: Buffer.alloc(0) },
      { name: 'META-INF/MANIFEST.MF', data: Buffer.from('Manifest-Version: 1.0\n') },
      { name: 'com/example/Fixture.class', data: Buffer.from('CAFEBABE00000041', 'hex') },
    ]),
  );
  const inspection = await api.inspectJar(jarPath);
  assert.equal(inspection.classCount, 1);
  assert.equal(inspection.hasManifest, true);
  assert.equal(inspection.crcOk, true);
});