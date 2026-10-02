import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi, tempDir, write } from '../helpers/harness.mjs';

const api = createApi();

function projectOf(files, name) {
  const root = tempDir(name);
  for (const [relative, content] of Object.entries(files)) write(root, relative, content);
  return root;
}

async function pluginsOf(build, extra = {}) {
  const root = projectOf({ 'build.gradle': build, 'settings.gradle': "rootProject.name = 'fixture'\n", ...extra }, `parse-${Math.random().toString(36).slice(2, 10)}`);
  const project = await api.detectProject(root);
  return project.gradle?.plugins ?? [];
}

test('a quoted Groovy plugin id is parsed as the plugin, not as the word version', async () => {
  const plugins = await pluginsOf("plugins { 'fabric-loom' version '1.7.4' }\n");
  assert.deepEqual(plugins.map((entry) => entry.id), ['fabric-loom']);
  assert.equal(plugins[0].version, '1.7.4');
  assert.equal(
    plugins.some((entry) => entry.id === 'version'),
    false,
    'the literal word "version" must never be reported as a plugin id',
  );
});

test('ordinary Groovy syntax is parsed', async () => {
  const plugins = await pluginsOf("plugins { id 'net.minecraftforge.gradle' version '6.0.24' }\n");
  assert.deepEqual(plugins.map((entry) => `${entry.id}@${entry.version}`), ['net.minecraftforge.gradle@6.0.24']);
});

test('ordinary Kotlin DSL syntax is parsed', async () => {
  const root = projectOf(
    {
      'build.gradle.kts': 'plugins { id("net.neoforged.moddev") version "2.0.148" }\n',
      'settings.gradle.kts': 'rootProject.name = "fixture"\n',
    },
    'kts-plugins',
  );
  const project = await api.detectProject(root);
  const plugins = project.gradle?.plugins ?? [];
  assert.deepEqual(plugins.map((entry) => `${entry.id}@${entry.version}`), ['net.neoforged.moddev@2.0.148']);
});

test('an alias declaration does not produce a spurious plugin', async () => {
  const plugins = await pluginsOf('plugins { alias(libs.plugins.fabric.loom) }\n', {
    'gradle/libs.versions.toml': '[versions]\nloom = "1.6.12"\n\n[plugins]\nloom = { id = "fabric-loom", version.ref = "loom" }\n',
  });
  const spurious = plugins.filter((entry) => entry.id.startsWith('libs.'));
  assert.deepEqual(spurious.map((entry) => entry.id), [], 'a catalog reference must never be reported as a plugin id');
});

test('a plugin block containing strings is parsed without dropping declarations', async () => {
  const plugins = await pluginsOf(
    ["plugins {", "    id 'java'", "    id 'fabric-loom' version '1.6.12'", "    id 'org.jetbrains.kotlin.jvm' version '1.9.24'", "}", "", "repositories { maven { url = 'https://example.invalid/repo' } }"].join('\n'),
  );
  const ids = plugins.map((entry) => entry.id);
  for (const expected of ['java', 'fabric-loom', 'org.jetbrains.kotlin.jvm']) {
    assert.ok(ids.includes(expected), `expected ${expected} among ${ids.join(', ')}`);
  }
});

test('a comment at column 0 cannot declare a plugin', async () => {
  const plugins = await pluginsOf("apply plugin: 'net.minecraftforge.gradle'\n# plugins { id 'fabric-loom' version '1.6.12' }\n");
  assert.deepEqual(plugins.map((entry) => entry.id), ['net.minecraftforge.gradle']);
});

test('an indented comment cannot declare a plugin', async () => {
  const plugins = await pluginsOf("apply plugin: 'net.minecraftforge.gradle'\n    # plugins { id 'fabric-loom' version '1.6.12' }\n");
  assert.deepEqual(plugins.map((entry) => entry.id), ['net.minecraftforge.gradle']);
});

test('a trailing comment cannot declare a plugin', async () => {
  const plugins = await pluginsOf("apply plugin: 'net.minecraftforge.gradle'  # id 'fabric-loom' version '1.6.12'\n");
  assert.deepEqual(plugins.map((entry) => entry.id), ['net.minecraftforge.gradle']);
});

test('a shebang line cannot declare a plugin', async () => {
  const plugins = await pluginsOf("#!/usr/bin/env groovy\napply plugin: 'net.minecraftforge.gradle'\n");
  assert.deepEqual(plugins.map((entry) => entry.id), ['net.minecraftforge.gradle']);
});

test('a hash inside a quoted string is preserved', async () => {
  const tokens = await api.lexGradle(["ext.channel = 'stable # 7'", 'ext.note = "also # fine"', ''].join('\n'));
  const values = tokens.filter((token) => token.type === 'string').map((token) => token.value);
  assert.ok(values.includes('stable # 7'), `a hash inside a single-quoted string must be preserved, got ${JSON.stringify(values)}`);
  assert.ok(values.includes('also # fine'), `a hash inside a double-quoted string must be preserved, got ${JSON.stringify(values)}`);
});

test('the lexer removes comments and keeps the real tokens', async () => {
  const tokens = await api.lexGradle(["# a comment", "    # an indented comment", "id 'fabric-loom' # trailing", ''].join('\n'));
  assert.deepEqual(tokens.filter((token) => token.type === 'string').map((token) => token.value), ['fabric-loom']);
  assert.equal(
    tokens.some((token) => token.value === 'comment'),
    false,
    'comment text must never become a token',
  );
});

test('a hash that is not a comment start does not swallow the rest of the line', async () => {
  const tokens = await api.lexGradle("tag = value#tail\n");
  assert.ok(
    tokens.some((token) => token.value === 'value'),
    `the word before an attached hash must survive, got ${JSON.stringify(tokens)}`,
  );
  assert.equal(
    tokens.some((token) => token.value === 'tag = value'),
    false,
    'an attached hash must not turn the line into a comment',
  );
});

test('implementation(project(":core")) is parsed and terminates', async () => {
  const root = projectOf(
    {
      'build.gradle': [
        'plugins { id "java" }',
        '',
        'dependencies {',
        '    implementation(project(":core"))',
        '    implementation("com.example.absent:thing:1.0")',
        '}',
        '',
      ].join('\n'),
      'settings.gradle': "rootProject.name = 'fixture'\ninclude 'core'\n",
    },
    'project-dependency',
  );
  const project = await api.detectProject(root);
  const dependencies = project.gradle?.dependencies?.dependencies ?? [];
  assert.ok(
    dependencies.some((entry) => entry.includes('project(')),
    `a project dependency must be recorded, got ${JSON.stringify(dependencies)}`,
  );
  assert.ok(
    dependencies.some((entry) => entry.includes('com.example.absent:thing')),
    `an ordinary dependency in the same block must also be recorded, got ${JSON.stringify(dependencies)}`,
  );
});

test('a deeply nested project dependency does not hang or exhaust memory', async () => {
  const nested = ['implementation(project(":a"))'];
  for (let index = 0; index < 40; index += 1) nested.push(`implementation(project(":module${index}"))`);
  const root = projectOf(
    {
      'build.gradle': ['plugins { id "java" }', '', 'dependencies {', ...nested, '}', ''].join('\n'),
      'settings.gradle': "rootProject.name = 'fixture'\n",
    },
    'project-dependency-deep',
  );
  const project = await api.detectProject(root);
  const dependencies = project.gradle?.dependencies?.dependencies ?? [];
  assert.equal(dependencies.length, 41, `every declaration must be recorded exactly once, got ${dependencies.length}`);
});

test('a nested files declaration does not hang the parser', async () => {
  const root = projectOf(
    {
      'build.gradle': ['dependencies {', '    implementation(files("libs/one.jar", "libs/two.jar"))', '    testImplementation(fileTree(dir: "libs"))', '}', ''].join('\n'),
      'settings.gradle': "rootProject.name = 'fixture'\n",
    },
    'filetree-dependency',
  );
  const project = await api.detectProject(root);
  const recorded = JSON.stringify(project.gradle?.dependencies ?? {});
  assert.match(recorded, /libs\/one\.jar/, 'the nested file declarations must be recorded rather than dropped');
});
