import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createApi, tempDir, write, buildTinyMappings } from '../helpers/harness.mjs';

const api = createApi();

function mappingFixture(name, content, fileName = 'mappings.tiny') {
  const root = tempDir(name);
  write(root, fileName, content);
  return root;
}

test('tiny v2 mappings are detected with all namespaces', async () => {
  const root = mappingFixture('maps-tiny', buildTinyMappings(3, 120, '1.20.1'));
  const probe = await api.probeMappings(root);
  assert.ok(probe !== undefined);
  assert.equal(probe.descriptor.format, 'tiny-v2');
  assert.equal(probe.descriptor.primaryNamespace, 'official');
  assert.equal(probe.descriptor.targetNamespace, 'named');
  assert.equal(probe.descriptor.entryCounts.classes, 120);
  assert.equal(probe.descriptor.entryCounts.methods, 120);
  assert.deepEqual(
    probe.descriptor.namespaces.map((namespace) => namespace.name),
    ['official', 'intermediary', 'named'],
  );
});

test('tiny v1 mappings are detected as a distinct format', async () => {
  const content = ['tiny\t1\tofficial\tnamed', '', 'c\tnet/minecraft/a\tnet/minecraft/A', 'c\tnet/minecraft/b\tnet/minecraft/B'].join('\n');
  const root = mappingFixture('maps-tiny-v1', content);
  const probe = await api.probeMappings(root);
  assert.equal(probe?.descriptor.format, 'tiny-v1');
  assert.equal(probe?.descriptor.targetNamespace, 'named');
});

test('tiny v2 without parameter data is reported honestly', async () => {
  const root = mappingFixture('maps-tiny-noparam', buildTinyMappings(2, 5, '1.16.5'));
  const probe = await api.probeMappings(root);
  assert.equal(probe?.descriptor.entryCounts.parameters, 0);
  assert.equal(probe?.descriptor.minecraft.confidence, 'none');
});

test('tiny v2 with parameter entries counts them', async () => {
  const content = [
    'tiny\t2\t0\tofficial\tnamed',
    '',
    'c\tnet/minecraft/a\tnet/minecraft/A',
    '\tm\t()V\tmethod_a\tvalue\t',
    '\tp\t1\trem\tparamName',
    '',
  ].join('\n');
  const root = mappingFixture('maps-tiny-param', content);
  const probe = await api.probeMappings(root);
  assert.equal(probe?.descriptor.entryCounts.parameters, 1);
  assert.equal(probe?.descriptor.entryCounts.methods, 1);
});

test('TSRG2 mappings are detected', async () => {
  const content = [
    'tsrg2 obf srg',
    'a b',
    'c d',
    '\tm\t()V\tmethodName',
    '\tf\tfieldName',
  ].join('\n');
  const root = mappingFixture('maps-tsrg2', content, 'mapping.tsrg2');
  const probe = await api.probeMappings(root);
  assert.equal(probe?.descriptor.format, 'tsrg2');
  assert.equal(probe.descriptor.entryCounts.classes, 2);
  assert.equal(probe.descriptor.entryCounts.methods, 1);
  assert.equal(probe.descriptor.entryCounts.fields, 1);
  assert.equal(probe.descriptor.primaryNamespace, 'obf');
  assert.equal(probe.descriptor.targetNamespace, 'srg');
});

test('TSRG v1 mappings are detected', async () => {
  const content = ['a b', 'c d', '\tfield fieldName'].join('\n');
  const root = mappingFixture('maps-tsrg', content, 'mapping.tsrg');
  const probe = await api.probeMappings(root);
  assert.equal(probe?.descriptor.format, 'tsrg');
  assert.equal(probe.descriptor.entryCounts.classes, 2);
  assert.ok(probe.descriptor.notes.some((note) => /parameter/i.test(note)));
});

test('SRG mappings are detected', async () => {
  const content = ['CL: a b', 'FD: a/b c', 'MD: a/b ()V d'].join('\n');
  const root = mappingFixture('maps-srg', content, 'joined.srg');
  const probe = await api.probeMappings(root);
  assert.equal(probe?.descriptor.format, 'srg');
  assert.equal(probe?.descriptor.entryCounts.classes, 1);
});

test('yarn proguard mappings are classified as yarn', async () => {
  const content = [
    '# yarn mappings',
    'net.minecraft.class_1 -> net.minecraft.NamedOne:',
    '    field_1 -> fieldNameOne',
    '    method_1 ()V -> methodNameOne',
    '',
  ].join('\n');
  const root = mappingFixture('maps-yarn', content, 'yarn-1.20.1-v2.txt');
  const probe = await api.probeMappings(root);
  assert.equal(probe?.descriptor.format, 'yarn');
  assert.equal(probe?.descriptor.primaryNamespace, 'intermediary');
  assert.equal(probe?.descriptor.targetNamespace, 'named');
  assert.ok(probe.descriptor.entryCounts.classes >= 1);
});

test('intermediary proguard mappings are classified as intermediary', async () => {
  const content = ['net.minecraft.class_1 -> net/minecraft/Class1:', '    field_1 -> fieldNameOne', ''].join('\n');
  const root = mappingFixture('maps-intermediary', content, 'intermediary-1.20.1.txt');
  const probe = await api.probeMappings(root);
  assert.equal(probe?.descriptor.format, 'intermediary');
});

test('mojang proguard mappings are detected from their header', async () => {
  const header = ['# This file is a mapping for Mojang', '# com.mojang.blaze3d:XXXX', ''].join('\n');
  const body = ['net.minecraft.class_1 -> net.minecraft.client.Minecraft:', '    FIELD_1 -> running', '    func_1 ()V -> tick', ''].join('\n');
  const root = mappingFixture('maps-mojang', header + body, 'client.txt');
  const probe = await api.probeMappings(root);
  assert.equal(probe?.descriptor.format, 'mojang');
  assert.equal(probe.descriptor.primaryNamespace, 'official');
});

test('generic proguard mappings fall back to the generic provider', async () => {
  const content = ['com.example.Foo -> a:', '    field -> b', '    method ()V -> c', ''].join('\n');
  const root = mappingFixture('maps-proguard', content, 'mappings.pro');
  const probe = await api.probeMappings(root);
  assert.equal(probe?.descriptor.format, 'proguard');
});

test('parchment metadata is detected as a sidecar', async () => {
  const root = mappingFixture(
    'maps-parchment',
    `${buildTinyMappings(3, 30, '1.20.1')}`,
    'mappings.tiny',
  );
  write(
    root,
    'parchment-1.20.1.json',
    JSON.stringify({ name: 'Parchment for 1.20.1', version: '1.20.1+build.3', targetNamespace: 'named', minecraftVersion: '1.20.1' }),
  );
  const probe = await api.probeMappings(root);
  assert.equal(probe?.descriptor.parchment?.minecraftVersion, '1.20.1');
  assert.equal(probe.descriptor.format, 'tiny-v2');
});

test('a standalone parchment file is detected and scored below tiny', async () => {
  const root = mappingFixture('maps-parchment-only', JSON.stringify({ classes: [{ name: 'a', parameters: [{ index: 0, name: 'p' }] }] }), 'parchment.json');
  const probe = await api.probeMappings(root);
  assert.equal(probe?.descriptor.format, 'parchment');
  assert.equal(probe.descriptor.entryCounts.parameters, 1);
});

test('an empty directory is not treated as a mappings set', async () => {
  const root = mappingFixture('maps-empty', 'placeholder\n');
  const probe = await api.probeMappings(root);
  assert.equal(probe, undefined);
});

test('mapping file paths are reported for the report', async () => {
  const root = mappingFixture('maps-files', buildTinyMappings(3, 10, '1.21.4'), '1.21.4.tiny');
  const probe = await api.probeMappings(root);
  assert.equal(probe.descriptor.files.length, 1);
  assert.equal(path.basename(probe.descriptor.files[0].path), '1.21.4.tiny');
  assert.equal(probe.descriptor.minecraft.version, '1.21.4');
});

test('the registry prefers the candidate with the most credible entries', async () => {
  const root = mappingFixture('maps-mixed', buildTinyMappings(3, 80, '1.20.1'), 'primary.tiny');
  write(root, 'small.tsrg', 'tsrg2 obf srg\n\ta\tb\n');
  const probe = await api.probeMappings(root);
  assert.equal(probe?.descriptor.format, 'tiny-v2');
  assert.ok(probe.candidates.length >= 2);
  assert.equal(probe.candidates[0].format, 'tiny-v2');
});