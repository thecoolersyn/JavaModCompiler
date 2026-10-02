import { existsSync, readFileSync, statSync } from 'node:fs';

interface CentralEntry {
  id: string;
  latest: string;
  versions: string[];
  lastUpdated?: string;
}

let directoryCache: Map<string, CentralEntry> | undefined;
let baseUrl = 'https://repo1.maven.org/maven2';
let loaded = false;

export function resetDirectoryCache(): void {
  directoryCache = undefined;
  loaded = false;
}

export function setMavenCentralBaseUrl(url: string): void {
  baseUrl = url.replace(/\/+$/, '');
  resetDirectoryCache();
}

export function mavenCentralBaseUrl(): string {
  return baseUrl;
}

async function fetchDirectory(groupPath: string, artifactId: string): Promise<CentralEntry | undefined> {
  const url = `${baseUrl}/${groupPath}/${artifactId}/maven-metadata.xml`;
  try {
    const response = await fetch(url, { headers: { accept: 'application/xml' }, signal: AbortSignal.timeout(20_000) });
    if (!response.ok) return undefined;
    const text = await response.text();
    return parseMavenMetadata(text);
  } catch {
    return undefined;
  }
}

export function parseMavenMetadata(xml: string): CentralEntry | undefined {
  const versionMatches = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((match) => match[1] as string);
  const latest = /<latest>([^<]+)<\/latest>/.exec(xml)?.[1];
  const releaseMatch = /<release>([^<]+)<\/release>/.exec(xml);
  const lastUpdated = /<lastUpdated>([^<]+)<\/lastUpdated>/.exec(xml)?.[1];
  if (versionMatches.length === 0 && latest === undefined) return undefined;
  const id = /<id>([^<]+)<\/id>/.exec(xml)?.[1] ?? '';
  return {
    id,
    latest: releaseMatch?.[1] ?? latest ?? (versionMatches[versionMatches.length - 1] ?? ''),
    versions: versionMatches,
    lastUpdated,
  };
}

export async function getMavenDirectory(
  groupId: string,
  artifactId: string,
  options: { offline?: boolean; refresh?: boolean } = {},
): Promise<CentralEntry | undefined> {
  if (!loaded || directoryCache === undefined) {
    directoryCache = new Map();
    loaded = true;
  }
  const key = `${groupId}:${artifactId}`;
  if (options.refresh !== true && directoryCache.has(key)) return directoryCache.get(key);
  if (options.offline === true) return directoryCache.get(key);
  const entry = await fetchDirectory(groupId.replace(/\./g, '/'), artifactId);
  if (entry !== undefined) directoryCache.set(key, entry);
  return entry;
}

const localRepositoryRoots = (): string[] => {
  const roots: string[] = [];
  if (process.env.JMC_MAVEN_LOCAL !== undefined) roots.push(process.env.JMC_MAVEN_LOCAL);
  if (process.env.M2_REPO !== undefined) roots.push(process.env.M2_REPO);
  const mavenLocal = process.env['maven.repo.local'];
  if (mavenLocal !== undefined && mavenLocal.length > 0) roots.push(mavenLocal);
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (home !== undefined) {
    roots.push(`${home}/.m2/repository`);
    if (process.platform === 'win32') roots.push(`${home}\\.m2\\repository`);
  }
  return roots.filter((entry) => entry.length > 0);
};

export function findInLocalMavenRepositories(relativePath: string): string | undefined {
  for (const root of localRepositoryRoots()) {
    const candidate = `${root.replace(/[\\/]+$/, '')}/${relativePath}`;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return undefined;
}

export function localMavenRepositoryRoot(): string | undefined {
  return localRepositoryRoots()[0];
}

export function readPomIfPresent(jarPath: string): string | undefined {
  const directory = jarPath.replace(/[\\/][^\\/]+$/, '');
  const siblingPom = `${directory}/${jarPath.split(/[\\/]/).pop()?.replace(/\.jar$/, '.pom') ?? ''}`;
  if (existsSync(siblingPom)) {
    try {
      return readFileSync(siblingPom, 'utf8');
    } catch {
      return undefined;
    }
  }
  return undefined;
}