import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Diagnostic, StageId, StageStatus } from '../core/types.js';
import type { ProjectDetection } from '../project/detection.js';
import type { MappingDescriptor, MappingCompatibilityReport } from '../mappings/types.js';
import type { DependencyNode, DependencyResolutionResult } from '../deps/model.js';
import type { PlatformDescriptor } from '../platform/os.js';
import type { ResourceBudget } from '../platform/resources.js';
import type { LogRecord } from '../logging/types.js';

export type BuildOutcome = 'pass' | 'failed' | 'warning';

export interface BuildReport {
  schemaVersion: number;
  generatedAt: string;
  tool: { name: string; version: string; node: string };
  status: BuildOutcome;
  buildId: string;
  durationMs: number;
  project: {
    root: string;
    name: string;
    buildSystem: string;
    languages: string;
    minecraftVersion?: string;
    minecraftVersionSource?: string;
    loader?: string;
    loaderVersion?: string;
    mappingsPath?: string;
    mappingsFormat?: string;
    mappingsNamespace?: string;
    javaTarget?: number;
  };
  toolchain: {
    javaVersion?: string;
    javaMajor?: number;
    javaVendor?: string;
    javaHome?: string;
    gradleVersion?: string;
    gradleBinary?: string;
    platform: string;
    architecture: string;
    os: string;
    resourceBudget: {
      cpuCount: number;
      gradleMaxHeapBytes: number;
      compilerMaxHeapBytes: number;
      downloadConcurrency: number;
      maxParallelOperations: number;
    };
  };
  dependencies: {
    direct: number;
    transitive: number;
    unresolved: Array<{ coordinate: string; requestedBy: string; cause: string }>;
    graph: DependencyNode[];
  };
  repositories: string[];
  stages: Array<{
    id: StageId | string;
    label: string;
    status: string;
    durationMs: number;
    messages: string[];
    artifacts: string[];
  }>;
  diagnostics: Diagnostic[];
  artifact?: {
    path: string;
    sizeBytes: number;
    sha256: string;
    entryCount?: number;
    classCount?: number;
  };
  lock: BuildLock;
  logs: Array<{ level: string; message: string; stage?: string; timestamp: string }>;
}

export interface BuildLock {
  schemaVersion: number;
  buildId: string;
  createdAt: string;
  minecraft: { version?: string; versionSource?: string };
  loader: { id?: string; version?: string };
  mappings: { path?: string; format?: string; namespaces?: string[]; sha256?: string };
  java: { major?: number; versionText?: string; vendor?: string };
  gradle: { version?: string; distributionUrl?: string };
  compiler: { release?: number; sourceCompatibility?: number; targetCompatibility?: number };
  dependencies: Array<{ coordinate: string; version: string; repository?: string; sha256?: string }>;
  repositories: Array<{ id: string; url: string }>;
  artifacts: Array<{ kind: string; path: string; sha256: string }>;
  toolchain: { jmcVersion: string; cacheFormat: number; node: string; platform: string };
}

export interface BuildReportInput {
  status: BuildOutcome;
  buildId: string;
  startedAt: number;
  durationMs: number;
  project: ProjectDetection;
  mappingsDescriptor?: MappingDescriptor;
  mappingCompatibility?: MappingCompatibilityReport;
  dependencies?: DependencyResolutionResult;
  repositories: string[];
  stages: Map<StageId, StageStatus>;
  diagnostics: Diagnostic[];
  artifactPath?: string;
  artifactSizeBytes?: number;
  artifactSha256?: string;
  artifactEntryCount?: number;
  artifactClassCount?: number;
  toolchain: {
    javaVersion?: string;
    javaMajor?: number;
    javaVendor?: string;
    javaHome?: string;
    gradleVersion?: string;
    gradleBinary?: string;
  };
  platform: PlatformDescriptor;
  resourceBudget: ResourceBudget;
  logs: LogRecord[];
  jmcVersion: string;
  mappingsPath?: string;
  mappingsSha256?: string;
  gradleDistributionUrl?: string;
}

export function sha256OfText(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export function buildLockFrom(input: BuildReportInput): BuildLock {
  const gradle = input.project.gradle;
  const lock: BuildLock = {
    schemaVersion: 1,
    buildId: input.buildId,
    createdAt: new Date().toISOString(),
    minecraft: { version: input.project.minecraftVersion, versionSource: input.project.minecraftVersionSource },
    loader: { id: input.project.loader.kind, version: input.project.loader.version },
    mappings: {
      path: input.mappingsDescriptor === undefined ? undefined : path.basename(input.mappingsDescriptor.directory),
      format: input.mappingsDescriptor?.format,
      namespaces: input.mappingsDescriptor?.namespaces.map((namespace) => namespace.name),
      sha256: input.mappingsSha256,
    },
    java: {
      major: input.toolchain.javaMajor,
      versionText: input.toolchain.javaVersion,
      vendor: input.toolchain.javaVendor,
    },
    gradle: { version: input.toolchain.gradleVersion, distributionUrl: input.gradleDistributionUrl },
    compiler: {
      release: gradle?.javaToolchain,
      sourceCompatibility: gradle?.sourceCompatibility,
      targetCompatibility: gradle?.targetCompatibility,
    },
    dependencies: [],
    repositories: input.repositories.map((url) => ({ id: deriveRepositoryId(url), url })),
    artifacts: [],
    toolchain: {
      jmcVersion: input.jmcVersion,
      cacheFormat: 1,
      node: process.version,
      platform: `${input.platform.os}-${input.platform.arch}`,
    },
  };
  for (const node of input.dependencies?.roots ?? []) {
    collectLockDependencies(node, lock);
  }
  if (input.artifactPath !== undefined && input.artifactSha256 !== undefined) {
    lock.artifacts.push({ kind: 'output', path: path.basename(input.artifactPath), sha256: input.artifactSha256 });
  }
  return lock;
}

function collectLockDependencies(node: DependencyNode, lock: BuildLock): void {
  if (node.status !== 'resolved' || node.resolvedFile === undefined) return;
  const coordinate = `${node.coordinate.groupId}:${node.coordinate.artifactId}:${node.coordinate.version}`;
  if (lock.dependencies.some((entry) => entry.coordinate === coordinate)) return;
  lock.dependencies.push({
    coordinate,
    version: node.coordinate.version,
    repository: node.repositoryId,
    sha256: safeSha256(node.resolvedFile),
  });
  for (const child of node.children) collectLockDependencies(child, lock);
}

function safeSha256(filePath: string): string | undefined {
  try {
    return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  } catch {
    return undefined;
  }
}

function deriveRepositoryId(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export function buildReportFrom(input: BuildReportInput): BuildReport {
  const stages: BuildReport['stages'] = [];
  for (const [id, status] of input.stages) {
    stages.push({
      id,
      label: status.label,
      status: status.status,
      durationMs: status.durationMs,
      messages: status.messages,
      artifacts: status.artifacts,
    });
  }
  const direct = input.dependencies?.roots.length ?? 0;
  const transitive = Math.max(0, (input.dependencies?.totalResolved ?? 0) - direct);
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    tool: { name: 'jmc', version: input.jmcVersion, node: process.version },
    status: input.status,
    buildId: input.buildId,
    durationMs: input.durationMs,
    project: {
      root: input.project.root,
      name: input.project.name,
      buildSystem: input.project.buildSystem,
      languages: input.project.languages,
      minecraftVersion: input.project.minecraftVersion,
      minecraftVersionSource: input.project.minecraftVersionSource,
      loader: input.project.loader.kind,
      loaderVersion: input.project.loader.version,
      mappingsPath: input.mappingsPath,
      mappingsFormat: input.mappingsDescriptor?.format,
      mappingsNamespace: input.mappingsDescriptor?.primaryNamespace,
    },
    toolchain: {
      javaVersion: input.toolchain.javaVersion,
      javaMajor: input.toolchain.javaMajor,
      javaVendor: input.toolchain.javaVendor,
      javaHome: input.toolchain.javaHome,
      gradleVersion: input.toolchain.gradleVersion,
      gradleBinary: input.toolchain.gradleBinary,
      platform: input.platform.os,
      architecture: input.platform.arch,
      os: input.platform.os,
      resourceBudget: {
        cpuCount: input.resourceBudget.cpuCount,
        gradleMaxHeapBytes: input.resourceBudget.gradleMaxHeapBytes,
        compilerMaxHeapBytes: input.resourceBudget.compilerMaxHeapBytes,
        downloadConcurrency: input.resourceBudget.downloadConcurrency,
        maxParallelOperations: input.resourceBudget.maxParallelOperations,
      },
    },
    dependencies: {
      direct,
      transitive,
      unresolved: (input.dependencies?.unresolved ?? []).map((entry) => ({
        coordinate: `${entry.coordinate.groupId}:${entry.coordinate.artifactId}:${entry.coordinate.version}`,
        requestedBy: entry.requestedBy,
        cause: entry.cause,
      })),
      graph: input.dependencies?.roots ?? [],
    },
    repositories: input.repositories,
    stages,
    diagnostics: input.diagnostics,
    artifact:
      input.artifactPath === undefined
        ? undefined
        : {
            path: input.artifactPath,
            sizeBytes: input.artifactSizeBytes ?? 0,
            sha256: input.artifactSha256 ?? '',
            entryCount: input.artifactEntryCount,
            classCount: input.artifactClassCount,
          },
    lock: buildLockFrom(input),
    logs: input.logs.map((record) => ({
      level: record.level,
      message: record.status === 'debug' ? record.message : record.message,
      stage: record.stage,
      timestamp: new Date(record.timestamp).toISOString(),
    })),
  };
}

export function writeBuildReportJson(report: BuildReport, destination: string, fsImpl?: { writeText(target: string, content: string): void }): void {
  const writer =
    fsImpl ??
    ({
      writeText(target: string, content: string): void {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content, 'utf8');
      },
    } as const);
  writer.writeText(destination, `${JSON.stringify(report, null, 2)}\n`);
}