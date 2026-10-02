import fs, { type Dirent } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectPlatform } from './os.js';

export interface JmcPaths {
  home: string;
  bin: string;
  cache: string;
  cacheMaven: string;
  cacheMinecraft: string;
  cacheMappings: string;
  cacheLoaders: string;
  cacheGradle: string;
  cacheJava: string;
  cacheTransformed: string;
  cacheRemapped: string;
  cacheArtifacts: string;
  runtimes: string;
  plugins: string;
  workspaces: string;
  sandboxes: string;
  logs: string;
  reports: string;
  approvals: string;
  toolchains: string;
}

export type PathSection =
  | 'bin'
  | 'cache'
  | 'cacheMaven'
  | 'cacheMinecraft'
  | 'cacheMappings'
  | 'cacheLoaders'
  | 'cacheGradle'
  | 'cacheJava'
  | 'cacheTransformed'
  | 'cacheRemapped'
  | 'cacheArtifacts'
  | 'runtimes'
  | 'plugins'
  | 'workspaces'
  | 'sandboxes'
  | 'logs'
  | 'reports'
  | 'approvals'
  | 'toolchains';

export function resolveJmcHome(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.JMC_HOME;
  if (explicit !== undefined && explicit.length > 0) return path.resolve(explicit);
  if (detectPlatform().os === 'win32') {
    const base = env.LOCALAPPDATA ?? env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, '.umc');
  }
  return path.join(os.homedir(), '.umc');
}

export function createPaths(env: NodeJS.ProcessEnv = process.env): JmcPaths {
  const home = resolveJmcHome(env);
  const cache = path.join(home, 'cache');
  return {
    home,
    bin: path.join(home, 'bin'),
    cache,
    cacheMaven: path.join(cache, 'maven'),
    cacheMinecraft: path.join(cache, 'minecraft'),
    cacheMappings: path.join(cache, 'mappings'),
    cacheLoaders: path.join(cache, 'loaders'),
    cacheGradle: path.join(cache, 'gradle'),
    cacheJava: path.join(cache, 'java'),
    cacheTransformed: path.join(cache, 'transformed'),
    cacheRemapped: path.join(cache, 'remapped'),
    cacheArtifacts: path.join(cache, 'artifacts'),
    runtimes: path.join(home, 'runtimes'),
    plugins: path.join(home, 'plugins'),
    workspaces: path.join(home, 'workspaces'),
    sandboxes: path.join(home, 'sandboxes'),
    logs: path.join(home, 'logs'),
    reports: path.join(home, 'reports'),
    approvals: path.join(home, 'approvals'),
    toolchains: path.join(home, 'toolchains'),
  };
}

const ALL_SECTIONS: PathSection[] = [
  'bin',
  'cache',
  'cacheMaven',
  'cacheMinecraft',
  'cacheMappings',
  'cacheLoaders',
  'cacheGradle',
  'cacheJava',
  'cacheTransformed',
  'cacheRemapped',
  'cacheArtifacts',
  'runtimes',
  'plugins',
  'workspaces',
  'sandboxes',
  'logs',
  'reports',
  'approvals',
  'toolchains',
];

export function ensurePathTree(paths: JmcPaths, sections: PathSection[] = ALL_SECTIONS): void {
  for (const section of sections) fs.mkdirSync(paths[section], { recursive: true });
}

function sizeOfDirectory(root: string): number {
  let total = 0;
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries: Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      try {
        total += fs.statSync(full).size;
      } catch {
        continue;
      }
    }
  }
  return total;
}

export const PATH_SECTION_LABELS: Record<PathSection, string> = {
  bin: 'bin',
  cache: 'cache (other)',
  cacheMaven: 'cache/maven',
  cacheMinecraft: 'cache/minecraft',
  cacheMappings: 'cache/mappings',
  cacheLoaders: 'cache/loaders',
  cacheGradle: 'cache/gradle',
  cacheJava: 'cache/java',
  cacheTransformed: 'cache/transformed',
  cacheRemapped: 'cache/remapped',
  cacheArtifacts: 'cache/artifacts',
  runtimes: 'runtimes',
  plugins: 'plugins',
  workspaces: 'workspaces',
  sandboxes: 'sandboxes',
  logs: 'logs',
  reports: 'reports',
  approvals: 'approvals',
  toolchains: 'toolchains',
};

export function directorySize(paths: JmcPaths): { totalBytes: number; bySection: Record<string, number> } {
  const bySection: Record<string, number> = {};
  let totalBytes = 0;
  for (const section of ALL_SECTIONS) {
    const size = sizeOfDirectory(paths[section]);
    bySection[PATH_SECTION_LABELS[section]] = size;
    totalBytes += size;
  }
  return { totalBytes, bySection };
}
