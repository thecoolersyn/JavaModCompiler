import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi, tempDir, write } from '../helpers/harness.mjs';

const api = createApi();

test('argument parser recognizes the primary shorthand', async () => {
  const result = await api.parseArguments(['mappings-26.2', 'mod.jar']);
  assert.equal(result.parsed.command, 'build');
  assert.deepEqual(result.parsed.positionals, ['mappings-26.2', 'mod.jar']);
  assert.equal(result.shorthand, true);
  assert.equal(result.parsed.project, undefined);
});

test('argument parser accepts ./ and ./build/ prefixed paths', async () => {
  const relative = await api.parseArguments(['./mappings-26.2', './build/mod.jar']);
  assert.equal(relative.shorthand, true);
  const absolute = await api.parseArguments(['/abs/path/mappings-26.2', 'mod.jar']);
  assert.equal(absolute.shorthand, true);
});

test('argument parser applies every documented flag', async () => {
  const result = await api.parseArguments([
    'mappings-26.2',
    'mod.jar',
    '--project',
    './productionmod',
    '--minecraft',
    '1.20.4',
    '--loader',
    'fabric',
    '--java',
    '21',
    '--offline',
    '--debug',
    '--verbose',
    '--json',
    '--keep-workspace',
    '--runtime-test',
    '--no-cache',
    '--clean',
    '--force',
    '--yes',
  ]);
  assert.equal(result.parsed.project, './productionmod');
  assert.equal(result.parsed.minecraft, '1.20.4');
  assert.equal(result.parsed.loader, 'fabric');
  assert.equal(result.parsed.java, 21);
  for (const flag of [
    'offline',
    'debug',
    'verbose',
    'json',
    'keepWorkspace',
    'runtimeTest',
    'noCache',
    'clean',
    'force',
    'yes',
  ]) {
    assert.equal(result.parsed[flag], true, `flag ${flag} should be set`);
  }
  assert.equal(result.parsed.quiet, false);
});

test('argument parser supports inline flag values', async () => {
  const result = await api.parseArguments(['--project=./mod', '--java=17', 'mappings', 'out.jar']);
  assert.equal(result.parsed.project, './mod');
  assert.equal(result.parsed.java, 17);
});

test('argument parser rejects a non numeric java version', async () => {
  const result = await api.parseArguments(['--java', 'twenty', 'out.jar']);
  assert.equal(result.parsed.errors.length, 1);
  assert.match(result.parsed.errors[0], /positive integer/);
});

test('argument parser collects unknown flags instead of guessing', async () => {
  const result = await api.parseArguments(['--nonsense', 'mappings', 'out.jar']);
  assert.deepEqual(result.parsed.unknownFlags, ['--nonsense']);
});

test('help and version requests are recognized in both forms', async () => {
  assert.equal((await api.parseArguments(['--help'])).parsed.command, 'help');
  assert.equal((await api.parseArguments(['-h'])).parsed.command, 'help');
  assert.equal((await api.parseArguments(['--version'])).parsed.command, 'version');
  assert.equal((await api.parseArguments(['help'])).parsed.command, 'help');
});

test('known subcommands are not treated as mappings paths', async () => {
  for (const command of ['doctor', 'detect', 'mappings', 'dependencies', 'build', 'plugins', 'cache']) {
    const result = await api.parseArguments([command]);
    assert.equal(result.parsed.command, command);
  }
});

test('detect parses a multi era Fabric project', async () => {
  const root = tempDir('detect-fabric');
  write(
    root,
    'build.gradle',
    [
      "plugins {",
      "    id 'fabric-loom' version '1.6-SNAPSHOT'",
      "}",
      '',
      "dependencies {",
      '    minecraft "com.mojang:minecraft:${project.minecraft_version}"',
      '    mappings "net.fabricmc:yarn:${project.minecraft_version}:v2"',
      '    modImplementation "net.fabricmc:fabric-loader:${project.loader_version}"',
      '}',
    ].join('\n'),
  );
  write(root, 'gradle.properties', 'minecraft_version=1.20.1\nloader_version=0.15.11\n');
  write(root, 'settings.gradle', "rootProject.name = 'fixture'\n");
  write(root, 'src/main/java/com/example/Main.java', 'package com.example;\npublic class Main {}\n');
  write(root, 'src/main/resources/fabric.mod.json', JSON.stringify({ schemaVersion: 1, id: 'fixture', version: '1.0.0' }));

  const project = await api.detectProject(root);
  assert.equal(project.buildSystem, 'gradle');
  assert.equal(project.buildTool, 'Gradle');
  assert.equal(project.languages, 'java');
  assert.equal(project.minecraftVersion, '1.20.1');
  assert.equal(project.loader.kind, 'fabric');
  assert.ok(project.gradleWrapperVersion === undefined);
  assert.ok(project.gradle.plugins.some((plugin) => plugin.id === 'fabric-loom'));
  assert.equal(project.modMetadata.length, 1);
  assert.equal(project.modMetadata[0].modId, 'fixture');
  assert.equal(project.detectedIssues.length, 0);
});

test('detect resolves interpolated dependency coordinates', async () => {
  const root = tempDir('detect-interpolation');
  write(
    root,
    'build.gradle',
    [
      "plugins {",
      "    id 'java'",
      '}',
      'dependencies {',
      "    implementation 'com.google.code.gson:gson:2.10.1'",
      '    implementation "org.apache.commons:commons-lang3:${commons_version}"',
      '}',
    ].join('\n'),
  );
  write(root, 'gradle.properties', 'commons_version=3.14.0\nminecraft_version=1.16.5\n');
  const project = await api.detectProject(root);
  assert.deepEqual(project.gradle.dependencies.dependencies, [
    'com.google.code.gson:gson:2.10.1',
    'org.apache.commons:commons-lang3:3.14.0',
  ]);
});

test('detect finds kotlin alongside java', async () => {
  const root = tempDir('detect-kotlin');
  write(root, 'build.gradle', "plugins {\n    id 'java'\n    id 'org.jetbrains.kotlin.jvm' version '1.9.22'\n}\n");
  write(root, 'src/main/java/com/example/A.java', 'package com.example;\nclass A {}\n');
  write(root, 'src/main/kotlin/com/example/B.kt', 'package com.example\nclass B\n');
  const project = await api.detectProject(root);
  assert.equal(project.languages, 'java+kotlin');
  assert.equal(project.sourceSets.length, 2);
});

test('detect understands maven projects', async () => {
  const root = tempDir('detect-maven');
  write(
    root,
    'pom.xml',
    [
      '<project>',
      '  <groupId>com.example</groupId>',
      '  <artifactId>legacy</artifactId>',
      '  <version>1.2.3</version>',
      '  <properties><minecraft.version>1.12.2</minecraft.version></properties>',
      '  <dependencies>',
      '    <dependency><groupId>org.ow2.asm</groupId><artifactId>asm</artifactId><version>9.6</version></dependency>',
      '  </dependencies>',
      '  <repositories><repository><id>custom</id><url>https://example.invalid/repo</url></repository></repositories>',
      '</project>',
    ].join('\n'),
  );
  write(root, 'src/main/java/com/example/Legacy.java', 'package com.example;\nclass Legacy {}\n');
  const project = await api.detectProject(root);
  assert.equal(project.buildSystem, 'maven');
  assert.equal(project.buildTool, 'Maven');
  assert.equal(project.minecraftVersion, '1.12.2');
  assert.equal(project.maven.dependencies[0].artifactId, 'asm');
  assert.equal(project.maven.repositories[0].url, 'https://example.invalid/repo');
});

test('detect surfaces issues rather than inventing configuration', async () => {
  const root = tempDir('detect-empty');
  write(root, 'README.txt', 'nothing buildable here\n');
  const project = await api.detectProject(root);
  assert.equal(project.buildSystem, 'unknown');
  assert.equal(project.minecraftVersion, undefined);
  assert.ok(project.detectedIssues.length >= 2);
});

test('detect records annotation processors declared through the build', async () => {
  const root = tempDir('detect-processors');
  write(
    root,
    'build.gradle',
    ["plugins {", "    id 'java'", '}', 'dependencies {', "    annotationProcessor 'com.google.auto.value:auto-value:1.10.1'", '}', "java {", "    toolchain {", '        languageVersion = JavaLanguageVersion.of(21)', '    }', '}'].join('\n'),
  );
  write(root, 'src/main/java/com/example/P.java', 'package com.example;\nclass P {}\n');
  const project = await api.detectProject(root);
  assert.equal(project.javaTarget, 21);
  assert.ok(project.annotationProcessors.declaredInBuild.some((entry) => entry.includes('auto-value')));
});

test('detect picks the strongest version evidence', async () => {
  const root = tempDir('detect-version-evidence');
  write(root, 'build.gradle', "plugins { id 'fabric-loom' }\n");
  write(root, 'gradle.properties', 'minecraft_version=1.21.4\nloader_version=0.16.5\n');
  const project = await api.detectProject(root);
  assert.equal(project.minecraftVersion, '1.21.4');
  assert.match(project.minecraftVersionSource, /minecraft_version/);
  assert.ok(project.minecraftVersionEvidence.length >= 1);
});

test('detect recognises wrapper versions', async () => {
  const root = tempDir('detect-wrapper');
  write(root, 'build.gradle', "plugins { id 'java' }\n");
  write(
    root,
    'gradle/wrapper/gradle-wrapper.properties',
    'distributionBase=GRADLE_USER_HOME\ndistributionUrl=https\\://services.gradle.org/distributions/gradle-8.7-bin.zip\n',
  );
  write(root, 'src/main/java/A.java', 'class A {}\n');
  const project = await api.detectProject(root);
  assert.equal(project.gradleWrapperVersion, '8.7');
  assert.equal(project.hasWrapper, false);
});

test('detect finds local jars outside build output', async () => {
  const root = tempDir('detect-local-jars');
  write(root, 'build.gradle', "plugins { id 'java' }\n");
  write(root, 'libs/helper.jar', 'PK not a real jar but a jar named file');
  write(root, 'src/main/java/A.java', 'class A {}\n');
  const project = await api.detectProject(root);
  assert.ok(project.localJars.some((jar) => jar.includes('helper.jar')));
});