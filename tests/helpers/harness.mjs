import fs from 'node:fs';
import { Writable } from 'node:stream';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createApi } from '../../dist/test-lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, '..', '..');
export const tempRoot = path.join(repoRoot, '.jmc-test-tmp');

export function tempDir(name) {
  const target = path.join(tempRoot, name);
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  return target;
}

export function ensureTempRoot() {
  fs.mkdirSync(tempRoot, { recursive: true });
  return tempRoot;
}

export function write(root, relative, content) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
  return target;
}

export function readIfExists(target) {
  try {
    return fs.readFileSync(target, 'utf8');
  } catch {
    return undefined;
  }
}

export function exists(target) {
  return fs.existsSync(target);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index += 1) {
    crc = (CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function zip(entries, modificationTime) {
  const local = [];
  const central = [];
  let offset = 0;
  const dosDate = 33;
  for (const entry of entries) {
    const name = entry.name.endsWith('/') ? entry.name : entry.name;
    const raw = entry.data ?? Buffer.alloc(0);
    const nameBuffer = Buffer.from(name, 'utf8');
    const method = raw.length === 0 ? 0 : 8;
    const payload = method === 0 ? raw : zlib.deflateRawSync(raw, { level: 9 });
    const checksum = raw.length === 0 ? 0 : crc32(raw);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(dosDate, 12);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(payload.length, 18);
    header.writeUInt32LE(raw.length, 22);
    header.writeUInt16LE(nameBuffer.length, 26);
    local.push(header, nameBuffer, payload);

    const directoryEntry = Buffer.alloc(46);
    directoryEntry.writeUInt32LE(0x02014b50, 0);
    directoryEntry.writeUInt16LE((3 << 8) | 20, 4);
    directoryEntry.writeUInt16LE(20, 6);
    directoryEntry.writeUInt16LE(method, 10);
    directoryEntry.writeUInt16LE(dosDate, 14);
    directoryEntry.writeUInt32LE(checksum, 16);
    directoryEntry.writeUInt32LE(payload.length, 20);
    directoryEntry.writeUInt32LE(raw.length, 24);
    directoryEntry.writeUInt16LE(nameBuffer.length, 28);
    directoryEntry.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    directoryEntry.writeUInt32LE(offset, 42);
    central.push(directoryEntry, nameBuffer);
    offset += header.length + nameBuffer.length + payload.length;
  }
  void modificationTime;
  const centralBuffer = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(central.length / 2, 8);
  eocd.writeUInt16LE(central.length / 2, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBuffer, eocd]);
}

export const magicClassName = 'com/jmc/fixture/Fixture';
export const magicSource = [
  'package com.jmc.fixture;',
  '',
  'public final class Fixture {',
  '    public static String value() {',
  '        return "fixture";',
  '    }',
  '}',
  '',
].join('\n');

export function buildTinyMappings(namespaceCount = 3, classCount = 40, versionText = '1.20.1') {
  const lines = ['tiny\t2\t0\tofficial\tintermediary\tnamed', ''];
  for (let index = 0; index < classCount; index += 1) {
    lines.push(`c\tnet/minecraft/class_${index}\ta\tnet/minecraft/Class${index}\tnet/minecraft/named/Class${index}`);
    lines.push(`\tf\tfield_${index}\ta\tb\tfieldName${index}\tfieldNameMapped${index}`);
    lines.push(`\tm\t()V\tmethod_${index}\tmethodName${index}\tmethodNameMapped${index}`);
  }
  void namespaceCount;
  void versionText;
  return `${lines.join('\n')}\n`;
}

export function silent() {
  let sink;
  sink = new Writable({
    write(chunk, encoding, callback) {
      callback();
    },
  });
  sink.text = () => '';
  return sink;
}

export function capture() {
  const chunks = [];
  const sink = new Writable({
    write(chunk, encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  sink.text = () => chunks.join('');
  return sink;
}

export async function runCli(argv, options = {}) {
  const { runCli: execute } = await import('../../dist/test-lib.mjs');
  const stdout = options.stdout ?? capture();
  const stderr = options.stderr ?? capture();
  const stdin = options.stdin ?? { isTTY: false };
  if (options.env !== undefined) {
    const previous = process.env;
    process.env = { ...previous, ...options.env };
    try {
      const code = await execute(argv, { stdout, stderr, stdin });
      return { code, stdout: stdout.text(), stderr: stderr.text() };
    } finally {
      process.env = previous;
    }
  }
  const code = await execute(argv, { stdout, stderr, stdin });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

export { createApi };