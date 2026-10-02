import path from 'node:path';
import fs from 'node:fs';
import type { Logger } from '../logging/logger.js';
import type { ContentCache } from '../cache/cache.js';
import type { JmcPaths } from '../platform/paths.js';
import type { FileSystem } from '../platform/fs.js';
import { defaultFileSystem } from '../platform/fs.js';
import { extractArchive } from '../net/archive.js';
import { openZip } from '../jar/zip.js';
import { jarBaseName } from '../jar/manifest.js';
import { readJarManifest } from '../jar/manifest.js';

export interface LocalJarResolverOptions {
  paths: JmcPaths;
  logger: Logger;
  cache: ContentCache;
  offline: boolean;
  fsImpl?: FileSystem;
}

export interface LocalJarInfo {
  path: string;
  groupId?: string;
  artifactId: string;
  version?: string;
  manifest?: Record<string, string>;
  nestedJars: string[];
  isModJar: boolean;
  loader?: string;
}

export interface LocalJarResolution {
  file: string;
  origin: string;
  coordinate?: string;
  included: boolean;
  reason: string;
}

export class LocalJarResolver {
  private readonly options: LocalJarResolverOptions;
  private readonly fs: FileSystem;

  constructor(options: LocalJarResolverOptions) {
    this.options = options;
    this.fs = options.fsImpl ?? defaultFileSystem;
  }

  resolveLocalJar(absolutePath: string, projectRoot: string): string | undefined {
    const resolution = this.resolve(absolutePath, projectRoot);
    return resolution.included ? resolution.file : undefined;
  }

  resolve(absolutePath: string, projectRoot: string): LocalJarResolution {
    const fs = this.fs;
    if (!fs.isFile(absolutePath)) {
      return { file: absolutePath, origin: 'local', included: false, reason: 'file does not exist' };
    }
    const origin = path.relative(projectRoot, absolutePath).split(path.sep).join('/');
    const info = this.inspect(absolutePath);
    const isSourcesOrJavadoc = /-(sources|javadoc)\.jar$/i.test(absolutePath);
    if (isSourcesOrJavadoc) {
      return { file: absolutePath, origin, included: false, reason: 'sources or javadoc archive' };
    }
    void info;
    return { file: absolutePath, origin, included: true, reason: 'local jar on the compile classpath' };
  }

  inspect(absolutePath: string): LocalJarInfo {
    const fs = this.fs;
    const info: LocalJarInfo = {
      path: absolutePath,
      artifactId: jarBaseName(absolutePath),
      nestedJars: [],
      isModJar: false,
    };
    if (!fs.isFile(absolutePath)) return info;
    info.manifest = readJarManifest(absolutePath);
    try {
      const archive = openZip(absolutePath);
      const names = archive.entries.map((entry) => entry.name);
      info.isModJar = names.some((name) =>
        /^(fabric\.mod\.json|META-INF\/mods\.toml|META-INF\/neoforge\.mods\.toml|quilt\.mod\.json)$/i.test(name),
      );
      info.nestedJars = names.filter((name) => /META-INF\/jar\/.*\.jar$/i.test(name));
      if (info.manifest?.['Bundle-SymbolicName'] !== undefined) info.loader = 'osgi';
      else if (names.some((name) => /fabric\.mod\.json/i.test(name))) info.loader = 'fabric';
      else if (names.some((name) => /neoforge\.mods\.toml/i.test(name))) info.loader = 'neoforge';
      else if (names.some((name) => /(^|\/)mods\.toml$/i.test(name))) info.loader = 'forge';
      else if (names.some((name) => /quilt\.mod\.json/i.test(name))) info.loader = 'quilt';
    } catch (error) {
      void error;
    }
    const mavenCoordinates = /\d+\.\d+[.\w-]*/.exec(path.basename(absolutePath));
    if (mavenCoordinates !== null) info.version = mavenCoordinates[0];
    const parentDirectory = path.basename(path.dirname(absolutePath));
    if (/^[\w.-]+$/i.test(parentDirectory) && parentDirectory.includes('.')) info.groupId = parentDirectory;
    return info;
  }

  extractNestedJars(absolutePath: string, destination: string): string[] {
    const fs = this.fs;
    if (!fs.isFile(absolutePath)) return [];
    fs.ensureDir(destination);
    const extracted: string[] = [];
    try {
      const archive = openZip(absolutePath);
      for (const entry of archive.entries) {
        if (entry.isDirectory) continue;
        if (!/META-INF\/jar\/.*\.jar$/i.test(entry.name)) continue;
        const target = path.join(destination, path.basename(entry.name));
        fs.writeBytes(target, archive.read(entry));
        extracted.push(target);
      }
    } catch {
      return extracted;
    }
    return extracted;
  }

  cacheLocalArchive(absolutePath: string): string | undefined {
    const fs = this.fs;
    if (!fs.isFile(absolutePath)) return undefined;
    const target = path.join(this.options.paths.cacheArtifacts, 'local', path.basename(absolutePath));
    const lookup = this.options.cache.lookup(target);
    if (lookup.hit) return lookup.path;
    fs.ensureDir(path.dirname(target));
    fs.copy(absolutePath, target);
    this.options.cache.store(target, { kind: 'local-jar' });
    return target;
  }

  unpackArchive(archivePath: string, destination: string): Promise<{ files: string[]; directories: string[]; symlinks: string[] }> {
    return extractArchive(archivePath, destination);
  }

  scanForModJars(projectRoot: string): LocalJarInfo[] {
    const fs = this.fs;
    const jars = fs
      .findFiles(projectRoot, (relative) => relative.toLowerCase().endsWith('.jar'), 8)
      .filter((relative) => !relative.includes('/build/') && !relative.includes('/target/'));
    return jars.map((relative) => this.inspect(path.join(projectRoot, relative.split('/').join(path.sep))));
  }

  describe(info: LocalJarInfo): string[] {
    const lines = [`${info.artifactId}${info.version === undefined ? '' : `:${info.version}`}`];
    if (info.loader !== undefined) lines.push(`  loader: ${info.loader}`);
    if (info.nestedJars.length > 0) lines.push(`  nested jars: ${info.nestedJars.length}`);
    return lines;
  }
}

export function readNestedJarNames(jarPath: string): string[] {
  try {
    return openZip(jarPath)
      .entries.map((entry) => entry.name)
      .filter((name) => /META-INF\/jar\//i.test(name));
  } catch {
    return [];
  }
}

export function fileSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}