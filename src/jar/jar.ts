import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { defaultFileSystem, type FileSystem } from '../platform/fs.js';
import { createZip, openZip, crc32 } from './zip.js';
import type { ZipWriteEntry } from './zip.js';

export interface JarEntryInput {
  name: string;
  data: Buffer;
  mode?: number;
  storeOnly?: boolean;
}

export interface JarWriteOptions {
  manifest?: string;
  storeOnly?: boolean;
  deterministic?: boolean;
  modificationTime?: Date;
}

export interface JarWriteResult {
  file: string;
  entryCount: number;
  bytesWritten: number;
  manifestIncluded: boolean;
}

export function collectFiles(root: string, baseDirectory?: string, fsImpl: FileSystem = defaultFileSystem): JarEntryInput[] {
  const base = baseDirectory ?? root;
  const entries: JarEntryInput[] = [];
  const walk = (directory: string, prefix: string): void => {
    for (const entry of fsImpl.readDir(directory)) {
      const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory) {
        walk(entry.path, relative);
        continue;
      }
      if (entry.isFile) {
        entries.push({ name: relative, data: fs.readFileSync(entry.path) });
      }
    }
  };
  walk(root, '');
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

export function writeJar(destination: string, entries: JarEntryInput[], options: JarWriteOptions = {}): JarWriteResult {
  const fs = defaultFileSystem;
  const writeEntries: ZipWriteEntry[] = [];
  const seen = new Set<string>();
  if (options.manifest !== undefined) {
    const normalized = options.manifest.replace(/\r?\n/g, '\r\n').replace(/\r?\r?\n/g, '\r\n');
    writeEntries.push({ name: 'META-INF/MANIFEST.MF', data: Buffer.from(normalized, 'utf8'), mode: 0o100644 });
    seen.add('META-INF/MANIFEST.MF');
  }
  for (const entry of entries) {
    if (seen.has(entry.name)) continue;
    seen.add(entry.name);
    writeEntries.push({ name: entry.name, data: entry.data, mode: entry.mode, storeOnly: entry.storeOnly });
  }
  const result = createZip(destination, writeEntries, {
    storeOnly: options.storeOnly,
    modificationTime: options.modificationTime ?? (options.deterministic === true ? new Date(0) : undefined),
  });
  fs.ensureDir(path.dirname(destination));
  return {
    file: destination,
    entryCount: result.entryCount,
    bytesWritten: result.bytesWritten,
    manifestIncluded: options.manifest !== undefined,
  };
}

export interface JarInspection {
  file: string;
  entryCount: number;
  classCount: number;
  resourceCount: number;
  directories: string[];
  classes: string[];
  resources: string[];
  hasManifest: boolean;
  sizeBytes: number;
  crcOk: boolean;
}

export function inspectJar(filePath: string): JarInspection {
  const archive = openZip(filePath);
  const classes: string[] = [];
  const resources: string[] = [];
  const directories: string[] = [];
  for (const entry of archive.entries) {
    if (entry.isDirectory) {
      directories.push(entry.name);
      continue;
    }
    if (entry.name.toLowerCase().endsWith('.class')) classes.push(entry.name);
    else resources.push(entry.name);
  }
  let crcOk = true;
  try {
    for (const entry of archive.entries) {
      if (entry.isDirectory) continue;
      const data = archive.read(entry);
      if (crc32(data) !== entry.crc32) {
        crcOk = false;
        break;
      }
    }
  } catch {
    crcOk = false;
  }
  return {
    file: filePath,
    entryCount: archive.entries.filter((entry) => !entry.isDirectory).length,
    classCount: classes.length,
    resourceCount: resources.length,
    directories,
    classes: classes.sort(),
    resources: resources.sort(),
    hasManifest: archive.has('META-INF/MANIFEST.MF') || archive.has('meta-inf/manifest.mf'),
    sizeBytes: fs.statSync(filePath).size,
    crcOk,
  };
}

export function extractJar(filePath: string, destination: string, filter?: (name: string) => boolean): number {
  const fs = defaultFileSystem;
  const archive = openZip(filePath);
  let count = 0;
  for (const entry of archive.entries) {
    if (entry.isDirectory) continue;
    if (filter !== undefined && !filter(entry.name)) continue;
    const target = path.join(destination, entry.name.split('/').join(path.sep));
    const resolvedRoot = path.resolve(destination);
    const resolvedTarget = path.resolve(target);
    if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(resolvedRoot + path.sep)) continue;
    fs.writeBytes(target, archive.read(entry));
    count += 1;
  }
  return count;
}

export function buildManifest(options: {
  manifestVersion?: string;
  mainClass?: string;
  attributes?: Record<string, string | undefined>;
  extraSections?: Array<{ name: string; lines: string[] }>;
}): string {
  const lines: string[] = [];
  lines.push(`Manifest-Version: ${options.manifestVersion ?? '1.0'}`);
  if (options.mainClass !== undefined) lines.push(`Main-Class: ${options.mainClass}`);
  for (const [key, value] of Object.entries(options.attributes ?? {})) {
    if (value === undefined) continue;
    lines.push(`${key}: ${value}`);
  }
  for (const section of options.extraSections ?? []) {
    lines.push('');
    lines.push(`Name: ${section.name}`);
    for (const line of section.lines) lines.push(line);
  }
  lines.push('');
  return lines.join('\r\n');
}

export function writeJarFromDirectory(
  sourceDirectory: string,
  destination: string,
  options: JarWriteOptions & { exclude?: string[] } = {},
): JarWriteResult {
  const fs = defaultFileSystem;
  const excludes = options.exclude ?? [];
  const all = collectFiles(sourceDirectory, undefined, fs);
  const filtered = all.filter((entry) => !excludes.some((pattern) => entry.name === pattern || entry.name.startsWith(pattern)));
  return writeJar(destination, filtered, options);
}

export function zipIsValid(filePath: string): { valid: boolean; reason?: string } {
  try {
    const archive = openZip(filePath);
    if (archive.entries.length === 0) return { valid: false, reason: 'archive contains no entries' };
    for (const entry of archive.entries) {
      if (entry.isDirectory) continue;
      archive.read(entry);
    }
    return { valid: true };
  } catch (error) {
    return { valid: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export function compressResource(buffer: Buffer): Buffer {
  return zlib.deflateRawSync(buffer, { level: 9 });
}

export function jarEntryNames(filePath: string): string[] {
  try {
    return openZip(filePath)
      .entries.filter((entry) => !entry.isDirectory)
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}