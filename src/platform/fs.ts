import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { detectPlatform, type Architecture, type OperatingSystem } from './os.js';

export interface DirEntryInfo {
  name: string;
  path: string;
  isDirectory: boolean;
  isFile: boolean;
  isSymlink: boolean;
  size: number;
  modifiedMs: number;
}

export interface StatInfo {
  exists: boolean;
  isDirectory: boolean;
  isFile: boolean;
  isSymlink: boolean;
  size: number;
  modifiedMs: number;
}

export interface WalkOptions {
  maxDepth?: number;
  followSymlinks?: boolean;
  filter?: (entry: DirEntryInfo, depth: number) => boolean;
  skipHidden?: boolean;
}

const IGNORED_DIRECTORY_NAMES = new Set([
  '.git',
  '.svn',
  '.hg',
  '.gradle',
  '.idea',
  '.vscode',
  'node_modules',
  'build',
  'out',
  'target',
  '.minecraft',
  '.fabric',
  '.quilt',
  '.neoform',
]);

const HIDDEN_DIRECTORY_NAMES = new Set(['.git', '.svn', '.hg', '.idea', '.vscode', '.gradle', '.cache']);

export class FileSystem {
  exists(target: string): boolean {
    return fs.existsSync(target);
  }

  stat(target: string): StatInfo {
    try {
      const stats = fs.lstatSync(target);
      return {
        exists: true,
        isDirectory: stats.isDirectory(),
        isFile: stats.isFile(),
        isSymlink: stats.isSymbolicLink(),
        size: stats.size,
        modifiedMs: stats.mtimeMs,
      };
    } catch {
      return { exists: false, isDirectory: false, isFile: false, isSymlink: false, size: 0, modifiedMs: 0 };
    }
  }

  isDirectory(target: string): boolean {
    return this.stat(target).isDirectory;
  }

  isFile(target: string): boolean {
    return this.stat(target).isFile;
  }

  readText(target: string): string {
    return fs.readFileSync(target, 'utf8');
  }

  readBytes(target: string): Buffer {
    return fs.readFileSync(target);
  }

  async readTextAsync(target: string): Promise<string> {
    return fsp.readFile(target, 'utf8');
  }

  async readBytesAsync(target: string): Promise<Buffer> {
    return fsp.readFile(target);
  }

  writeText(target: string, content: string): void {
    this.ensureDir(path.dirname(target));
    fs.writeFileSync(target, content, 'utf8');
  }

  async writeTextAsync(target: string, content: string): Promise<void> {
    await this.ensureDirAsync(path.dirname(target));
    await fsp.writeFile(target, content, 'utf8');
  }

  writeBytes(target: string, content: Buffer): void {
    this.ensureDir(path.dirname(target));
    fs.writeFileSync(target, content);
  }

  async writeBytesAsync(target: string, content: Buffer): Promise<void> {
    await this.ensureDirAsync(path.dirname(target));
    await fsp.writeFile(target, content);
  }

  appendText(target: string, content: string): void {
    this.ensureDir(path.dirname(target));
    fs.appendFileSync(target, content, 'utf8');
  }

  ensureDir(target: string): void {
    fs.mkdirSync(target, { recursive: true });
  }

  async ensureDirAsync(target: string): Promise<void> {
    await fsp.mkdir(target, { recursive: true });
  }

  remove(target: string): void {
    fs.rmSync(target, { recursive: true, force: true });
  }

  async removeAsync(target: string): Promise<void> {
    await fsp.rm(target, { recursive: true, force: true });
  }

  copy(source: string, destination: string): void {
    this.ensureDir(path.dirname(destination));
    fs.cpSync(source, destination, { recursive: true, dereference: true });
  }

  async copyAsync(source: string, destination: string): Promise<void> {
    await this.ensureDirAsync(path.dirname(destination));
    await fsp.cp(source, destination, { recursive: true, dereference: true });
  }

  rename(source: string, destination: string): void {
    this.ensureDir(path.dirname(destination));
    fs.renameSync(source, destination);
  }

  readDir(target: string): DirEntryInfo[] {
    let raw: fs.Dirent[];
    try {
      raw = fs.readdirSync(target, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: DirEntryInfo[] = [];
    for (const entry of raw) {
      const full = path.join(target, entry.name);
      const info = this.stat(full);
      out.push({
        name: entry.name,
        path: full,
        isDirectory: entry.isDirectory(),
        isFile: entry.isFile(),
        isSymlink: entry.isSymbolicLink(),
        size: info.size,
        modifiedMs: info.modifiedMs,
      });
    }
    return out;
  }

  walk(root: string, options: WalkOptions = {}): DirEntryInfo[] {
    const maxDepth = options.maxDepth ?? 12;
    const followSymlinks = options.followSymlinks ?? false;
    const results: DirEntryInfo[] = [];
    const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
    while (stack.length > 0) {
      const frame = stack.pop();
      if (frame === undefined) break;
      if (frame.depth > maxDepth) continue;
      for (const entry of this.readDir(frame.dir)) {
        if (entry.isDirectory && !followSymlinks && entry.isSymlink) continue;
        if (options.filter !== undefined && !options.filter(entry, frame.depth)) continue;
        if (entry.isDirectory && IGNORED_DIRECTORY_NAMES.has(entry.name) && !HIDDEN_DIRECTORY_NAMES.has(entry.name)) {
          continue;
        }
        if (options.skipHidden === true && entry.name.startsWith('.') && entry.isDirectory) continue;
        results.push(entry);
        if (entry.isDirectory) stack.push({ dir: entry.path, depth: frame.depth + 1 });
      }
    }
    return results;
  }

  findFiles(root: string, predicate: (relativePath: string) => boolean, maxDepth = 12): string[] {
    return this.walk(root, { maxDepth })
      .filter((entry) => entry.isFile)
      .map((entry) => path.relative(root, entry.path).split(path.sep).join('/'))
      .filter((relative) => predicate(relative))
      .sort();
  }

  findByName(root: string, names: string[], maxDepth = 12): string[] {
    const wanted = new Set(names.map((name) => name.toLowerCase()));
    return this.findFiles(root, (relative) => wanted.has(relative.split('/').pop()?.toLowerCase() ?? ''), maxDepth);
  }

  listJars(root: string, maxDepth = 8): string[] {
    return this.findFiles(root, (relative) => relative.toLowerCase().endsWith('.jar'), maxDepth).map(
      (relative) => path.join(root, relative.split('/').join(path.sep)),
    );
  }

  findUpwards(startDirectory: string, targetName: string): string | undefined {
    let current = path.resolve(startDirectory);
    const platform = detectPlatform();
    for (;;) {
      const candidate = path.join(current, targetName);
      if (platform.caseInsensitiveFs) {
        const entries = this.readDir(current);
        const match = entries.find((entry) => entry.name.toLowerCase() === targetName.toLowerCase());
        if (match !== undefined) return match.path;
      } else if (this.isFile(candidate)) {
        return candidate;
      }
      const parent = path.dirname(current);
      if (parent === current) return undefined;
      current = parent;
    }
  }

  sizeOfDirectory(root: string): number {
    let total = 0;
    for (const entry of this.walk(root, { maxDepth: 20 })) {
      if (entry.isFile) total += entry.size;
    }
    return total;
  }

  canWrite(target: string): boolean {
    try {
      this.ensureDir(target);
      const probe = path.join(target, `.jmc-write-probe-${process.pid}`);
      fs.writeFileSync(probe, 'ok');
      fs.unlinkSync(probe);
      return true;
    } catch {
      return false;
    }
  }

  tempDir(): string {
    return os.tmpdir();
  }
}

export const defaultFileSystem = new FileSystem();

export function normalizePathSeparators(value: string): string {
  return value.split(path.sep).join('/');
}

export type { Architecture, OperatingSystem };