import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createApi, repoRoot, runCli } from '../helpers/harness.mjs';

const api = createApi();
const fixturesRoot = path.join(repoRoot, 'fixtures');

const PROJECT_FIXTURES = [
  { directory: 'fabric-1.20.1', minecraft: '1.20.1', loader: 'fabric', languages: 'java', buildSystem: 'gradle' },
  { directory: 'forge-1.12.2', minecraft: '1.12.2', loader: 'forge', languages: 'java', buildSystem: 'gradle' },
  { directory: 'neoforge-1.21', minecraft: '21.1.72', loader: 'neoforge', languages: 'java', buildSystem: 'gradle' },
  { directory: 'quilt-1.20.4', minecraft: '1.20.4', loader: 'quilt', languages: 'java', buildSystem: 'gradle' },
  { directory: 'maven-1.16.5', minecraft: '1.16.5', loader: 'fabric', languages: 'java', buildSystem: 'maven' },
  { directory: 'plain-java-1.7.10', minecraft: '1.7.10', loader: 'fabric', languages: 'java', buildSystem: 'gradle' },
  { directory: 'kotlin-1.21', minecraft: '1.21.4', loader: 'fabric', languages: 'java+kotlin', buildSystem: 'gradle' },
];

const MAPPING_FIXTURES = [
  { directory: 'mappings-tiny-v2', format: 'tiny-v2', primary: 'official', target: 'named' },
  { directory: 'mappings-tsrg2', format: 'tsrg2', primary: 'obf', target: 'named' },
  { directory: 'mappings-yarn', format: 'yarn', primary: 'intermediary', target: 'named' },
  { directory: 'mappings-mojang', format: 'mojang', primary: 'official', target: 'named' },
];

for (const fixture of PROJECT_FIXTURES) {
  test(`fixture ${fixture.directory} is detected correctly`, async () => {
    const root = path.join(fixturesRoot, fixture.directory);
    assert.equal(fs.existsSync(root), true, `fixture ${fixture.directory} must exist`);
    const project = await api.detectProject(root);
    assert.equal(project.buildSystem, fixture.buildSystem);
    assert.equal(project.minecraftVersion, fixture.minecraft);
    assert.equal(project.loader.kind, fixture.loader);
    assert.equal(project.languages, fixture.languages);
    assert.ok(project.sourceSets.length >= 1, 'the fixture must declare a source set');
    assert.ok(project.modMetadata.length >= 1, 'the fixture must declare loader metadata');
    assert.deepEqual(project.detectedIssues, []);
  });

  test(`fixture ${fixture.directory} reports through the CLI`, async () => {
    const root = path.join(fixturesRoot, fixture.directory);
    const text = await runCli(['detect', root]);
    assert.equal(text.code, 0);
    assert.match(text.stdout, new RegExp(fixture.minecraft.replace(/\./g, '\\.')));
    assert.match(text.stdout, /Build System:/);

    const json = await runCli(['detect', root, '--json']);
    assert.equal(json.code, 0);
    const parsed = JSON.parse(json.stdout);
    assert.equal(parsed.minecraft.version, fixture.minecraft);
    assert.equal(parsed.loader.kind, fixture.loader);
  });
}

for (const fixture of MAPPING_FIXTURES) {
  test(`mapping fixture ${fixture.directory} is detected as ${fixture.format}`, async () => {
    const root = path.join(fixturesRoot, fixture.directory);
    const probe = await api.probeMappings(root);
    assert.ok(probe !== undefined, `fixture ${fixture.directory} must be probeable`);
    assert.equal(probe.descriptor.format, fixture.format);
    assert.equal(probe.descriptor.primaryNamespace, fixture.primary);
    assert.equal(probe.descriptor.targetNamespace, fixture.target);
    assert.ok(probe.descriptor.entryCounts.classes > 0);
  });

  test(`mapping fixture ${fixture.directory} is reported by the CLI`, async () => {
    const root = path.join(fixturesRoot, fixture.directory);
    const result = await runCli(['mappings', root, '--json']);
    assert.equal(result.code, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.format, fixture.format);
    assert.equal(parsed.targetNamespace, fixture.target);
  });
}

test('fixtures cover multiple Minecraft eras', () => {
  const versions = PROJECT_FIXTURES.map((fixture) => fixture.minecraft);
  assert.ok(new Set(versions).size >= 6, 'the fixture set must span at least six distinct versions');
  assert.ok(versions.includes('1.7.10'));
  assert.ok(versions.includes('1.12.2'));
  assert.ok(versions.includes('1.16.5'));
  assert.ok(versions.includes('1.20.1'));
  assert.ok(versions.includes('1.21.4'));
});

test('fixtures cover every built in loader plus maven', () => {
  const loaders = PROJECT_FIXTURES.map((fixture) => fixture.loader);
  for (const loader of ['fabric', 'forge', 'neoforge', 'quilt']) {
    assert.ok(loaders.includes(loader), `a ${loader} fixture must exist`);
  }
  const systems = PROJECT_FIXTURES.map((fixture) => fixture.buildSystem);
  assert.ok(systems.includes('maven'), 'a maven fixture must exist');
  assert.ok(systems.includes('gradle'), 'a gradle fixture must exist');
});

test('every fixture declares a Minecraft version without a version whitelist', async () => {
  for (const fixture of PROJECT_FIXTURES) {
    const project = await api.detectProject(path.join(fixturesRoot, fixture.directory));
    assert.ok(project.minecraftVersionEvidence.length >= 1, `${fixture.directory} must record version evidence`);
  }
});

test('every fixture avoids comments in its own sources', () => {
  const offenders = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(java|kt|gradle|properties|toml|json)$/.test(entry.name)) continue;
      if (/\.json$/.test(entry.name)) continue;
      const content = fs.readFileSync(full, 'utf8');
      if (/^\s*(\/\/|\/\*|\*|#)/m.test(content)) offenders.push(path.relative(fixturesRoot, full));
    }
  };
  walk(fixturesRoot);
  assert.deepEqual(offenders, []);
});