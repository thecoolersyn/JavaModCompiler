import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createApi, tempDir, write } from '../helpers/harness.mjs';

const api = createApi();

function jarWith(root, name, body) {
  const target = path.join(root, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, body);
  return target;
}

test('real Loom production and development filenames are classified correctly', async () => {
  const cases = [
    { name: 'mymod-1.0.0.jar', publishable: true, development: false, documentation: false },
    { name: 'mymod-1.0.0-dev.jar', publishable: false, development: true, documentation: false },
    { name: 'mymod-1.0.0-sources.jar', publishable: false, development: false, documentation: true },
    { name: 'mymod-1.0.0-javadoc.jar', publishable: false, development: false, documentation: true },
    { name: 'mymod-1.0.0-dev-sources.jar', publishable: false, development: true, documentation: true },
    { name: 'mymod-1.0.0-unmapped.jar', publishable: false, development: true, documentation: false },
    { name: 'mymod-1.0.0-shaded.jar', publishable: true, development: false, documentation: false },
  ];
  for (const entry of cases) {
    const result = await api.classifyArtifact(entry.name);
    assert.equal(result.publishable, entry.publishable, `${entry.name} publishable`);
    assert.equal(result.development, entry.development, `${entry.name} development`);
    assert.equal(result.documentation, entry.documentation, `${entry.name} documentation`);
  }
});

test('a real Loom layout is accepted: production jar beside a dev jar', async () => {
  const root = tempDir('packaging-loom-accepted');
  const production = jarWith(root, 'mymod-1.0.0.jar', 'production-mapped-classes');
  const development = jarWith(root, 'mymod-1.0.0-dev.jar', 'development-classes');
  const result = await api.assertRemappedArtifact(production, [production, development], { remapTask: 'remapJar' });
  assert.equal(result, undefined, 'a genuine Loom production artifact must not be rejected for lacking a suffix');
});

test('a real ForgeGradle layout is accepted: unsuffixed production jar beside a dev jar', async () => {
  const root = tempDir('packaging-forge-accepted');
  const production = jarWith(root, 'mymod-1.0.0.jar', 'reobfuscated-classes');
  const development = jarWith(root, 'mymod-1.0.0-dev.jar', 'deobfuscated-classes');
  const result = await api.assertRemappedArtifact(production, [production, development], { remapTask: 'reobfJar' });
  assert.equal(result, undefined);
});

test('a production jar is accepted even without any development sibling', async () => {
  const root = tempDir('packaging-no-sibling');
  const production = jarWith(root, 'mymod-1.0.0.jar', 'production-classes');
  const result = await api.assertRemappedArtifact(production, [production], { remapTask: 'remapJar' });
  assert.equal(result, undefined);
});

test('a production jar identical to the development jar is rejected as unremapped', async () => {
  const root = tempDir('packaging-identical');
  const production = jarWith(root, 'mymod-1.0.0.jar', 'identical-contents');
  const development = jarWith(root, 'mymod-1.0.0-dev.jar', 'identical-contents');
  const result = await api.assertRemappedArtifact(production, [production, development], { remapTask: 'remapJar' });
  assert.notEqual(result, undefined);
  assert.equal(result.id, 'remapped-artifact-expected');
  assert.match(result.cause, /remap task \(remapJar\)/);
});

test('selecting a development jar is rejected', async () => {
  const root = tempDir('packaging-dev-selected');
  const production = jarWith(root, 'mymod-1.0.0.jar', 'production-classes');
  const development = jarWith(root, 'mymod-1.0.0-dev.jar', 'development-classes');
  const result = await api.assertRemappedArtifact(development, [production, development], { remapTask: 'remapJar' });
  assert.equal(result.id, 'unmapped-artifact-selected');
});

test('selecting a sources or javadoc jar is rejected', async () => {
  const root = tempDir('packaging-doc-selected');
  const production = jarWith(root, 'mymod-1.0.0.jar', 'production-classes');
  const sources = jarWith(root, 'mymod-1.0.0-sources.jar', 'source-code');
  const selected = await api.assertRemappedArtifact(sources, [production, sources], { remapTask: 'remapJar' });
  assert.equal(selected.id, 'documentation-artifact-selected');
  const javadoc = jarWith(root, 'mymod-1.0.0-javadoc.jar', 'javadoc');
  const selectedJavadoc = await api.assertRemappedArtifact(javadoc, [production, javadoc], { remapTask: 'remapJar' });
  assert.equal(selectedJavadoc.id, 'documentation-artifact-selected');
});

test('a dev jar with different contents is never mistaken for the production artifact', async () => {
  const root = tempDir('packaging-dev-different-size');
  const production = jarWith(root, 'mymod-1.0.0.jar', 'a');
  const development = jarWith(root, 'mymod-1.0.0-dev.jar', 'a-much-longer-development-body');
  const result = await api.assertRemappedArtifact(production, [production, development], { remapTask: 'remapJar' });
  assert.equal(result, undefined);
});

test('a build whose only useful output is a development artifact is diagnosed', async () => {
  const root = tempDir('packaging-only-dev');
  write(root, 'build.gradle', "plugins { id 'java' }\n");
  write(root, 'settings.gradle', "rootProject.name = 'onlydev'\n");
  write(root, 'src/main/java/com/example/OnlyDev.java', 'package com.example;\npublic class OnlyDev {}\n');
  const libs = path.join(root, 'build', 'libs');
  jarWith(libs, 'onlydev-1.0.0-dev.jar', 'dev-only-body');
  const candidates = ['onlydev-1.0.0-dev.jar', 'onlydev-1.0.0-sources.jar', 'onlydev-1.0.0-dev-sources.jar'];
  const publishable = [];
  for (const name of candidates) {
    const classification = await api.classifyArtifact(name);
    if (classification.publishable) publishable.push(name);
  }
  assert.deepEqual(publishable, [], 'sources and dev jars must both be excluded so only-dev-artifact-produced stays reachable');
  const development = [];
  for (const name of candidates) {
    const classification = await api.classifyArtifact(name);
    if (classification.development) development.push(name);
  }
  assert.deepEqual(development, ['onlydev-1.0.0-dev.jar', 'onlydev-1.0.0-dev-sources.jar']);
});
