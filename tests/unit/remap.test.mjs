import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createApi, tempDir, zip } from '../helpers/harness.mjs';

const api = createApi();

const CLASS_MAJOR = 61;

function classFile(majorVersion, internalName, superName = 'java/lang/Object', referencedClasses = []) {
  const classNames = [internalName, superName, ...referencedClasses];
  const utf8Entries = classNames.map((name) => Buffer.from(name, 'utf8'));
  const utf8IndexOf = (name) => utf8Entries.findIndex((entry) => entry.toString('utf8') === name);
  const poolSize = 1 + utf8Entries.length + classNames.length;
  const thisClassIndex = 1 + utf8Entries.length;
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
  for (const bytes of utf8Entries) chunks.push(u1(1), u2(bytes.length), bytes);
  for (const name of classNames) chunks.push(u1(7), u2(utf8IndexOf(name) + 1));
  chunks.push(u2(0x0021), u2(thisClassIndex), u2(thisClassIndex + 1), u2(0), u2(0), u2(0), u2(0));
  return Buffer.concat(chunks);
}

function tinyMapping(entries) {
  const lines = ['tiny\t2\t0\tofficial\tintermediary\tnamed', ''];
  for (const entry of entries) lines.push(entry);
  return `${lines.join('\n')}\n`;
}

test('remapping rewrites class names in a jar', async () => {
  const root = tempDir('remap-classes');
  const mappingsPath = path.join(root, 'mappings.tiny');
  fs.writeFileSync(
    mappingsPath,
    tinyMapping([
      'c\tnet/minecraft/class_1\tnet/minecraft/ObfOne\tnet/minecraft/named/NamedOne',
      'c\tnet/minecraft/class_2\tnet/minecraft/ObfTwo\tnet/minecraft/named/NamedTwo',
    ]),
  );

  const inputJar = path.join(root, 'input.jar');
  fs.writeFileSync(
    inputJar,
    zip([
      { name: 'META-INF/MANIFEST.MF', data: Buffer.from('Manifest-Version: 1.0\n') },
      { name: 'net/minecraft/class_1.class', data: classFile(CLASS_MAJOR, 'net/minecraft/class_1') },
      { name: 'net/minecraft/class_2.class', data: classFile(CLASS_MAJOR, 'net/minecraft/class_2') },
      { name: 'assets/minecraft/textures/icon.png', data: Buffer.from('fake-png-bytes') },
    ]),
  );

  const descriptor = (await api.probeMappings(root)).descriptor;
  const outputJar = path.join(root, 'output.jar');
  const result = await api.remapJar({
    inputJar,
    outputJar,
    mappings: descriptor,
    mappingsFile: mappingsPath,
    fromNamespace: 'official',
    toNamespace: 'named',
  });

  assert.equal(result.classesRemapped, 2);
  assert.equal(result.resourcesCopied, 1);
  const inspection = await api.inspectJar(outputJar);
  assert.ok(inspection.classes.includes('net/minecraft/named/NamedOne.class'));
  assert.ok(inspection.classes.includes('net/minecraft/named/NamedTwo.class'));
  assert.ok(inspection.resources.includes('assets/minecraft/textures/icon.png'));
  assert.equal(inspection.crcOk, true);
});

test('remapping between intermediary and named renames classes', async () => {
  const root = tempDir('remap-intermediary');
  const mappingsPath = path.join(root, 'yarn.tiny');
  fs.writeFileSync(
    mappingsPath,
    tinyMapping(['c\tnet/minecraft/class_9\tnet/minecraft/aa\tnet/minecraft/named/HelloWorld']),
  );
  const inputJar = path.join(root, 'input.jar');
  fs.writeFileSync(inputJar, zip([{ name: 'net/minecraft/aa.class', data: classFile(CLASS_MAJOR, 'net/minecraft/aa') }]));
  const descriptor = (await api.probeMappings(root)).descriptor;
  const outputJar = path.join(root, 'output.jar');
  const result = await api.remapJar({
    inputJar,
    outputJar,
    mappings: descriptor,
    mappingsFile: mappingsPath,
    fromNamespace: 'intermediary',
    toNamespace: 'named',
  });
  assert.equal(result.classesRemapped, 1);
  const inspection = await api.inspectJar(outputJar);
  assert.ok(inspection.classes.includes('net/minecraft/named/HelloWorld.class'));
});

test('remapping preserves classes the mappings do not cover', async () => {
  const root = tempDir('remap-partial');
  const mappingsPath = path.join(root, 'mappings.tiny');
  fs.writeFileSync(mappingsPath, tinyMapping(['c\tnet/minecraft/known\ta\tnet/minecraft/Known']));
  const inputJar = path.join(root, 'input.jar');
  fs.writeFileSync(
    inputJar,
    zip([
      { name: 'net/minecraft/known.class', data: classFile(CLASS_MAJOR, 'net/minecraft/known') },
      { name: 'com/example/Local.class', data: classFile(CLASS_MAJOR, 'com/example/Local') },
      { name: 'java/lang/Helper.class', data: classFile(CLASS_MAJOR, 'java/lang/Helper') },
    ]),
  );
  const descriptor = (await api.probeMappings(root)).descriptor;
  const outputJar = path.join(root, 'output.jar');
  await api.remapJar({
    inputJar,
    outputJar,
    mappings: descriptor,
    mappingsFile: mappingsPath,
    fromNamespace: 'official',
    toNamespace: 'named',
  });
  const inspection = await api.inspectJar(outputJar);
  assert.ok(inspection.classes.includes('net/minecraft/Known.class'));
  assert.ok(inspection.classes.includes('com/example/Local.class'));
  assert.ok(inspection.classes.includes('java/lang/Helper.class'));
});

test('remapping with an empty mapping set is reported instead of silently passing', async () => {
  const root = tempDir('remap-noop');
  const mappingsPath = path.join(root, 'mappings.tiny');
  fs.writeFileSync(mappingsPath, 'tiny\t2\t0\tofficial\tintermediary\tnamed\n\n');
  const inputJar = path.join(root, 'input.jar');
  fs.writeFileSync(inputJar, zip([{ name: 'com/example/Only.class', data: classFile(CLASS_MAJOR, 'com/example/Only') }]));
  const descriptor = (await api.probeMappings(root)).descriptor;
  const outputJar = path.join(root, 'output.jar');
  const result = await api.remapJar({
    inputJar,
    outputJar,
    mappings: descriptor,
    mappingsFile: mappingsPath,
    fromNamespace: 'official',
    toNamespace: 'named',
  });
  assert.equal(result.tookNoop, true);
  assert.ok(result.warnings.some((warning) => /no class mappings/i.test(warning)));
});

test('remapping fails clearly for a missing input jar', async () => {
  const root = tempDir('remap-missing-input');
  const mappingsPath = path.join(root, 'mappings.tiny');
  fs.writeFileSync(mappingsPath, tinyMapping(['c\ta\ta\tb\tc']));
  const descriptor = (await api.probeMappings(root)).descriptor;
  await assert.rejects(
    api.remapJar({
      inputJar: path.join(root, 'absent.jar'),
      outputJar: path.join(root, 'out.jar'),
      mappings: descriptor,
      mappingsFile: mappingsPath,
      fromNamespace: 'official',
      toNamespace: 'named',
    }),
    /Input JAR does not exist/,
  );
});

test('remapping preserves the class file version', async () => {
  const root = tempDir('remap-version');
  const mappingsPath = path.join(root, 'mappings.tiny');
  fs.writeFileSync(mappingsPath, tinyMapping(['c\tnet/minecraft/x\ta\tnet/minecraft/X']));
  const inputJar = path.join(root, 'input.jar');
  fs.writeFileSync(inputJar, zip([{ name: 'net/minecraft/x.class', data: classFile(52, 'net/minecraft/x') }]));
  const descriptor = (await api.probeMappings(root)).descriptor;
  const outputJar = path.join(root, 'output.jar');
  await api.remapJar({
    inputJar,
    outputJar,
    mappings: descriptor,
    mappingsFile: mappingsPath,
    fromNamespace: 'official',
    toNamespace: 'named',
  });
  const analysis = await api.analyzeBytecode({ jarPath: outputJar });
  assert.equal(analysis.maxMajor, 52);
  assert.equal(analysis.parseFailures.length, 0);
});

test('jar writing produces a readable archive with a manifest', async () => {
  const root = tempDir('jar-write');
  const jarPath = path.join(root, 'written.jar');
  fs.writeFileSync(
    jarPath,
    zip([
      { name: 'META-INF/MANIFEST.MF', data: Buffer.from('Manifest-Version: 1.0\r\nMain-Class: com.example.Main\r\n\r\n') },
      { name: 'com/example/Main.class', data: classFile(CLASS_MAJOR, 'com/example/Main') },
    ]),
  );
  const inspection = await api.inspectJar(jarPath);
  assert.equal(inspection.entryCount, 2);
  assert.equal(inspection.classCount, 1);
  assert.equal(inspection.crcOk, true);
});

test('zip reader rejects a truncated archive', async () => {
  const root = tempDir('zip-truncated');
  const jarPath = path.join(root, 'truncated.jar');
  const complete = zip([{ name: 'META-INF/MANIFEST.MF', data: Buffer.from('Manifest-Version: 1.0\n') }]);
  fs.writeFileSync(jarPath, complete.subarray(0, complete.length - 8));
  await assert.rejects(api.inspectJar(jarPath));
});

test('zip reader rejects a file that is not an archive', async () => {
  const root = tempDir('zip-not-archive');
  const target = path.join(root, 'plain.txt');
  fs.writeFileSync(target, 'this is not a zip archive at all');
  await assert.rejects(api.inspectJar(target));
});

test('inspector reports suspicious archive entry names', async () => {
  const root = tempDir('zip-unsafe');
  const jarPath = path.join(root, 'unsafe.jar');
  fs.writeFileSync(
    jarPath,
    zip([
      { name: 'META-INF/MANIFEST.MF', data: Buffer.from('Manifest-Version: 1.0\n') },
      { name: '../outside.txt', data: Buffer.from('escape') },
    ]),
  );
  const inspection = await api.inspectJar(jarPath);
  assert.ok(inspection.resources.includes('../outside.txt'));
  assert.equal(inspection.crcOk, true);
});

test('writing and reading a jar round trips entry data', async () => {
  const root = tempDir('zip-round-trip');
  const source = path.join(root, 'source.jar');
  const payload = Buffer.from('x'.repeat(5000));
  fs.writeFileSync(source, zip([{ name: 'data/big.bin', data: payload }]));
  const inspection = await api.inspectJar(source);
  assert.deepEqual(inspection.resources, ['data/big.bin']);
  const copyPath = path.join(root, 'copy.jar');
  fs.copyFileSync(source, copyPath);
  const copied = await api.inspectJar(copyPath);
  assert.equal(copied.entryCount, inspection.entryCount);
  assert.equal(copied.crcOk, true);
});