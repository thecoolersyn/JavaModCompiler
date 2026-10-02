import path from 'node:path';
import { defaultFileSystem } from '../platform/fs.js';
import { defaultProcessRunner } from './process.js';
import type { JmcPaths } from './paths.js';

type CleanupHook = () => void | Promise<void>;

const hooks = new Set<CleanupHook>();
let installed = false;
let interrupted = false;

function removeStalePartFiles(directory: string): void {
  if (defaultFileSystem.isDirectory(directory) === false) return;
  for (const entry of defaultFileSystem.readDir(directory)) {
    const isPartFile = entry.name.includes('.part');
    if (isPartFile === false) continue;
    defaultFileSystem.remove(entry.path);
  }
}

export function sweepAbandonedPartFiles(paths: JmcPaths): void {
  for (const directory of [paths.cacheGradle, paths.cacheJava, paths.cacheMinecraft, paths.cacheLoaders, paths.cacheArtifacts]) {
    removeStalePartFiles(directory);
  }
}

export function sweepPartFilesIn(directory: string): void {
  removeStalePartFiles(directory);
}

export function registerCleanupHook(hook: CleanupHook): () => void {
  hooks.add(hook);
  return () => {
    hooks.delete(hook);
  };
}

export function isInterrupted(): boolean {
  return interrupted;
}

export function installSignalHandlers(): void {
  if (installed) return;
  installed = true;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      interrupted = true;
      void runCleanup(signal);
    });
  }
}

export async function runCleanup(reason: string): Promise<void> {
  const pending = [...hooks];
  for (const hook of pending) {
    try {
      await hook();
    } catch {
      continue;
    }
  }
  if (process.platform === 'win32') {
    for (const pid of childPids) {
      defaultProcessRunner.runSync('taskkill', ['/pid', String(pid), '/T', '/F'], { timeoutMs: 15_000 });
    }
  } else {
    for (const pid of childPids) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          continue;
        }
      }
    }
  }
  if (reason.length > 0) process.stderr.write(`\nJMC interrupted by ${reason}; cleaned up temporary state.\n`);
}

const childPids = new Set<number>();

export function trackChild(pid: number | undefined): () => void {
  if (pid === undefined || pid <= 0) return () => undefined;
  childPids.add(pid);
  return () => {
    childPids.delete(pid);
  };
}

export function workspaceCleanupHook(workspaceRoot: string, keep: boolean): () => void {
  return () => {
    if (keep) return;
    if (workspaceRoot.length === 0) return;
    defaultFileSystem.remove(path.resolve(workspaceRoot));
  };
}
