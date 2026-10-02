import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi, tempDir, write } from '../helpers/harness.mjs';

const api = createApi();

function modelOf(files) {
  const root = tempDir(`gradle-selection-${Math.random().toString(36).slice(2, 10)}`);
  for (const [relative, content] of Object.entries(files)) write(root, relative, content);
  return root;
}

async function selectionFor(files) {
  const root = modelOf(files);
  const project = await api.detectProject(root);
  return { root, project, selection: await api.selectGradleVersion(project.gradle) };
}

test('ForgeGradle 2.3 for 1.12.2 selects a Gradle 4 line and Java 8', async () => {
  const { selection } = await selectionFor({
    'settings.gradle': "rootProject.name = 'legacy'\n",
    'gradle.properties': 'minecraft_version=1.12.2\n',
    'build.gradle': [
      'buildscript {',
      "    repositories { maven { url = 'https://maven.minecraftforge.net' } }",
      "    dependencies { classpath 'net.minecraftforge.gradle:ForgeGradle:2.3-SNAPSHOT' }",
      '}',
      '',
      "apply plugin: 'net.minecraftforge.gradle'",
      '',
      'sourceCompatibility = 1.8',
      "targetCompatibility = 1.8",
      '',
      "dependencies { compile 'net.minecraftforge:forge:1.12.2-14.23.5.2859' }",
    ].join('\n'),
  });
  assert.equal(selection.conflict, undefined);
  assert.match(selection.version, /^4\./, `expected a Gradle 4 line, got ${selection.version}`);
  assert.equal(selection.javaMajor, 8);
  assert.equal(await api.javaRequiredForProject(undefined) > 0, true);
});

test('ForgeGradle 2.3 declared through the plugins DSL also selects Gradle 4 and Java 8', async () => {
  const { selection } = await selectionFor({
    'settings.gradle': "rootProject.name = 'legacy'\n",
    'gradle.properties': 'minecraft_version=1.12.2\n',
    'build.gradle': "plugins { id 'net.minecraftforge.gradle' version '2.3' }\n",
  });
  assert.match(selection.version, /^4\./);
  assert.equal(selection.javaMajor, 8);
});

test('ForgeGradle rule boundaries are split by plugin major version', async () => {
  const cases = [
    { version: '2.3', gradle: /^4\./, java: 8 },
    { version: '3.0.197', gradle: /^[45]\./, java: 8 },
    { version: '4.1.16', gradle: /^[67]\./, java: 8 },
    { version: '5.1.51', gradle: /^7\./, java: 17 },
    { version: '6.0.24', gradle: /^8\./, java: 17 },
    { version: '7.0.31', gradle: /^[89]\./, java: 21 },
  ];
  for (const entry of cases) {
    const { selection } = await selectionFor({
      'settings.gradle': "rootProject.name = 'forge'\n",
      'build.gradle': `plugins { id 'net.minecraftforge.gradle' version '${entry.version}' }\n`,
    });
    assert.equal(selection.conflict, undefined, `${entry.version} must not conflict`);
    assert.match(selection.version, entry.gradle, `ForgeGradle ${entry.version} selected ${selection.version}`);
    assert.equal(selection.javaMajor, entry.java, `ForgeGradle ${entry.version} java requirement`);
  }
});

test('NeoForge ModDevGradle rules are split by plugin major version', async () => {
  const one = await selectionFor({
    'settings.gradle.kts': 'rootProject.name = "neo"\n',
    'build.gradle.kts': 'plugins { id("net.neoforged.moddev") version "1.0.106" }\n',
  });
  assert.equal(one.selection.conflict, undefined);
  assert.match(one.selection.version, /^[78]\./);
  assert.equal(one.selection.javaMajor, 17);

  const two = await selectionFor({
    'settings.gradle.kts': 'rootProject.name = "neo"\n',
    'build.gradle.kts': 'plugins { id("net.neoforged.moddev") version "2.0.28" }\n',
  });
  assert.match(two.selection.version, /^[89]\./);
  assert.equal(two.selection.javaMajor, 21);
});

test('the broad neoforge pattern no longer matches unrelated plugin ids', async () => {
  const { selection } = await selectionFor({
    'settings.gradle': "rootProject.name = 'unrelated'\n",
    'build.gradle': "plugins { id 'com.example.neoforgehelper' version '3.1.4' }\n",
  });
  assert.deepEqual(selection.rules, [], 'an unrelated plugin id must not select a NeoForge rule');
});

test('an unresolvable ModDevGradle version falls back to the conservative rule', async () => {
  const { selection } = await selectionFor({
    'settings.gradle': "rootProject.name = 'neo'\n",
    'build.gradle': "plugins { id 'net.neoforged.moddev' }\n",
  });
  assert.equal(selection.conflict, undefined);
  assert.match(selection.version, /^[78]\./, `expected the conservative 1.x range, got ${selection.version}`);
  assert.match(selection.reason, /conservative/);
  assert.match(selection.reason, /unresolved/);
});

test('a version catalog plugin version is resolved before matching', async () => {
  const { selection } = await selectionFor({
    'settings.gradle': "rootProject.name = 'neo'\n",
    'gradle/libs.versions.toml': ['[versions]', 'moddev = "2.0.28"', '', '[plugins]', 'moddev = { id = "net.neoforged.moddev", version.ref = "moddev" }', ''].join('\n'),
    'build.gradle.kts': 'plugins { alias(libs.plugins.moddev) }\n',
  });
  assert.equal(selection.conflict, undefined);
  assert.match(selection.version, /^[89]\./, `expected the 2.x rule, got ${selection.version}`);
  assert.equal(selection.rules[0].version, '2.0.28');
});

test('a gradle.properties plugin version reference is resolved before matching', async () => {
  const { selection } = await selectionFor({
    'settings.gradle': "rootProject.name = 'neo'\n",
    'gradle.properties': ['moddev_version=2.0.28', 'minecraft_version=21.1.72'].join('\n') + '\n',
    'build.gradle.kts': 'plugins { id("net.neoforged.moddev") version "${moddev_version}" }\n',
  });
  assert.match(selection.version, /^[89]\./);
  assert.equal(selection.rules[0].version, '2.0.28');
});

test('an empty rule intersection is reported with the conflicting plugins', async () => {
  const { selection } = await selectionFor({
    'settings.gradle': "rootProject.name = 'conflict'\n",
    'build.gradle': ["plugins {", "    id 'net.minecraftforge.gradle' version '2.3'", "    id 'net.neoforged.moddev' version '2.0.28'", '}'].join('\n'),
  });
  assert.notEqual(selection.conflict, undefined, 'an empty intersection must be reported');
  assert.equal(selection.conflict.plugins.length, 2);
  assert.match(selection.conflict.plugins.join(' '), /net\.minecraftforge\.gradle:2\.3/);
  assert.match(selection.conflict.plugins.join(' '), /net\.neoforged\.moddev:2\.0\.28/);
  assert.match(selection.conflict.detail, /empty/);
  assert.match(selection.reason, /No Gradle version satisfies/);
});

test('a project wrapper version always wins over the plugin rules', async () => {
  const { selection } = await selectionFor({
    'settings.gradle': "rootProject.name = 'legacy'\n",
    'gradle/wrapper/gradle-wrapper.properties': 'distributionUrl=https\\://services.gradle.org/distributions/gradle-4.10.3-all.zip\n',
    'build.gradle': "plugins { id 'net.minecraftforge.gradle' version '6.0.24' }\n",
  });
  assert.equal(selection.version, '4.10.3');
  assert.match(selection.reason, /wrapper/);
  assert.equal(selection.javaMajor, 8, 'Gradle 4 must be paired with Java 8');
});

test('Loom and Kotlin rules keep Gradle 7 or 8', async () => {
  const loom = await selectionFor({
    'settings.gradle': "rootProject.name = 'fabric'\n",
    'build.gradle': "plugins { id 'fabric-loom' version '1.6.12' }\n",
  });
  assert.match(loom.selection.version, /^[78]\./);
  assert.equal(loom.selection.javaMajor, 17);

  const kotlin = await selectionFor({
    'settings.gradle': "rootProject.name = 'kotlin'\n",
    'build.gradle': "plugins { id 'org.jetbrains.kotlin.jvm' version '1.9.24' }\n",
  });
  assert.match(kotlin.selection.version, /^[78]\./);
});

test('an empty project still selects the current Gradle line', async () => {
  const selection = await api.selectGradleVersion(undefined);
  assert.match(selection.version, /^8\./);
  assert.equal(selection.conflict, undefined);
});

test('javaRequiredForGradleVersion can return 8 for legacy Gradle lines', async () => {
  assert.equal(await api.javaRequiredForGradleVersion('4.10.3'), 8);
  assert.equal(await api.javaRequiredForGradleVersion('8.10.2'), 17);
  assert.equal(await api.javaRequiredForGradleVersion('9.0.0'), 21);
});
