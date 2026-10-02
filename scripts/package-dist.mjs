import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const bundle = path.join(root, 'dist', 'bin', 'jmc.mjs');

const target = process.argv[2] ?? path.join(root, 'dist');
const packageRoot = root;
const version = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).version;
const platformToken = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
const archToken = process.arch === 'arm64' ? 'arm64' : 'x64';

const OUT_DIR = path.join(target, `jmc-${version}-${platformToken}-${archToken}`);
const BIN_DIR = path.join(OUT_DIR, 'bin');
const DOCS_DIR = path.join(OUT_DIR, 'docs');

const ZIP_EPOCH = new Date(0);

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

function collectFiles(root, filter) {
  const files = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (entry.isFile() && filter(absolute)) files.push(absolute);
    }
  };
  walk(root);
  return files;
}

function zipEntries(files) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const raw = fs.readFileSync(file);
    const name = path.relative(OUT_DIR, file).split(path.sep).join('/');
    const nameBuffer = Buffer.from(name, 'utf8');
    const deflated = zlib.deflateRawSync(raw, { level: 9 });
    const checksum = crc32(raw);
    const isDirectory = name.endsWith('/');
    const payload = isDirectory || deflated.length >= raw.length ? raw : deflated;
    const method = payload === raw ? 0 : 8;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(33, 12);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(payload.length, 18);
    header.writeUInt32LE(raw.length, 22);
    header.writeUInt16LE(nameBuffer.length, 26);
    header.writeUInt16LE(0, 28);
    local.push(header, nameBuffer, payload);

    const directoryEntry = Buffer.alloc(46);
    directoryEntry.writeUInt32LE(0x02014b50, 0);
    directoryEntry.writeUInt16LE((3 << 8) | 20, 4);
    directoryEntry.writeUInt16LE(20, 6);
    directoryEntry.writeUInt16LE(0, 8);
    directoryEntry.writeUInt16LE(method, 10);
    directoryEntry.writeUInt16LE(0, 12);
    directoryEntry.writeUInt16LE(33, 14);
    directoryEntry.writeUInt32LE(checksum, 16);
    directoryEntry.writeUInt32LE(payload.length, 20);
    directoryEntry.writeUInt32LE(raw.length, 24);
    directoryEntry.writeUInt16LE(nameBuffer.length, 28);
    directoryEntry.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    directoryEntry.writeUInt32LE(offset, 42);
    central.push(directoryEntry, nameBuffer);

    offset += header.length + nameBuffer.length + payload.length;
  }
  const centralBuffer = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(central.length / 2, 8);
  eocd.writeUInt16LE(central.length / 2, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...local, centralBuffer, eocd]);
}

if (!fs.existsSync(bundle)) {
  process.stderr.write(`bundle missing at ${bundle}; run npm run build first\n`);
  process.exit(1);
}

fs.rmSync(OUT_DIR, { recursive: true, force: true });
fs.mkdirSync(BIN_DIR, { recursive: true });

for (const name of ['jmc', 'jmc.sh', 'jmc.cmd', 'jmc.ps1', 'jmc.mjs']) {
  const from = path.join(root, 'dist', 'bin', name);
  if (!fs.existsSync(from)) continue;
  fs.copyFileSync(from, path.join(BIN_DIR, name));
  if (process.platform !== 'win32' && (name === 'jmc' || name === 'jmc.sh')) {
    fs.chmodSync(path.join(BIN_DIR, name), 0o755);
  }
}

for (const script of ['install.sh', 'install.ps1', 'install-npm.sh']) {
  const from = path.join(packageRoot, 'scripts', script);
  if (!fs.existsSync(from)) continue;
  fs.copyFileSync(from, path.join(OUT_DIR, script));
  if (process.platform !== 'win32') fs.chmodSync(path.join(OUT_DIR, script), 0o755);
}

fs.mkdirSync(DOCS_DIR, { recursive: true });
for (const name of ['README.md', 'ARCHITECTURE.md', 'CONTRIBUTING.md']) {
  const from = path.join(packageRoot, name);
  if (fs.existsSync(from)) fs.copyFileSync(from, path.join(DOCS_DIR, name));
}
const docsSource = path.join(packageRoot, 'docs');
if (fs.existsSync(docsSource)) {
  for (const file of collectFiles(docsSource, () => true)) {
    const destination = path.join(DOCS_DIR, 'docs', path.relative(docsSource, file));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(file, destination);
  }
}

fs.writeFileSync(
  path.join(OUT_DIR, 'install.json'),
  `${JSON.stringify({ name: 'jmc', version, platform: platformToken, arch: archToken, node: '>=20.10.0', createdAt: ZIP_EPOCH.toISOString() }, null, 2)}\n`,
  'utf8',
);

const archiveFiles = collectFiles(OUT_DIR, (file) => !file.endsWith('.zip'));
const archivePath = `${OUT_DIR}.zip`;
fs.writeFileSync(archivePath, zipEntries(archiveFiles));

process.stdout.write(`packaged ${path.basename(OUT_DIR)}\n`);
process.stdout.write(`  directory: ${OUT_DIR}\n`);
process.stdout.write(`  archive:    ${archivePath}\n`);
process.stdout.write(`  entries:    ${archiveFiles.length}\n`);
process.stdout.write(`  size:       ${fs.statSync(archivePath).size} bytes\n`);

void os;