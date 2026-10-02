import path from 'node:path';
import type { Logger } from '../logging/logger.js';
import type { ContentCache } from '../cache/cache.js';
import type { JmcPaths } from '../platform/paths.js';
import type { FileSystem } from '../platform/fs.js';
import { defaultFileSystem } from '../platform/fs.js';
import { downloadFile, DownloadError } from '../net/download.js';
import { parsePom, type MavenPomDependency, type MavenPomModel } from './pom-parser.js';
import { getMavenDirectory, findInLocalMavenRepositories, localMavenRepositoryRoot, setMavenCentralBaseUrl } from './maven-central.js';
import {
  formatCoordinate,
  isDynamicVersion,
  mavenBaseUrl,
  normalizeRepositoryUrl,
  parseCoordinateString,
  relativeMavenPath,
  versionMatches,
  type DependencyNode,
  type DependencyResolutionResult,
  type MavenCoordinate,
  type MavenRepository,
  type UnresolvedDependency,
} from './model.js';
import { readJarManifest } from '../jar/manifest.js';

export interface ResolverOptions {
  paths: JmcPaths;
  logger: Logger;
  cache: ContentCache;
  offline: boolean;
  fsImpl?: FileSystem;
}

export interface ResolveRequest {
  repositories: MavenRepository[];
  dependencies: Array<{ coordinate: MavenCoordinate; configuration?: string; optional?: boolean }>;
  maxDepth?: number;
  transitive?: boolean;
  readPoms?: boolean;
  exclusions?: Array<{ groupId: string; artifactId: string }>;
}

export const MAVEN_CENTRAL: MavenRepository = {
  id: 'maven-central',
  url: 'https://repo1.maven.org/maven2',
  kind: 'maven',
  priority: 10,
  source: 'builtin',
};

export const BUILTIN_REPOSITORIES: MavenRepository[] = [
  { id: 'maven-central', url: 'https://repo1.maven.org/maven2', kind: 'maven', priority: 10, source: 'builtin' },
  { id: 'fabric', url: 'https://maven.fabricmc.net/', kind: 'maven', priority: 20, source: 'builtin' },
  { id: 'forge', url: 'https://maven.minecraftforge.net/', kind: 'maven', priority: 20, source: 'builtin' },
  { id: 'neoforge', url: 'https://maven.neoforged.net/releases/', kind: 'maven', priority: 20, source: 'builtin' },
  { id: 'quilt', url: 'https://maven.quiltmc.org/repository/release/', kind: 'maven', priority: 20, source: 'builtin' },
  { id: 'jitpack', url: 'https://jitpack.io/', kind: 'maven', priority: 60, source: 'builtin' },
];

export class MavenRepositoryResolver {
  private readonly options: ResolverOptions;
  private readonly fs: FileSystem;
  private readonly resolvedFiles = new Map<string, string>();

  constructor(options: ResolverOptions) {
    this.options = options;
    this.fs = options.fsImpl ?? defaultFileSystem;
  }

  private get logger(): Logger {
    return this.options.logger;
  }

  get cachedArtifacts(): Map<string, string> {
    return this.resolvedFiles;
  }

  async resolve(request: ResolveRequest): Promise<DependencyResolutionResult> {
    const startedAt = Date.now();
    const repositories = dedupeRepositories(request.repositories);
    const unresolved: UnresolvedDependency[] = [];
    const seen = new Map<string, DependencyNode>();
    const roots: DependencyNode[] = [];
    const rootExclusions = new Set((request.exclusions ?? []).map((entry) => `${entry.groupId}:${entry.artifactId}`));
    const maxDepth = request.maxDepth ?? 12;
    const readPoms = request.readPoms !== false;

    const visit = async (
      coordinate: MavenCoordinate,
      configuration: string | undefined,
      optional: boolean,
      depth: number,
      direct: boolean,
      path: string[],
      exclusions: Set<string>,
    ): Promise<DependencyNode | undefined> => {
      if (rootExclusions.has(`${coordinate.groupId}:${coordinate.artifactId}`)) return undefined;
      const key = formatCoordinate(coordinate);
      const existing = seen.get(key);
      if (existing !== undefined) {
        existing.notes.push(`Referenced again at depth ${depth} from ${path[path.length - 1] ?? 'root'}`);
        return existing;
      }
      const node: DependencyNode = {
        coordinate,
        configuration,
        scope: configuration,
        optional,
        direct,
        depth,
        path: [...path, key],
        status: 'missing',
        children: [],
        notes: [],
      };
      seen.set(key, node);

      const resolution = await this.resolveCoordinate(coordinate, repositories, unresolved, node);
      if (resolution === undefined) {
        if (!optional && depth === 0) {
          node.status = 'missing';
        }
        return node;
      }
      node.resolvedFile = resolution.file;
      node.repositoryId = resolution.repositoryId;
      node.status = 'resolved';

      if (readPoms && resolution.pomFile !== undefined && depth < maxDepth) {
        const pom = parsePom(this.fs.readText(resolution.pomFile));
        const childExclusions = new Set(exclusions);
        for (const exclusion of resolution.exclusions) childExclusions.add(`${exclusion.groupId}:${exclusion.artifactId}`);
        for (const child of dependenciesOf(pom, resolution.exclusions)) {
          const resolvedVersion = this.interpolate(child, pom);
          const childCoordinate = parseCoordinateString(`${resolvedVersion.groupId}:${resolvedVersion.artifactId}:${resolvedVersion.version ?? '+'}`);
          if (childCoordinate === undefined) continue;
          if (childCoordinate.groupId === 'com.google.code.findbugs' && childCoordinate.artifactId === 'jsr305') {
            continue;
          }
          if (exclusions.has(`${childCoordinate.groupId}:${childCoordinate.artifactId}`)) continue;
          if (child.optional === true) continue;
          const childNode = await visit(
            childCoordinate,
            child.scope,
            false,
            depth + 1,
            false,
            node.path,
            childExclusions,
          );
          if (childNode !== undefined && childNode !== node) node.children.push(childNode);
        }
      }
      return node;
    };

    for (const entry of request.dependencies) {
      const node = await visit(entry.coordinate, entry.configuration, entry.optional ?? false, 0, true, [], new Set());
      if (node !== undefined) roots.push(node);
    }

    return {
      roots,
      totalResolved: [...seen.values()].filter((node) => node.status === 'resolved').length,
      unresolved,
      durationMs: Date.now() - startedAt,
    };
  }

  private interpolate(dependency: MavenPomDependency, pom: MavenPomModel): MavenPomDependency {
    return {
      ...dependency,
      groupId: expandValue(dependency.groupId, pom),
      artifactId: expandValue(dependency.artifactId, pom),
      version: dependency.version === undefined ? undefined : expandValue(dependency.version, pom),
    };
  }

  async resolveCoordinate(
    coordinate: MavenCoordinate,
    repositories: MavenRepository[],
    unresolved?: UnresolvedDependency[],
    node?: DependencyNode,
  ): Promise<{ file: string; repositoryId: string; pomFile?: string; exclusions: Array<{ groupId: string; artifactId: string }> } | undefined> {
    const relative = relativeMavenPath(coordinate);
    const localRoot = localMavenRepositoryRoot();
    if (localRoot !== undefined) {
      const localPath = `${localRoot}/${relative}`;
      if (this.fs.isFile(localPath)) {
        const pomPath = localPath.replace(/\.[^.]+$/, '.pom');
        const pom = this.fs.isFile(pomPath) ? parsePom(this.fs.readText(pomPath)) : undefined;
        return {
          file: localPath,
          repositoryId: 'maven-local',
          pomFile: this.fs.isFile(pomPath) ? pomPath : undefined,
          exclusions: pom?.dependencies.filter((dependency) => dependency.optional === true).map((dependency) => ({ groupId: dependency.groupId, artifactId: dependency.artifactId })) ?? [],
        };
      }
    }

    let version = coordinate.version;
    if (isDynamicVersion(version)) {
      if (this.options.offline) {
        unresolved?.push({
          coordinate,
          requestedBy: node?.path[node.path.length - 2] ?? 'root',
          repositoriesChecked: repositories.map((repository) => repository.id),
          cause: `Dynamic version ${version} requires a metadata query, which offline mode forbids`,
        });
        return undefined;
      }
      for (const repository of repositories) {
        const versions = await this.fetchDirectory(repository, coordinate);
        if (versions === undefined) continue;
        const matched = versionMatches(version, versions);
        if (matched !== undefined) {
          version = matched;
          break;
        }
      }
    }

    const effective: MavenCoordinate = { ...coordinate, version };
    const relativeWithVersion = relativeMavenPath(effective);

    for (const repository of repositories) {
      const target = `${this.options.paths.cacheMaven}/${repository.id}/${relativeWithVersion}`;
      const lookup = this.options.cache.lookup(target);
      if (lookup.hit && lookup.path !== undefined) {
        this.resolvedFiles.set(formatCoordinate(effective), lookup.path);
        return { file: lookup.path, repositoryId: repository.id, pomFile: this.derivePomPath(lookup.path), exclusions: [] };
      }
      if (this.options.offline) continue;
      const url = `${mavenBaseUrl(repository)}${relativeWithVersion}`;
      try {
        await downloadFile(url, target, {
          logger: this.logger,
          offline: this.options.offline,
          stage: 'Dependencies',
        });
        this.options.cache.store(target, { kind: 'maven', toolchainKey: repository.id, url });
        this.resolvedFiles.set(formatCoordinate(effective), target);
        const pomFile = await this.ensurePom(target, repository, effective);
        return { file: target, repositoryId: repository.id, pomFile, exclusions: [] };
      } catch (error) {
        if (error instanceof DownloadError && (error.status === 404 || error.kind === 'http-404')) continue;
        this.logger.debug(`Repository ${repository.id} failed for ${formatCoordinate(effective)}: ${(error as Error).message}`, 'Dependencies');
        continue;
      }
    }

    const fallback = findInLocalMavenRepositories(relativeWithVersion);
    if (fallback !== undefined) {
      this.resolvedFiles.set(formatCoordinate(effective), fallback);
      return { file: fallback, repositoryId: 'maven-local-fallback', pomFile: this.derivePomPath(fallback), exclusions: [] };
    }

    unresolved?.push({
      coordinate: effective,
      requestedBy: node?.path[node.path.length - 2] ?? 'root',
      repositoriesChecked: repositories.map((repository) => `${repository.id} (${repository.url})`),
      cause: 'Artifact not found in any configured repository',
    });
    return undefined;
  }

  private async ensurePom(jarPath: string, repository: MavenRepository, coordinate: MavenCoordinate): Promise<string | undefined> {
    const sibling = jarPath.replace(/\.[^./]+$/, '.pom');
    if (this.fs.isFile(sibling)) return sibling;
    if (this.options.offline) return undefined;
    const relative = relativeMavenPath({ ...coordinate, extension: 'pom' });
    const target = `${this.options.paths.cacheMaven}/${repository.id}/${relative}`;
    try {
      await downloadFile(`${mavenBaseUrl(repository)}${relative}`, target, {
        logger: this.logger,
        offline: this.options.offline,
        stage: 'Dependencies',
        retries: 1,
      });
      this.options.cache.store(target, { kind: 'maven-pom', toolchainKey: repository.id, url: `${mavenBaseUrl(repository)}${relative}` });
      return target;
    } catch {
      return undefined;
    }
  }

  private derivePomPath(jarPath: string): string | undefined {
    const pomPath = jarPath.replace(/\.[^./]+$/, '.pom');
    return this.fs.isFile(pomPath) ? pomPath : undefined;
  }

  private async fetchDirectory(repository: MavenRepository, coordinate: MavenCoordinate): Promise<string[] | undefined> {
    if (repository.id === 'maven-central') {
      if (process.env.JMC_MAVEN_CENTRAL_URL !== undefined) setMavenCentralBaseUrl(process.env.JMC_MAVEN_CENTRAL_URL);
      const entry = await getMavenDirectory(coordinate.groupId, coordinate.artifactId, { offline: this.options.offline });
      return entry?.versions;
    }
    const base = mavenBaseUrl(repository);
    const url = `${base}${coordinate.groupId.replace(/\./g, '/')}/${coordinate.artifactId}/maven-metadata.xml`;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!response.ok) return undefined;
      const xml = await response.text();
      const versions = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((match) => match[1] as string);
      return versions.length > 0 ? versions : undefined;
    } catch {
      return undefined;
    }
  }

  async fetchPom(coordinate: MavenCoordinate, repositories: MavenRepository[]): Promise<string | undefined> {
    for (const repository of repositories) {
      const relative = relativeMavenPath({ ...coordinate, extension: 'pom' });
      const target = `${this.options.paths.cacheMaven}/${repository.id}/${relative}`;
      const lookup = this.options.cache.lookup(target);
      if (lookup.hit && lookup.path !== undefined) return this.fs.readText(lookup.path);
      if (this.options.offline) continue;
      try {
        await downloadFile(`${mavenBaseUrl(repository)}${relative}`, target, {
          logger: this.logger,
          offline: this.options.offline,
          stage: 'Dependencies',
        });
        this.options.cache.store(target, { kind: 'maven-pom', toolchainKey: repository.id });
        return this.fs.readText(target);
      } catch {
        continue;
      }
    }
    return undefined;
  }

  pomDependenciesOf(jarPath: string): MavenPomDependency[] {
    const manifest = readJarManifest(jarPath);
    if (manifest === undefined) return [];
    const pomPath = `${jarPath.slice(0, -4)}.pom`;
    if (!this.fs.isFile(pomPath)) return [];
    return parsePom(this.fs.readText(pomPath)).dependencies;
  }

  cachePathFor(repositoryId: string, coordinate: MavenCoordinate): string {
    return path.join(this.options.paths.cacheMaven, repositoryId, relativeMavenPath(coordinate));
  }
}

function dependenciesOf(pom: MavenPomModel, exclusions: Array<{ groupId: string; artifactId: string }>): MavenPomDependency[] {
  const managed = new Map<string, string>();
  for (const entry of pom.dependencyManagement.dependencies) {
    managed.set(`${entry.groupId}:${entry.artifactId}`, entry.version ?? '');
  }
  const excluded = new Set(exclusions.map((entry) => `${entry.groupId}:${entry.artifactId}`));
  const collected: MavenPomDependency[] = [];
  for (const profile of pom.profiles) {
    if (profile.activeByDefault === true) collected.push(...profile.dependencies);
  }
  collected.push(...pom.dependencies);
  for (const dependency of collected) {
    if (excluded.has(`${dependency.groupId}:${dependency.artifactId}`)) continue;
    const managedVersion = managed.get(`${dependency.groupId}:${dependency.artifactId}`);
    if (dependency.version === undefined && managedVersion !== undefined && managedVersion.length > 0) {
      dependency.version = managedVersion;
    }
  }
  return collected;
}

function expandValue(value: string, pom: MavenPomModel): string {
  return value.replace(/\$\{([^}]+)\}/g, (full, key: string) => pom.properties[key] ?? full);
}

export function dedupeRepositories(repositories: MavenRepository[]): MavenRepository[] {
  const seen = new Map<string, MavenRepository>();
  for (const repository of repositories) {
    const key = `${repository.kind}|${normalizeRepositoryUrl(repository.url)}`;
    const existing = seen.get(key);
    if (existing === undefined || existing.priority > repository.priority) {
      seen.set(key, { ...repository, url: normalizeRepositoryUrl(repository.url) });
    }
  }
  return [...seen.values()].sort((a, b) => a.priority - b.priority);
}

export function repositoryFromGradle(kind: string, url: string | undefined, source: string): MavenRepository | undefined {
  if (url === undefined) return undefined;
  switch (kind) {
    case 'maven-central':
      return { id: 'maven-central', url: 'https://repo1.maven.org/maven2', kind: 'maven', priority: 10, source };
    case 'maven-local':
      return { id: 'maven-local', url: `file://${localMavenRepositoryRoot() ?? ''}`, kind: 'local', priority: 1, source };
    case 'flat-dir':
      return undefined;
    default:
      return { id: kind, url, kind: 'maven', priority: 40, source };
  }
}