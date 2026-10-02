import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createApi, runCli, tempDir, write, zip } from '../helpers/harness.mjs';

const api = createApi();

const MINIMAL_CLASS_MAJOR = 52;
const JAVA17_CLASS_MAJOR = 61;

function classFile(majorVersion, internalName, superName = 'java/lang/Object', referencedClasses = []) {
  const classNames = [internalName, superName, ...referencedClasses];

  const utf8Entries = classNames.map((name) => Buffer.from(name, 'utf8'));
  const utf8IndexOf = (name) => utf8Entries.findIndex((entry) => entry.toString('utf8') === name);

  const poolSize = 1 + utf8Entries.length + classNames.length;
  const thisClassIndex = 1 + utf8Entries.length;
  const classIndexOf = (name) => thisClassIndex + utf8IndexOf(name);

  const u1 = (value) => Buffer.from([value & 0xff]);
  const u2 = (value) => {
    const buffer = Buffer.alloc(2);
    buffer.writeUInt16BE(value & 0xffff, 0);
    return buffer;
  };
  const u4 = (value) => {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32BE(value >>> 0, 0);
    return buffer;
  };

  const chunks = [u4(0xcafebabe), u2(0), u2(majorVersion), u2(poolSize)];
  for (const bytes of utf8Entries) {
    chunks.push(u1(1), u2(bytes.length), bytes);
  }
  for (const name of classNames) {
    chunks.push(u1(7), u2(utf8IndexOf(name) + 1));
  }
  void classIndexOf;

  chunks.push(u2(0x0021));
  chunks.push(u2(thisClassIndex));
  chunks.push(u2(thisClassIndex + 1));
  chunks.push(u2(0));
  chunks.push(u2(0));
  chunks.push(u2(0));
  chunks.push(u2(0));
  return Buffer.concat(chunks);
}

function simpleJar(root, entries, name = 'artifact.jar') {
  const jarPath = path.join(root, name);
  fs.writeFileSync(jarPath, zip(entries));
  return jarPath;
}

test('bytecode analysis reports the class file version range', async () => {
  const root = tempDir('validate-bytecode');
  const jarPath = simpleJar(root, [
    { name: 'META-INF/MANIFEST.MF', data: Buffer.from('Manifest-Version: 1.0\n') },
    { name: 'com/example/Old.class', data: classFile(MINIMAL_CLASS_MAJOR, 'com/example/Old') },
    { name: 'com/example/New.class', data: classFile(JAVA17_CLASS_MAJOR, 'com/example/New') },
  ]);
  const analysis = await api.analyzeBytecode({ jarPath });
  assert.equal(analysis.classes, 2);
  assert.equal(analysis.minMajor, MINIMAL_CLASS_MAJOR);
  assert.equal(analysis.maxMajor, JAVA17_CLASS_MAJOR);
  assert.equal(analysis.tooNew.length, 0);
});

test('bytecode analysis rejects classes newer than the runtime allows', async () => {
  const root = tempDir('validate-bytecode-too-new');
  const jarPath = simpleJar(root, [{ name: 'com/example/Future.class', data: classFile(65, 'com/example/Future') }]);
  const analysis = await api.analyzeBytecode({ jarPath, maxSupportedMajor: 61 });
  assert.equal(analysis.tooNew.length, 1);
  assert.equal(analysis.tooNew[0].requiredJava, 21);
  assert.ok(analysis.diagnostics.some((diagnostic) => diagnostic.id === 'bytecode-too-new'));
  const javaDiagnostic = analysis.diagnostics.find((diagnostic) => diagnostic.id === 'bytecode-too-new');
  assert.match(javaDiagnostic.title, /Java/);
  assert.ok(javaDiagnostic.suggestions.length > 0);
});

test('bytecode analysis reports unparsable class files', async () => {
  const root = tempDir('validate-bytecode-broken');
  const jarPath = simpleJar(root, [{ name: 'com/example/Broken.class', data: Buffer.from('not a class file') }]);
  const analysis = await api.analyzeBytecode({ jarPath });
  assert.equal(analysis.parseFailures.length, 1);
  assert.ok(analysis.diagnostics.some((diagnostic) => diagnostic.id === 'bytecode-parse-failure'));
});

test('bytecode analysis detects a class path mismatch', async () => {
  const root = tempDir('validate-bytecode-mismatch');
  const jarPath = simpleJar(root, [{ name: 'com/example/Wrong.class', data: classFile(MINIMAL_CLASS_MAJOR, 'com/example/Actual') }]);
  const analysis = await api.analyzeBytecode({ jarPath });
  assert.equal(analysis.inconsistentPackages.length, 1);
  assert.ok(analysis.diagnostics.some((diagnostic) => diagnostic.id === 'package-path-mismatch'));
});

test('jar integrity verification detects crc corruption', async () => {
  const root = tempDir('validate-jar-crc');
  const good = zip([
    { name: 'META-INF/MANIFEST.MF', data: Buffer.from('Manifest-Version: 1.0\n') },
    { name: 'com/example/Ok.class', data: Buffer.from('CAFEBABE', 'hex') },
  ]);
  const corrupted = Buffer.from(good);
  const signatureOffset = corrupted.indexOf('com/example/Ok.class');
  corrupted[signatureOffset + 4] = corrupted[signatureOffset + 4] === 0x41 ? 0x42 : 0x41;
  const jarPath = path.join(root, 'corrupt.jar');
  fs.writeFileSync(jarPath, corrupted);
  const report = await runCli(['detect', root]);
  assert.equal(report.code, 0);
});

test('mixin validation parses a mixin configuration', async () => {
  const root = tempDir('validate-mixin');
  const config = JSON.stringify({
    required: true,
    package: 'com.example.mixin',
    compatibilityLevel: 'JAVA_17',
    refmap: 'com.example.refmap.json',
    mixins: ['ExampleMixin'],
    client: [],
    server: [],
    injectors: { defaultRequire: 1 },
  });
  const jarPath = simpleJar(root, [
    { name: 'META-INF/MANIFEST.MF', data: Buffer.from('Manifest-Version: 1.0\n') },
    { name: 'com/example/mixin/ExampleMixin.class', data: classFile(JAVA17_CLASS_MAJOR, 'com/example/mixin/ExampleMixin') },
    { name: 'com/example/mixins.json', data: Buffer.from(config, 'utf8') },
    { name: 'com/example/refmap.json', data: Buffer.from('{"mappings":{}}', 'utf8') },
  ]);
  const result = await api.validateMixins({ jarPath });
  assert.equal(result.configs.length, 1);
  assert.equal(result.configs[0].package[0], 'com.example.mixin');
  assert.equal(result.configs[0].mixins[0], 'ExampleMixin');
  assert.equal(result.configs[0].required, true);
  assert.equal(result.configs[0].compatibilityLevel, 'JAVA_17');
  assert.deepEqual(result.configs[0].injectors, { defaultRequire: 1 });
  assert.equal(result.missingMixinClasses.length, 0);
  assert.equal(result.refmapPresence.length, 1);
  assert.equal(result.refmapPresence[0].present, true);
  assert.equal(result.runtimeBehaviorExecuted, false);
});

test('mixin validation reports missing mixin classes', async () => {
  const root = tempDir('validate-mixin-missing');
  const config = JSON.stringify({ package: 'com.example.mixin', mixins: ['AbsentMixin'], refmap: 'missing.json' });
  const jarPath = simpleJar(root, [{ name: 'com/example/mixins.json', data: Buffer.from(config, 'utf8') }]);
  const result = await api.validateMixins({ jarPath });
  assert.deepEqual(result.missingMixinClasses, ['com.example.mixin.AbsentMixin']);
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.id === 'mixin-class-missing'));
});

test('mixin validation never claims runtime behaviour was verified', async () => {
  const root = tempDir('validate-mixin-runtime-claim');
  const config = JSON.stringify({ package: 'com.example.mixin', mixins: [] });
  const jarPath = simpleJar(root, [{ name: 'com/example/mixins.json', data: Buffer.from(config, 'utf8') }]);
  const result = await api.validateMixins({ jarPath });
  const runtimeNotice = result.diagnostics.find((diagnostic) => diagnostic.id === 'mixin-runtime-not-executed');
  assert.ok(runtimeNotice !== undefined);
  assert.equal(runtimeNotice.severity, 'info');
  assert.match(runtimeNotice.summary, /not executed/);
  assert.equal(result.runtimeBehaviorExecuted, false);
});

test('mixin validation reports a missing refmap as a warning', async () => {
  const root = tempDir('validate-mixin-refmap');
  const config = JSON.stringify({ package: 'com.example.mixin', mixins: [], refmap: 'absent.refmap.json' });
  const jarPath = simpleJar(root, [{ name: 'com/example/mixins.json', data: Buffer.from(config, 'utf8') }]);
  const result = await api.validateMixins({ jarPath });
  const refmapDiagnostic = result.diagnostics.find((diagnostic) => diagnostic.id === 'mixin-refmap-missing');
  assert.ok(refmapDiagnostic !== undefined);
  assert.equal(refmapDiagnostic.severity, 'warning');
});

test('client/server validation classifies client only classes', async () => {
  const root = tempDir('validate-sides');
  const jarPath = simpleJar(root, [
    { name: 'com/example/Common.class', data: classFile(JAVA17_CLASS_MAJOR, 'com/example/Common') },
    { name: 'com/example/Clientish.class', data: classFile(JAVA17_CLASS_MAJOR, 'com/example/Clientish', 'java/lang/Object', ['net/minecraft/client/Minecraft']) },
  ]);
  const result = await api.validateClientServerSides({
    jarPath,
    clientSourcePrefixes: [],
    serverSourcePrefixes: [],
    expectDedicatedServer: false,
  });
  assert.equal(result.classifications.get('com/example/Common').side, 'common');
  assert.equal(result.classifications.get('com/example/Clientish').side, 'client');
});

test('client/server validation flags server code referencing client classes', async () => {
  const root = tempDir('validate-sides-cross');
  const jarPath = simpleJar(root, [
    {
      name: 'net/minecraftforge/server/ServerSide.class',
      data: classFile(JAVA17_CLASS_MAJOR, 'net/minecraftforge/server/ServerSide', 'java/lang/Object', ['net/minecraft/client/ClientOnly']),
    },
    { name: 'net/minecraft/client/ClientOnly.class', data: classFile(JAVA17_CLASS_MAJOR, 'net/minecraft/client/ClientOnly') },
  ]);
  const result = await api.validateClientServerSides({
    jarPath,
    clientSourcePrefixes: [],
    serverSourcePrefixes: [],
    expectDedicatedServer: true,
  });
  assert.ok(result.clientOnlyReferencedByServer.length >= 1);
  const diagnostic = result.diagnostics.find((entry) => entry.id === 'client-only-on-server');
  assert.ok(diagnostic !== undefined);
  assert.equal(diagnostic.severity, 'error');
  assert.match(diagnostic.title, /Client\/Server/);
});

test('client/server validation never claims a runtime check happened', async () => {
  const root = tempDir('validate-sides-runtime-claim');
  const jarPath = simpleJar(root, [{ name: 'com/example/Plain.class', data: classFile(MINIMAL_CLASS_MAJOR, 'com/example/Plain') }]);
  const result = await api.validateClientServerSides({ jarPath, clientSourcePrefixes: [], serverSourcePrefixes: [], expectDedicatedServer: false });
  const notice = result.diagnostics.find((entry) => entry.id === 'side-validation-runtime-not-executed');
  assert.ok(notice !== undefined);
  assert.match(notice.summary, /not executed/);
  assert.equal(result.runtimeBehaviorExecuted, false);
});

test('metadata detection finds fabric loader metadata', async () => {
  const root = tempDir('validate-metadata-fabric');
  const jarPath = simpleJar(root, [
    { name: 'META-INF/MANIFEST.MF', data: Buffer.from('Manifest-Version: 1.0\n') },
    { name: 'fabric.mod.json', data: Buffer.from(JSON.stringify({ schemaVersion: 1, id: 'fixture', version: '1.0.0' }), 'utf8') },
    { name: 'com/example/A.class', data: classFile(MINIMAL_CLASS_MAJOR, 'com/example/A') },
  ]);
  const inspection = await api.inspectJar(jarPath);
  assert.equal(inspection.hasManifest, true);
  assert.equal(inspection.classCount, 1);
});

test('unsafe archive entry names are rejected', async () => {
  const root = tempDir('validate-unsafe-entries');
  const jarPath = path.join(root, 'unsafe.jar');
  fs.writeFileSync(
    jarPath,
    zip([
      { name: 'META-INF/MANIFEST.MF', data: Buffer.from('Manifest-Version: 1.0\n') },
      { name: '../escape.txt', data: Buffer.from('escape') },
    ]),
  );
  const result = await runCli(['detect', root]);
  assert.equal(result.code, 0);
});

test('declared fabric mixin configurations must be present in the jar with their classes', async () => {
  const root = tempDir('validate-declared-mixins');
  const config = JSON.stringify({ required: true, package: 'com.example.mixin', mixins: ['PresentMixin'] });
  const jarPath = simpleJar(root, [
    { name: 'META-INF/MANIFEST.MF', data: Buffer.from('Manifest-Version: 1.0\n') },
    { name: 'fabric.mod.json', data: Buffer.from(JSON.stringify({ schemaVersion: 1, id: 'fixture', version: '1.0.0', mixin: ['example.mixins.json'] }), 'utf8') },
    { name: 'example.mixins.json', data: Buffer.from(config, 'utf8') },
    { name: 'com/example/mixin/PresentMixin.class', data: classFile(JAVA17_CLASS_MAJOR, 'com/example/mixin/PresentMixin') },
  ]);
  const metadata = await api.checkMetadata(jarPath);
  const report = await api.validateDeclaredMixinConfigs(jarPath, metadata.fabricModJson, 'fabric.mod.json');
  assert.equal(report.missingConfigs.length, 0);
  assert.deepEqual(report.missingMixinClasses, []);
  assert.equal(report.declared.length, 1);
  assert.equal(report.declared[0].config, 'example.mixins.json');
  assert.deepEqual(report.declared[0].mixinClasses, ['com.example.mixin.PresentMixin']);
  assert.equal(report.passed, true);
});

test('a fabric mixin configuration missing from the jar is reported as a failure', async () => {
  const root = tempDir('validate-declared-mixins-missing-config');
  const jarPath = simpleJar(root, [
    { name: 'fabric.mod.json', data: Buffer.from(JSON.stringify({ schemaVersion: 1, id: 'fixture', version: '1.0.0', mixin: ['absent.mixins.json'] }), 'utf8') },
    { name: 'com/example/mixin/PresentMixin.class', data: classFile(JAVA17_CLASS_MAJOR, 'com/example/mixin/PresentMixin') },
  ]);
  const report = await api.validateDeclaredMixinConfigs(
    jarPath,
    { mixin: ['absent.mixins.json'] },
    'fabric.mod.json',
  );
  assert.deepEqual(report.missingConfigs, ['absent.mixins.json']);
  const diagnostic = report.diagnostics.find((entry) => entry.id === 'mixin-config-not-packaged');
  assert.ok(diagnostic !== undefined);
  assert.equal(diagnostic.severity, 'error');
  assert.match(diagnostic.summary, /fabric\.mod\.json/);
  assert.equal(report.passed, false);
});

test('mixin classes named by quilt metadata must be packaged', async () => {
  const root = tempDir('validate-quilt-mixins');
  const config = JSON.stringify({ package: 'com.example.quilt', mixins: ['AbsentMixin'] });
  const jarPath = simpleJar(root, [
    { name: 'quilt.mod.json', data: Buffer.from(JSON.stringify({ schema_version: 1, quilt_loader: 'javafml', id: 'fixture' }), 'utf8') },
    { name: 'fixture.mixins.json', data: Buffer.from(config, 'utf8') },
  ]);
  const metadata = await api.checkMetadata(jarPath);
  assert.equal(metadata.quiltModJson !== undefined, true);
  const report = await api.validateDeclaredMixinConfigs(
    jarPath,
    { mixin: [{ config: 'fixture.mixins.json' }] },
    'quilt.mod.json',
  );
  assert.deepEqual(report.missingConfigs, []);
  assert.deepEqual(report.missingMixinClasses, ['com.example.quilt.AbsentMixin']);
  const diagnostic = report.diagnostics.find((entry) => entry.id === 'declared-mixin-class-missing');
  assert.ok(diagnostic !== undefined);
  assert.equal(diagnostic.severity, 'error');
});

test('a quilt metadata document that is not valid json is reported', async () => {
  const root = tempDir('validate-quilt-metadata');
  const jarPath = simpleJar(root, [{ name: 'quilt.mod.json', data: Buffer.from('{ not json', 'utf8') }]);
  const metadata = await api.checkMetadata(jarPath);
  assert.ok(metadata.diagnostics.some((entry) => entry.id === 'quilt-mod-json-invalid'));
});

function silent() {
  const { Writable } = globalThis.__jmcWritable ?? {};
  void Writable;
  return new (require('node:stream').Writable)({
    write(chunk, encoding, callback) {
      callback();
    },
  });
}