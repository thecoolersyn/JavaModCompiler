import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { defaultFileSystem } from '../platform/fs.js';

export interface ZipEntry {
  name: string;
  isDirectory: boolean;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  crc32: number;
  localHeaderOffset: number;
  externalAttributes: number;
  versionMadeBy: number;
  dosTime: number;
  dosDate: number;
}

export interface ZipArchive {
  entries: ZipEntry[];
  centralDirectoryOffset: number;
  read(entry: ZipEntry): Buffer;
  has(name: string): boolean;
  names(): string[];
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const ZIP64_EOCD_LOCATOR = 0x07064b50;
const ZIP64_EOCD = 0x06064b50;

let crcTable: Uint32Array | undefined;

export function crc32(buffer: Buffer): number {
  if (crcTable === undefined) {
    crcTable = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) {
        value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      crcTable[index] = value >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index += 1) {
    crc = (crcTable[(crc ^ (buffer[index] as number)) & 0xff] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export class ZipFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipFormatError';
  }
}

export function openZip(filePath: string): ZipArchive {
  const buffer = fs.readFileSync(filePath);
  return parseZipBuffer(buffer);
}

export function parseZipBuffer(buffer: Buffer): ZipArchive {
  let eocdOffset = -1;
  const lowerBound = Math.max(0, buffer.length - 66_000);
  for (let index = buffer.length - 22; index >= lowerBound; index -= 1) {
    if (buffer.readUInt32LE(index) === EOCD_SIGNATURE) {
      eocdOffset = index;
      break;
    }
  }
  if (eocdOffset === -1) throw new ZipFormatError('End of central directory record not found');

  let entryCount = buffer.readUInt16LE(eocdOffset + 10);
  let centralOffset = buffer.readUInt32LE(eocdOffset + 16);
  let centralSize = buffer.readUInt32LE(eocdOffset + 12);

  const locatorOffset = eocdOffset - 20;
  if (locatorOffset >= 0 && buffer.readUInt32LE(locatorOffset) === ZIP64_EOCD_LOCATOR) {
    const zip64Offset = Number(buffer.readBigUInt64LE(locatorOffset + 8));
    if (zip64Offset >= 0 && zip64Offset + 56 <= buffer.length && buffer.readUInt32LE(zip64Offset) === ZIP64_EOCD) {
      entryCount = Number(buffer.readBigUInt64LE(zip64Offset + 32));
      centralSize = Number(buffer.readBigUInt64LE(zip64Offset + 40));
      centralOffset = Number(buffer.readBigUInt64LE(zip64Offset + 48));
    }
  }

  const entries: ZipEntry[] = [];
  let pointer = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (pointer + 46 > buffer.length) break;
    if (buffer.readUInt32LE(pointer) !== CENTRAL_SIGNATURE) break;
    const versionMadeBy = buffer.readUInt16LE(pointer + 4);
    const compressionMethod = buffer.readUInt16LE(pointer + 10);
    const dosTime = buffer.readUInt16LE(pointer + 12);
    const dosDate = buffer.readUInt16LE(pointer + 14);
    let compressedSize = buffer.readUInt32LE(pointer + 20);
    let uncompressedSize = buffer.readUInt32LE(pointer + 24);
    const nameLength = buffer.readUInt16LE(pointer + 28);
    const extraLength = buffer.readUInt16LE(pointer + 30);
    const commentLength = buffer.readUInt16LE(pointer + 32);
    const externalAttributes = buffer.readUInt32LE(pointer + 38);
    let localHeaderOffset = buffer.readUInt32LE(pointer + 42);
    const name = buffer.subarray(pointer + 46, pointer + 46 + nameLength).toString('utf8');
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
      const extraStart = pointer + 46 + nameLength;
      let extraPointer = extraStart;
      while (extraPointer < extraStart + extraLength) {
        const headerId = buffer.readUInt16LE(extraPointer);
        const dataSize = buffer.readUInt16LE(extraPointer + 2);
        if (headerId === 0x0001) {
          let fieldOffset = extraPointer + 4;
          if (uncompressedSize === 0xffffffff) {
            uncompressedSize = Number(buffer.readBigUInt64LE(fieldOffset));
            fieldOffset += 8;
          }
          if (compressedSize === 0xffffffff) {
            compressedSize = Number(buffer.readBigUInt64LE(fieldOffset));
            fieldOffset += 8;
          }
          if (localHeaderOffset === 0xffffffff) {
            localHeaderOffset = Number(buffer.readBigUInt64LE(fieldOffset));
          }
          break;
        }
        extraPointer += 4 + dataSize;
      }
    }
    entries.push({
      name,
      isDirectory: name.endsWith('/'),
      compressionMethod,
      compressedSize,
      uncompressedSize,
      crc32: buffer.readUInt32LE(pointer + 16),
      localHeaderOffset,
      externalAttributes,
      versionMadeBy,
      dosTime,
      dosDate,
    });
    pointer += 46 + nameLength + extraLength + commentLength;
  }
  void centralSize;

  const index = new Map<string, ZipEntry>();
  for (const entry of entries) index.set(entry.name, entry);

  return {
    entries,
    centralDirectoryOffset: centralOffset,
    has: (name: string): boolean => index.has(name),
    names: (): string[] => entries.map((entry) => entry.name),
    read: (entry: ZipEntry): Buffer => {
      const localOffset = entry.localHeaderOffset;
      if (buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
        throw new ZipFormatError(`Local header signature mismatch for ${entry.name}`);
      }
      const nameLength = buffer.readUInt16LE(localOffset + 26);
      const extraLength = buffer.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + nameLength + extraLength;
      const raw = buffer.subarray(dataStart, dataStart + entry.compressedSize);
      let data: Buffer;
      if (entry.compressionMethod === 0) data = Buffer.from(raw);
      else if (entry.compressionMethod === 8) data = zlib.inflateRawSync(raw);
      else if (entry.compressionMethod === 12) {
        try {
          data = zlib.brotliDecompressSync(raw);
        } catch {
          data = Buffer.from(raw);
        }
      } else throw new ZipFormatError(`Unsupported compression method ${entry.compressionMethod} for ${entry.name}`);
      return data;
    },
  };
}

export interface ZipWriteEntry {
  name: string;
  data?: Buffer;
  sourcePath?: string;
  mode?: number;
  storeOnly?: boolean;
}

export interface ZipWriteResult {
  bytesWritten: number;
  entryCount: number;
  compressedBytes: number;
  uncompressedBytes: number;
  manifest: Array<{ name: string; crc32: number; size: number; method: number }>;
}

function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((Math.floor(date.getSeconds() / 2)) & 0x1f),
    date: (((year - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f),
  };
}

export function createZip(
  destination: string,
  entries: ZipWriteEntry[],
  options: { storeOnly?: boolean; modificationTime?: Date } = {},
): ZipWriteResult {
  const fileSystem = defaultFileSystem;
  fileSystem.ensureDir(path.dirname(destination));
  const modification = options.modificationTime ?? new Date();
  const stamp = dosDateTime(modification);
  const localChunks: Buffer[] = [];
  const centralChunks: Buffer[] = [];
  const manifest: ZipWriteResult['manifest'] = [];
  let offset = 0;
  let compressedBytes = 0;
  let uncompressedBytes = 0;

  for (const entry of entries) {
    const raw = entry.data ?? (entry.sourcePath !== undefined ? fs.readFileSync(entry.sourcePath) : Buffer.alloc(0));
    const isDirectory = entry.name.endsWith('/');
    const method: number = isDirectory || options.storeOnly === true ? 0 : 8;
    const payload: Buffer = method === 0 ? raw : deflate(raw);
    const payloadLength: number = payload.length;
    const rawLength: number = raw.length;
    const checksum = isDirectory ? 0 : crc32(raw);
    const nameBuffer = Buffer.from(entry.name, 'utf8');
    const nameLength = nameBuffer.length;
    const mode = entry.mode ?? (isDirectory ? 0o040755 : 0o100644);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(LOCAL_SIGNATURE, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(stamp.time, 10);
    localHeader.writeUInt16LE(stamp.date, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(payloadLength, 18);
    localHeader.writeUInt32LE(rawLength, 22);
    localHeader.writeUInt16LE(nameLength, 26);
    localHeader.writeUInt16LE(0, 28);

    localChunks.push(localHeader, nameBuffer);
    if (!isDirectory) localChunks.push(payload);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(CENTRAL_SIGNATURE, 0);
    centralHeader.writeUInt16LE((3 << 8) | 20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(stamp.time, 12);
    centralHeader.writeUInt16LE(stamp.date, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(payloadLength, 20);
    centralHeader.writeUInt32LE(rawLength, 24);
    centralHeader.writeUInt16LE(nameLength, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE((mode << 16) >>> 0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralChunks.push(centralHeader, nameBuffer);

    offset += localHeader.length + nameLength + (isDirectory ? 0 : payloadLength);
    compressedBytes += isDirectory ? 0 : payloadLength;
    uncompressedBytes += rawLength;
    manifest.push({ name: entry.name, crc32: checksum, size: rawLength, method });
  }

  const centralBuffer = Buffer.concat(centralChunks);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIGNATURE, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(manifest.length, 8);
  eocd.writeUInt16LE(manifest.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  const output = Buffer.concat([...localChunks, centralBuffer, eocd]);
  fs.writeFileSync(destination, output);
  return { bytesWritten: output.length, entryCount: manifest.length, compressedBytes, uncompressedBytes, manifest };
}

function deflate(buffer: Buffer): Buffer {
  if (buffer.length === 0) return buffer;
  return zlib.deflateRawSync(buffer, { level: 9 });
}

export function extractZipEntry(archive: ZipArchive, name: string): Buffer | undefined {
  const entry = archive.entries.find((candidate) => candidate.name === name);
  return entry === undefined ? undefined : archive.read(entry);
}

export function jarEntryCount(filePath: string): number {
  return openZip(filePath).entries.filter((entry) => !entry.isDirectory).length;
}

export function verifyZipCrcs(filePath: string): { ok: boolean; failures: Array<{ name: string; expected: number; actual: number }> } {
  const archive = openZip(filePath);
  const failures: Array<{ name: string; expected: number; actual: number }> = [];
  for (const entry of archive.entries) {
    if (entry.isDirectory) continue;
    try {
      const data = archive.read(entry);
      const actual = crc32(data);
      if (actual !== entry.crc32) failures.push({ name: entry.name, expected: entry.crc32, actual });
      if (data.length !== entry.uncompressedSize) {
        failures.push({ name: entry.name, expected: entry.uncompressedSize, actual: data.length });
      }
    } catch (error) {
      failures.push({ name: entry.name, expected: entry.crc32, actual: -1 });
      void error;
    }
  }
  return { ok: failures.length === 0, failures };
}

export function toUnixPath(entryName: string): string {
  return entryName.split('\\').join('/');
}

export function isSuspiciousEntryName(name: string): boolean {
  return (
    name.includes('..') ||
    name.startsWith('/') ||
    /^[A-Za-z]:/.test(name) ||
    name.includes('\0') ||
    /^\/+(tmp|var|etc|proc|sys|dev|root|home|Users)\//.test(name)
  );
}

export function readZipEntryText(filePath: string, name: string): string | undefined {
  const archive = openZip(filePath);
  const data = extractZipEntry(archive, name);
  return data === undefined ? undefined : data.toString('utf8');
}