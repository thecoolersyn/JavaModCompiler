import path from 'node:path';
import type { Logger } from '../logging/logger.js';
import { defaultFileSystem } from '../platform/fs.js';
import { createPaths, type JmcPaths } from '../platform/paths.js';
import {
  equalsIgnoreCase,
  sha256Buffer,
  sha256File,
  type DownloadOptions,
} from '../net/download.js';
import { extractArchive, archiveKindOf } from '../net/archive.js';
import { detectPlatform } from '../platform/os.js';

export interface CacheEntryMeta {
  url?: string;
  checksum?: string;
  checksumAlgorithm?: 'sha256' | 'sha1' | 'md5';
  toolchainKey?: string;
  kind: string;
  storedAt: number;
  sizeBytes: number;
  version: number;
  notes?: string;
}

export interface CacheLookup {
  hit: boolean;
  path?: string;
  meta?: CacheEntryMeta;
  reason?: string;
}

const CACHE_FORMAT_VERSION = 1;

export interface CacheOptions {
  paths: JmcPaths;
  logger: Logger;
  offline: boolean;
  noCache: boolean;
}

export class ContentCache {
  private readonly options: CacheOptions;
  private readonly fs = defaultFileSystem;

  constructor(options: CacheOptions) {
    this.options = options;
  }

  private get enabled(): boolean {
    return this.options.noCache !== true;
  }

  sectionRoot(section: string): string {
    return path.join(this.options.paths.cache, section);
  }

  private metaPathFor(target: string, toolchainKey?: string): string {
    if (toolchainKey === undefined) return `${target}.jmc-meta.json`;
    const directory = path.join(path.dirname(target), '.jmc-toolchains', toolchainKey);
    this.fs.ensureDir(directory);
    return path.join(directory, `${path.basename(target)}.meta.json`);
  }

  private scopedTarget(target: string, toolchainKey?: string): string {
    if (toolchainKey === undefined) return target;
    const directory = path.join(path.dirname(target), '.jmc-toolchains', toolchainKey);
    this.fs.ensureDir(directory);
    return path.join(directory, path.basename(target));
  }

  lookup(target: string, toolchainKey?: string): CacheLookup {
    if (!this.enabled) return { hit: false, reason: 'cache disabled by --no-cache' };
    const scoped = this.scopedTarget(target, toolchainKey);
    if (!this.fs.isFile(scoped)) return { hit: false, reason: 'not cached' };
    const metaPath = this.metaPathFor(target, toolchainKey);
    let meta: CacheEntryMeta | undefined;
    if (this.fs.isFile(metaPath)) {
      try {
        meta = JSON.parse(this.fs.readText(metaPath)) as CacheEntryMeta;
      } catch {
        this.remove(target, toolchainKey);
        return { hit: false, reason: 'cache metadata was corrupt and has been removed' };
      }
      if (meta.version !== CACHE_FORMAT_VERSION) {
        this.remove(target, toolchainKey);
        return { hit: false, reason: 'cache entry was written by an incompatible JMC cache format' };
      }
      if (toolchainKey !== undefined && meta.toolchainKey !== undefined && meta.toolchainKey !== toolchainKey) {
        this.remove(target, toolchainKey);
        return { hit: false, reason: 'cache entry belongs to a different toolchain' };
      }
      if (meta.checksum !== undefined && meta.checksumAlgorithm === 'sha256') {
        let actual: string;
        try {
          actual = sha256File(scoped);
        } catch {
          this.remove(target, toolchainKey);
          return { hit: false, reason: 'cached file could not be read and has been removed' };
        }
        if (!equalsIgnoreCase(actual, meta.checksum)) {
          this.remove(target, toolchainKey);
          return { hit: false, reason: 'cached file failed checksum validation and has been removed' };
        }
      }
      const stat = this.fs.stat(scoped);
      if (meta.sizeBytes !== 0 && stat.size !== meta.sizeBytes) {
        this.remove(target, toolchainKey);
        return { hit: false, reason: 'cached file size differs from recorded metadata' };
      }
    }
    return { hit: true, path: scoped, meta };
  }

  store(target: string, meta: Omit<CacheEntryMeta, 'version' | 'storedAt' | 'sizeBytes'>, toolchainKey?: string): CacheLookup {
    if (!this.enabled) return { hit: false, reason: 'cache disabled by --no-cache' };
    const scoped = this.scopedTarget(target, toolchainKey);
    if (this.fs.isFile(target) && scoped !== target) this.fs.copy(target, scoped);
    const complete: CacheEntryMeta = {
      ...meta,
      version: CACHE_FORMAT_VERSION,
      storedAt: Date.now(),
      sizeBytes: this.fs.stat(scoped).size,
    };
    this.fs.writeText(this.metaPathFor(target, toolchainKey), JSON.stringify(complete, null, 2));
    return { hit: true, path: scoped, meta: complete };
  }

  async materialize(
    target: string,
    meta: Omit<CacheEntryMeta, 'version' | 'storedAt' | 'sizeBytes'>,
    fetcher: () => Promise<void>,
    toolchainKey?: string,
  ): Promise<CacheLookup> {
    const existing = this.lookup(target, toolchainKey);
    if (existing.hit) return existing;
    await fetcher();
    return this.store(target, meta, toolchainKey);
  }

  remove(target: string, toolchainKey?: string): void {
    const scoped = this.scopedTarget(target, toolchainKey);
    this.fs.remove(scoped);
    this.fs.remove(this.metaPathFor(target, toolchainKey));
  }

  verify(target: string, expectedChecksum: string): { valid: boolean; actual?: string; reason?: string } {
    if (!this.fs.isFile(target)) return { valid: false, reason: 'file does not exist' };
    const actual = sha256File(target);
    return equalsIgnoreCase(actual, expectedChecksum)
      ? { valid: true, actual }
      : { valid: false, actual, reason: `expected ${expectedChecksum}, computed ${actual}` };
  }

  checksumOf(target: string): string {
    return sha256File(target);
  }

  downloadOptionsFor(section: string, stage?: string): DownloadOptions {
    return {
      logger: this.options.logger,
      offline: this.options.offline,
      stage,
    };
  }

  extractTo(archivePath: string, destination: string): Promise<{ files: string[]; directories: string[]; symlinks: string[] }> {
    return extractArchive(archivePath, destination);
  }

  archiveKind(archivePath: string): 'zip' | 'tar' | 'tar.gz' | 'unknown' {
    return archiveKindOf(archivePath);
  }

  checksumOfBuffer(buffer: Buffer): string {
    return sha256Buffer(buffer);
  }

  platformTag(): string {
    const platform = detectPlatform();
    return `${platform.os}-${platform.arch}-${platform.libc}`;
  }

  purgeSection(section: string): number {
    const root = this.sectionRoot(section);
    if (!this.fs.isDirectory(root)) return 0;
    const size = this.fs.sizeOfDirectory(root);
    this.fs.remove(root);
    this.fs.ensureDir(root);
    return size;
  }

  stats(): { section: string; bytes: number; exists: boolean }[] {
    const sections = ['maven', 'minecraft', 'mappings', 'loaders', 'gradle', 'java', 'transformed', 'remapped', 'artifacts'];
    return sections.map((section) => ({
      section,
      bytes: this.fs.isDirectory(this.sectionRoot(section)) ? this.fs.sizeOfDirectory(this.sectionRoot(section)) : 0,
      exists: this.fs.isDirectory(this.sectionRoot(section)),
    }));
  }

  defaultPaths(): JmcPaths {
    return createPaths();
  }
}

export function cacheEntryKey(parts: Array<string | number | undefined>): string {
  return parts.map((part) => (part === undefined ? '_' : String(part))).join(':');
}