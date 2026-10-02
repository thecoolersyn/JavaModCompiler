import fs from 'node:fs';
import { openZip } from './zip.js';

export type ManifestAttributes = Record<string, string>;

function unfoldManifest(content: string): string {
  const lines = content.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    if (line.startsWith(' ') && out.length > 0) {
      out[out.length - 1] = `${out[out.length - 1] as string}${line.slice(1)}`;
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

export function parseManifestText(content: string): ManifestAttributes {
  const unfolded = unfoldManifest(content);
  const attributes: ManifestAttributes = {};
  for (const line of unfolded.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key.length === 0) continue;
    if (attributes[key] !== undefined) {
      attributes[key] = `${attributes[key]}\n${value}`;
      continue;
    }
    attributes[key] = value;
  }
  return attributes;
}

export function readJarManifest(filePath: string): ManifestAttributes | undefined {
  try {
    const archive = openZip(filePath);
    const entry = archive.entries.find((candidate) => candidate.name.toLowerCase() === 'meta-inf/manifest.mf');
    if (entry === undefined) return undefined;
    return parseManifestText(archive.read(entry).toString('utf8'));
  } catch {
    return undefined;
  }
}

export function readManifestText(filePath: string): string | undefined {
  try {
    const archive = openZip(filePath);
    const entry = archive.entries.find((candidate) => candidate.name.toLowerCase() === 'meta-inf/manifest.mf');
    if (entry === undefined) return undefined;
    return archive.read(entry).toString('utf8');
  } catch {
    return undefined;
  }
}

export function jarBaseName(filePath: string): string {
  return filePath.replace(/[\\/]+$/, '').split(/[\\/]/).pop()?.replace(/\.jar$/, '') ?? '';
}

export function fileSizeOf(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}