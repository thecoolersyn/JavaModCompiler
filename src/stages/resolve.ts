import path from 'node:path';
import type { BuildContext, Stage, StageResult } from '../core/types.js';
import { defaultFileSystem } from '../platform/fs.js';
import { resolveGradleNotation } from '../project/gradle-parser.js';
import type { ProjectDetection } from '../project/detection.js';
import {
  BUILTIN_REPOSITORIES,
  dedupeRepositories,
  repositoryFromGradle,
} from '../deps/maven-resolver.js';
import { parseCoordinateString, type MavenCoordinate, type MavenRepository } from '../deps/model.js';
import { formatCoordinate } from '../deps/model.js';

export const resolveStage: Stage = {
  id: 'RESOLVE',
  label: 'Dependencies',
  async run(context: BuildContext): Promise<StageResult> {
    const project = context.project;
    if (project === undefined) {
      return { diagnostics: fatal('project-missing', 'Project detection did not run') };
    }

    const repositories = collectRepositories(project.gradle?.repositories ?? []);
    const direct: Array<{ coordinate: MavenCoordinate; configuration?: string; optional?: boolean }> = [];
    const skipped: string[] = [];

    const properties = project.gradle?.properties ?? {};
    const toolchainManaged = toolchainManagedDependencies(project);
    for (const notation of project.gradle?.dependencies.dependencies ?? []) {
      const resolved = resolveGradleNotation(notation, properties);
      if (resolved.startsWith('libs.') || resolved.includes('(')) continue;
      if (configurationOf(resolved) === 'classpath') {
        skipped.push(resolved);
        continue;
      }
      if (isToolchainManagedDependency(project, resolved, toolchainManaged)) {
        skipped.push(resolved);
        continue;
      }
      const coordinate = parseGradleNotation(notation, properties);
      if (coordinate === undefined) continue;
      direct.push({ coordinate, configuration: 'gradle-dependencies' });
    }
    for (const notation of project.gradle?.dependencies.platformConstraints ?? []) {
      const coordinate = parseCoordinateString(notation);
      if (coordinate !== undefined) direct.push({ coordinate, configuration: 'platform' });
    }
    for (const mavenDependency of project.maven?.dependencies ?? []) {
      const coordinate = parseCoordinateString(
        `${mavenDependency.groupId}:${mavenDependency.artifactId}:${mavenDependency.version ?? '+'}`,
      );
      if (coordinate === undefined) continue;
      direct.push({ coordinate, configuration: mavenDependency.scope });
    }

    for (const jar of project.localJars) {
      const absolute = path.join(project.root, jar.split('/').join(path.sep));
      const resolved = await context.services.localResolver.resolveLocalJar(absolute, project.root);
      if (resolved !== undefined) {
        context.artifacts.dependencies.push(resolved);
        context.logger.debug(`Local library ${jar}`, 'RESOLVE');
      }
    }

    for (const notation of skipped) {
      context.logger.info(
        `${notation} is a build plugin or loader-managed dependency and is resolved inside the isolated environment by the delegated build`,
        'RESOLVE',
      );
    }

    if (direct.length === 0) {
      return {
        artifacts: [],
        warnings:
          skipped.length === 0
            ? ['No external dependencies were declared by the project build configuration']
            : ['Every declared dependency is managed by the loader build and is resolved inside the isolated environment'],
      };
    }

    context.logger.info(`Resolving ${direct.length} direct dependencies from ${repositories.length} repositories`, 'RESOLVE');
    const resolution = await context.services.resolver.resolve({
      repositories,
      dependencies: direct,
      transitive: true,
    });
    context.dependencies = resolution;
    context.repositoriesChecked = repositories.map((repository) => `${repository.id} (${repository.url})`);

    const artifacts: string[] = [];
    const collect = (nodes: typeof resolution.roots): void => {
      for (const node of nodes) {
        if (node.status === 'resolved' && node.resolvedFile !== undefined) artifacts.push(node.resolvedFile);
        collect(node.children);
      }
    };
    collect(resolution.roots);

    if (resolution.unresolved.length > 0) {
      const detail = resolution.unresolved
        .slice(0, 10)
        .map(
          (entry) =>
            `${formatCoordinate(entry.coordinate)}\n  requested by: ${entry.requestedBy}\n  repositories checked: ${entry.repositoriesChecked.join(', ')}\n  cause: ${entry.cause}`,
        )
        .join('\n');
      return {
        artifacts,
        diagnostics: [
          {
            id: 'dependency-resolution',
            severity: 'error',
            title: 'Dependency Resolution',
            summary: `${resolution.unresolved.length} dependenc${resolution.unresolved.length === 1 ? 'y' : 'ies'} could not be resolved`,
            stage: 'RESOLVE',
            detected: resolution.unresolved.slice(0, 10).map((entry) => formatCoordinate(entry.coordinate)),
            expected: 'Every declared dependency resolves to a readable artifact',
            cause: 'One or more artifacts are absent from every configured repository.',
            suggestions: [
              'Add the repository that publishes the missing artifact to the project build configuration.',
              'Verify the requested versions are published, including any dynamic version ranges.',
              'If the artifact is cached locally, re-run with --offline so JMC uses only cached files.',
            ],
            evidence: resolution.unresolved.slice(0, 20).map((entry) => `${formatCoordinate(entry.coordinate)} <- ${entry.requestedBy}`),
            rawMessages: detail.split('\n'),
          },
        ],
      };
    }

    return { artifacts };
  },
};

function fatal(id: string, summary: string): NonNullable<StageResult['diagnostics']> {
  return [
    {
      id,
      severity: 'error',
      title: 'Pipeline',
      summary,
      stage: 'RESOLVE',
      suggestions: [],
      evidence: [],
      rawMessages: [],
    },
  ];
}

const LOOM_CONFIGURATIONS = new Set([
  'minecraft',
  'mappings',
  'modImplementation',
  'modApi',
  'modCompileOnly',
  'modRuntimeOnly',
  'modEmbed',
  'modLocalRuntime',
]);
const LOOM_CONFIGURATIONS_OPTIONAL = new Set(['minecraft', 'mappings']);
const LOOM_MAPPING_ARTIFACTS = new Set([
  'net.fabricmc:yarn',
  'net.fabricmc:intermediary',
  'org.quiltmc:yarn',
  'org.quiltmc:intermediary',
  'net.minecraftforge:official',
  'net.minecraftforge:mcp_config',
  'net.minecraftforge:installertools',
  'net.neoforged:neoform',
  'net.neoforged:neoforge',
]);
const MINECRAFT_ARTIFACTS = new Set(['com.mojang:minecraft']);
const LOADER_GROUPS = new Set(['net.minecraftforge', 'net.neoforged', 'net.neoforged.fancymodloader']);

export function toolchainManagedDependencies(project: ProjectDetection): Set<string> {
  const pluginIds = [
    ...(project.gradle?.plugins ?? []).map((plugin) => plugin.id.toLowerCase()),
    ...(project.gradle?.buildscriptClasspath ?? []).map((coordinate) => (coordinate.split(':')[0] ?? '').toLowerCase()),
  ];
  const plugins = pluginIds;
  const loomManaged = plugins.some((id) => /loom|fabric|quilt|forge|neoforge/i.test(id));
  const forgeManaged = plugins.some((id) => /forgegradle|forge\.gradle|net\.minecraftforge|net\.neoforged|neoforged/i.test(id));
  const managed = new Set<string>();
  const optionalManaged = new Set<string>();
  for (const coordinate of project.gradle?.buildscriptClasspath ?? []) {
    const parts = coordinate.split(':');
    if (parts[0] !== undefined && parts[1] !== undefined) managed.add(`${parts[0]}:${parts[1]}`);
  }
  for (const notation of project.gradle?.dependencies.dependencies ?? []) {
    const configuration = configurationOf(notation);
    const coordinate = parseGradleNotation(coordinatePartOf(notation), project.gradle?.properties ?? {});
    if (coordinate === undefined) continue;
    const key = `${coordinate.groupId}:${coordinate.artifactId}`;
    const loaderOwned = LOADER_GROUPS.has(coordinate.groupId) || MINECRAFT_ARTIFACTS.has(key);
    const toolchainManaged =
      (loomManaged && (LOOM_CONFIGURATIONS.has(configuration) || loaderOwned)) ||
      (forgeManaged && (configuration === 'minecraft' || configuration === 'mcp' || configuration.startsWith('compile') || loaderOwned));
    if (toolchainManaged) managed.add(key);
    else if (loomManaged && LOOM_CONFIGURATIONS_OPTIONAL.has(configuration)) {
      optionalManaged.add(key);
    }
  }
  if (loomManaged) {
    for (const entry of LOOM_MAPPING_ARTIFACTS) managed.add(entry);
  }
  return managed;
}

export function configurationOf(notation: string): string {
  const trimmed = notation.trim();
  const match = /^([A-Za-z][\w]*)\s*[(\(]?/.exec(trimmed);
  return match?.[1] ?? '';
}

export function coordinatePartOf(notation: string): string {
  const trimmed = notation.trim();
  const index = trimmed.search(/["']/);
  if (index === -1) return trimmed;
  return trimmed.slice(index).replace(/^["']|["']$/g, '');
}

export function isToolchainManagedDependency(project: ProjectDetection, resolved: string, managed: Set<string>): boolean {
  const coordinate = parseGradleNotation(resolved, project.gradle?.properties ?? {});
  if (coordinate === undefined) return false;
  const key = `${coordinate.groupId}:${coordinate.artifactId}`;
  if (managed.has(key)) return true;
  return MINECRAFT_ARTIFACTS.has(key);
}

export function collectRepositories(gradleRepositories: Array<{ kind: string; url?: string }>): MavenRepository[] {
  const collected: MavenRepository[] = [...BUILTIN_REPOSITORIES];
  let priority = 45;
  for (const repository of gradleRepositories) {
    if (repository.url === undefined) {
      if (repository.kind === 'maven-central') {
        collected.push({ id: 'maven-central', url: 'https://repo1.maven.org/maven2', kind: 'maven', priority: 10, source: 'gradle' });
        continue;
      }
      if (repository.kind === 'maven-local') {
        collected.push({ id: 'maven-local', url: 'file:///dev/null', kind: 'local', priority: 1, source: 'gradle' });
        continue;
      }
      continue;
    }
    const mapped = repositoryFromGradle(repository.kind, repository.url, 'gradle');
    if (mapped === undefined) continue;
    collected.push({ ...mapped, priority: priority++ });
  }
  const unique = dedupeRepositories(collected);
  return unique.filter((repository) => repository.kind !== 'local' || repository.url !== 'file:///dev/null');
}

export function parseGradleNotation(notation: string, properties: Record<string, string> = {}): MavenCoordinate | undefined {
  const cleaned = resolveGradleNotation(notation, properties);
  if (cleaned.includes('(') || cleaned.startsWith('libs.') || cleaned.startsWith('project(')) return undefined;
  return parseCoordinateString(cleaned);
}

export function dependencySummary(context: BuildContext): string[] {
  if (context.dependencies === undefined) return [];
  return [
    `direct: ${context.dependencies.roots.length}`,
    `resolved: ${context.dependencies.totalResolved}`,
    `unresolved: ${context.dependencies.unresolved.length}`,
    `duration: ${context.dependencies.durationMs} ms`,
  ];
}

export function localJarCandidates(projectRoot: string): string[] {
  const fs = defaultFileSystem;
  return fs
    .findFiles(projectRoot, (relative) => relative.toLowerCase().endsWith('.jar'), 8)
    .filter((relative) => !relative.includes('/build/') && !relative.includes('/target/') && !relative.includes('/.gradle/'));
}