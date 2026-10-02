import path from 'node:path';
import type { Logger } from '../logging/logger.js';
import { detectProject, type ProjectDetection } from '../project/detection.js';
import { MappingRegistry } from '../mappings/registry.js';
import { mappingSummaryLines } from '../mappings/compatibility.js';
import { detectLoaderFromSignals, loaderDisplayName } from '../loader/detection.js';
import { defaultFileSystem } from '../platform/fs.js';
import { renderKeyValues, renderTree, type GraphNode } from '../report/tree.js';
import {
  BUILTIN_REPOSITORIES,
  dedupeRepositories,
} from '../deps/maven-resolver.js';
import { formatCoordinate, parseCoordinateString, type DependencyResolutionResult } from '../deps/model.js';
import { collectRepositories, parseGradleNotation } from '../stages/resolve.js';
import { resolveGradleNotation } from '../project/gradle-parser.js';
import { formatVersionIdentity, parseMinecraftVersion } from '../minecraft/version.js';
import { javaBaselineForVersion } from '../minecraft/version.js';

export interface DetectResult {
  project: ProjectDetection;
  lines: string[];
  json: Record<string, unknown>;
}

export function runDetect(logger: Logger, projectRoot: string): DetectResult {
  const project = detectProject(projectRoot, { logger });
  const lines: string[] = [];
  lines.push('Project:');
  lines.push(`  ${project.name}`);
  lines.push(`  path: ${project.root}`);
  lines.push('');
  lines.push('Build System:');
  lines.push(`  ${project.buildTool}`);
  if (project.gradle?.wrapperVersion !== undefined) lines.push(`  gradle wrapper: ${project.gradle.wrapperVersion}`);
  if (project.gradle?.plugins.length !== undefined && project.gradle.plugins.length > 0) {
    lines.push('  plugins:');
    for (const plugin of project.gradle.plugins.slice(0, 20)) {
      lines.push(`    - ${plugin.id}${plugin.version === undefined ? '' : `:${plugin.version}`}`);
    }
  }
  lines.push('');
  lines.push('Language:');
  lines.push(`  ${project.languages}`);
  for (const sourceSet of project.sourceSets) lines.push(`  ${sourceSet.name}: ${sourceSet.fileCount} files`);
  lines.push('');
  lines.push('Minecraft:');
  if (project.minecraftVersion === undefined) {
    lines.push('  not detected');
  } else {
    const identity = parseMinecraftVersion(project.minecraftVersion);
    lines.push(`  ${project.minecraftVersion} (${formatVersionIdentity(identity)})`);
    lines.push(`  source: ${project.minecraftVersionSource ?? 'unknown'}`);
    for (const evidence of project.minecraftVersionEvidence.slice(0, 8)) {
      lines.push(`    - ${evidence.version} via ${evidence.source} (weight ${evidence.weight})`);
    }
  }
  lines.push('');
  lines.push('Loader:');
  lines.push(`  ${loaderDisplayName(project.loader.kind)}`);
  lines.push(`  confidence: ${project.loader.confidence}`);
  for (const evidence of project.loader.evidence.slice(0, 8)) lines.push(`    - ${evidence.signal}: ${evidence.detail ?? ''}`);
  lines.push('');
  lines.push('Java:');
  lines.push(`  detected target: ${project.javaTarget ?? 'not detected'}`);
  lines.push(`  baseline for Minecraft: ${project.minecraftVersion === undefined ? 'unknown' : javaBaselineForVersion(project.minecraftVersion)}`);
  lines.push('');
  lines.push('Dependencies:');
  const notations = project.gradle?.dependencies.dependencies ?? [];
  const mavenDependencies = project.maven?.dependencies ?? [];
  lines.push(`  gradle notations: ${notations.length}`);
  lines.push(`  maven dependencies: ${mavenDependencies.length}`);
  lines.push(`  local jars: ${project.localJars.length}`);
  for (const jar of project.localJars.slice(0, 20)) lines.push(`    - ${jar}`);
  if (notations.length > 0) {
    lines.push('  coordinates:');
    for (const notation of notations.slice(0, 30)) {
      const coordinate = parseGradleNotation(notation, project.gradle?.properties ?? {});
      lines.push(`    - ${coordinate === undefined ? resolveGradleNotation(notation, project.gradle?.properties ?? {}) : formatCoordinate(coordinate)}`);
    }
  }
  lines.push('');
  lines.push('Repositories:');
  const repositories = collectRepositories(project.gradle?.repositories ?? []);
  for (const repository of repositories) lines.push(`  ${repository.id}: ${repository.url}`);
  lines.push('');
  lines.push('Source Sets:');
  for (const sourceSet of project.sourceSets) lines.push(`  ${sourceSet.name}: ${sourceSet.root}`);
  lines.push('');
  lines.push('Metadata:');
  for (const metadata of project.modMetadata) {
    lines.push(`  ${metadata.kind} -> ${metadata.path}`);
    if (metadata.modId !== undefined) lines.push(`    modId: ${metadata.modId}`);
    if (metadata.version !== undefined) lines.push(`    version: ${metadata.version}`);
    if (metadata.minecraftVersionRange !== undefined) lines.push(`    minecraft range: ${metadata.minecraftVersionRange}`);
    if (metadata.mixinConfigs !== undefined && metadata.mixinConfigs.length > 0) {
      lines.push(`    mixin configs: ${metadata.mixinConfigs.join(', ')}`);
    }
  }
  lines.push('');
  lines.push('Mixin Configurations:');
  for (const config of project.mixinConfigs) lines.push(`  ${config}`);
  lines.push('');
  lines.push('Annotation Processors:');
  for (const declared of project.annotationProcessors.declaredInBuild) lines.push(`  build: ${declared}`);
  for (const declared of project.annotationProcessors.declaredInServices) lines.push(`  services: ${declared}`);
  for (const declared of project.annotationProcessors.classNames.slice(0, 10)) lines.push(`  class: ${declared}`);
  if (project.detectedIssues.length > 0) {
    lines.push('');
    lines.push('Issues:');
    for (const issue of project.detectedIssues) lines.push(`  ${issue}`);
  }

  const json: Record<string, unknown> = {
    project: {
      root: project.root,
      name: project.name,
      buildSystem: project.buildSystem,
      buildTool: project.buildTool,
      languages: project.languages,
      sourceSets: project.sourceSets.map((sourceSet) => ({ name: sourceSet.name, root: sourceSet.root, files: sourceSet.fileCount })),
      isMultiModule: project.isMultiModule,
      hasWrapper: project.hasWrapper,
      gradleWrapperVersion: project.gradleWrapperVersion,
      javaTarget: project.javaTarget,
      javaBaseline: project.javaBaseline,
    },
    minecraft: {
      version: project.minecraftVersion,
      source: project.minecraftVersionSource,
      evidence: project.minecraftVersionEvidence,
    },
    loader: {
      kind: project.loader.kind,
      displayName: loaderDisplayName(project.loader.kind),
      confidence: project.loader.confidence,
      evidence: project.loader.evidence,
    },
    mappings: 'detected from project metadata only; supply a mappings path to inspect a mapping set',
    java: { target: project.javaTarget, baseline: project.javaBaseline },
    dependencies: {
      gradleNotations: notations,
      maven: mavenDependencies,
      localJars: project.localJars,
    },
    repositories: repositories.map((repository) => ({ id: repository.id, url: repository.url })),
    metadata: project.modMetadata.map((metadata) => ({
      kind: metadata.kind,
      path: metadata.path,
      modId: metadata.modId,
      version: metadata.version,
      minecraftVersionRange: metadata.minecraftVersionRange,
      mixinConfigs: metadata.mixinConfigs ?? [],
    })),
    mixinConfigs: project.mixinConfigs,
    annotationProcessors: project.annotationProcessors,
    issues: project.detectedIssues,
  };

  return { project, lines, json };
}

export interface MappingsInspection {
  path: string;
  exists: boolean;
  lines: string[];
  json: Record<string, unknown>;
}

export async function runMappings(logger: Logger, target: string): Promise<MappingsInspection> {
  const fs = defaultFileSystem;
  const resolved = path.resolve(target);
  if (!fs.exists(resolved)) {
    return {
      path: resolved,
      exists: false,
      lines: [`Mappings path does not exist: ${resolved}`],
      json: { path: resolved, exists: false, error: 'path does not exist' },
    };
  }
  const registry = new MappingRegistry();
  const probe = await registry.probeDirectory(resolved);
  const lines: string[] = [`Path: ${resolved}`];
  if (probe === undefined) {
    lines.push('No registered mapping provider recognized this path.');
    lines.push('Install a MappingProvider plugin for this format under the JMC plugins directory.');
    return {
      path: resolved,
      exists: true,
      lines,
      json: { path: resolved, exists: true, detected: false, providersTried: registry.listProviders().map((provider) => provider.descriptor.id) },
    };
  }
  lines.push(...mappingSummaryLines(probe.descriptor));
  lines.push('');
  lines.push('Provider candidates:');
  for (const candidate of probe.candidates) {
    lines.push(`  ${candidate.providerId} / ${candidate.format}: score ${candidate.confidence}, ${candidate.classes} class entries`);
  }
  if (probe.rejected.length > 0) {
    lines.push('');
    lines.push('Rejected candidates:');
    for (const rejection of probe.rejected) {
      lines.push(`  ${rejection.providerId} / ${rejection.format}: ${rejection.reason}`);
    }
  }
  const subjectVersion = probe.descriptor.minecraft.version;
  lines.push('');
  lines.push('Compatibility:');
  lines.push(`  minecraft version declared by mappings: ${subjectVersion ?? 'unknown'}`);
  lines.push(`  confidence: ${probe.descriptor.minecraft.confidence}`);
  lines.push(`  source: ${probe.descriptor.minecraft.source ?? 'unknown'}`);

  const json: Record<string, unknown> = {
    path: resolved,
    exists: true,
    detected: true,
    format: probe.descriptor.format,
    formatConfidence: probe.descriptor.formatConfidence,
    provider: probe.descriptor.providerId,
    namespaces: probe.descriptor.namespaces,
    primaryNamespace: probe.descriptor.primaryNamespace,
    targetNamespace: probe.descriptor.targetNamespace,
    minecraft: probe.descriptor.minecraft,
    entryCounts: probe.descriptor.entryCounts,
    fileCount: probe.descriptor.fileCount,
    totalBytes: probe.descriptor.totalBytes,
    files: probe.descriptor.files,
    parchment: probe.descriptor.parchment,
    notes: probe.descriptor.notes,
    provenance: probe.descriptor.provenance,
    candidates: probe.candidates,
    rejected: probe.rejected,
    providersTried: registry.listProviders().map((provider) => provider.descriptor.id),
  };
  void logger;
  return { path: resolved, exists: true, lines, json };
}

export interface DependencyInspection {
  lines: string[];
  json: Record<string, unknown>;
}

export async function runDependencies(
  logger: Logger,
  projectRoot: string,
  options: { offline: boolean },
): Promise<DependencyInspection> {
  const project = detectProject(projectRoot, { logger });
  const lines: string[] = [];
  lines.push(`Project: ${project.name}`);
  lines.push(`Build system: ${project.buildTool}`);
  lines.push('');

  const repositories = collectRepositories(project.gradle?.repositories ?? []);
  lines.push('Repositories:');
  for (const repository of repositories) lines.push(`  ${repository.id}: ${repository.url}`);
  lines.push('');

  const direct: Array<{ coordinate: ReturnType<typeof parseCoordinateString>; notation: string }> = [];
  const properties = project.gradle?.properties ?? {};
  for (const notation of project.gradle?.dependencies.dependencies ?? []) {
    direct.push({ coordinate: parseGradleNotation(notation, properties), notation: resolveGradleNotation(notation, properties) });
  }
  for (const dependency of project.maven?.dependencies ?? []) {
    const coordinate = parseCoordinateString(`${dependency.groupId}:${dependency.artifactId}:${dependency.version ?? '+'}`);
    direct.push({ coordinate, notation: `${dependency.groupId}:${dependency.artifactId}:${dependency.version ?? '+'}` });
  }

  if (direct.length === 0) {
    lines.push('The project declares no external dependencies.');
    return { lines, json: { project: project.root, repositories: repositories.map((repository) => repository.id), roots: [], unresolved: [] } };
  }

  const resolution = await resolveGraph(project, repositories, options.offline, logger);
  const roots: GraphNode[] = resolution.roots.map((node) => toGraphNode(node));
  lines.push('Dependency graph:');
  lines.push('Project');
  for (const line of renderTree(roots)) lines.push(` ${line}`);
  lines.push('');
  lines.push(`Resolved: ${resolution.totalResolved}`);
  lines.push(`Unresolved: ${resolution.unresolved.length}`);
  for (const entry of resolution.unresolved) {
    lines.push('');
    lines.push(`Dependency: ${formatCoordinate(entry.coordinate)}`);
    lines.push(`Requested version: ${entry.coordinate.version}`);
    lines.push(`Requested by: ${entry.requestedBy}`);
    lines.push(`Repositories checked: ${entry.repositoriesChecked.join(', ')}`);
    lines.push(`Reason: ${entry.cause}`);
  }
  for (const jar of project.localJars) {
    lines.push(`Local jar: ${jar}`);
  }

  return {
    lines,
    json: {
      project: project.root,
      buildSystem: project.buildSystem,
      repositories: repositories.map((repository) => ({ id: repository.id, url: repository.url })),
      roots: resolution.roots,
      unresolved: resolution.unresolved,
      totalResolved: resolution.totalResolved,
      localJars: project.localJars,
      durationMs: resolution.durationMs,
    },
  };
}

async function resolveGraph(
  project: ProjectDetection,
  repositories: ReturnType<typeof collectRepositories>,
  offline: boolean,
  logger: Logger,
): Promise<DependencyResolutionResult> {
  const { MavenRepositoryResolver } = await import('../deps/maven-resolver.js');
  const { createPaths } = await import('../platform/paths.js');
  const { ContentCache } = await import('../cache/cache.js');
  const paths = createPaths();
  const cache = new ContentCache({ paths, logger, offline, noCache: false });
  const resolver = new MavenRepositoryResolver({ paths, logger, cache, offline });
  void BUILTIN_REPOSITORIES;
  void dedupeRepositories;
  return resolver.resolve({
    repositories,
    dependencies: (project.gradle?.dependencies.dependencies ?? [])
      .map((notation) => parseGradleNotation(notation, project.gradle?.properties ?? {}))
      .filter((coordinate): coordinate is NonNullable<ReturnType<typeof parseCoordinateString>> => coordinate !== undefined)
      .map((coordinate) => ({ coordinate })),
    transitive: true,
  });
}

function toGraphNode(node: import('../deps/model.js').DependencyNode): GraphNode {
  return {
    id: formatCoordinate(node.coordinate),
    label: `${node.coordinate.groupId}:${node.coordinate.artifactId}:${node.coordinate.version}`,
    status: node.status === 'resolved' ? 'ok' : node.status === 'missing' ? 'missing' : 'conflict',
    detail: node.repositoryId === undefined ? undefined : ` [${node.repositoryId}]`,
    children: node.children.map((child) => toGraphNode(child)),
  };
}

export function renderDetectLines(result: DetectResult): string[] {
  return result.lines;
}

export function renderKeyValueLines(entries: Array<[string, string | undefined]>): string[] {
  return renderKeyValues(entries, { skipUndefined: true });
}

export function detectLoaderFromProject(project: ProjectDetection): ReturnType<typeof detectLoaderFromSignals> {
  return project.loader;
}