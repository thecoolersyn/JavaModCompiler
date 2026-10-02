import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { BuildContext, Stage, StageResult } from '../core/types.js';
import { buildReportFrom, type BuildLock, type BuildReport } from '../report/build-report.js';
import { renderBuildReportHtml } from '../report/html-report.js';
import { detectPlatform } from '../platform/os.js';
import { inspectJar } from '../jar/jar.js';

export interface ReportArtifacts {
  logPath: string;
  jsonPath: string;
  htmlPath: string;
  lockPath: string;
  report: BuildReport;
}

export interface BuildReportInputOptions {
  status: 'pass' | 'failed' | 'warning';
  startedAt: number;
  durationMs: number;
}

export function reportStage(options: { status: 'pass' | 'failed' | 'warning'; startedAt: number; durationMs: number }): Stage {
  return {
    id: 'REPORT',
    label: 'Build Reports',
    async run(context: BuildContext): Promise<StageResult> {
      const artifacts = writeReports(context, options);
      context.logger.debug(`Reports written to ${path.dirname(artifacts.jsonPath)}`, 'REPORT');
      return { artifacts: [artifacts.logPath, artifacts.jsonPath, artifacts.htmlPath, artifacts.lockPath] };
    },
  };
}

export function writeReports(
  context: BuildContext,
  options: { status: 'pass' | 'failed' | 'warning'; startedAt: number; durationMs: number },
): ReportArtifacts {
  const fsModule = fs;
  const platform = detectPlatform();
  const report = buildReportFrom({
    status: options.status,
    buildId: context.options.buildId,
    startedAt: options.startedAt,
    durationMs: options.durationMs,
    project: context.project ?? fallbackProject(context),
    mappingsDescriptor: context.mappingsDescriptor,
    mappingCompatibility: context.mappingCompatibility,
    dependencies: context.dependencies,
    repositories: context.repositoriesChecked,
    stages: context.stages,
    diagnostics: context.diagnostics,
    artifactPath: context.finalArtifact,
    artifactSizeBytes: context.finalArtifact === undefined ? undefined : sizeOf(context.finalArtifact),
    artifactSha256: context.finalArtifact === undefined ? undefined : sha256(context.finalArtifact),
    artifactEntryCount: context.finalArtifact === undefined ? undefined : safeInspect(context.finalArtifact).entryCount,
    artifactClassCount: context.finalArtifact === undefined ? undefined : safeInspect(context.finalArtifact).classCount,
    toolchain: {
      javaVersion: context.toolchain.javaVersionText,
      javaMajor: context.toolchain.javaMajor,
      javaVendor: context.toolchain.javaVendor,
      javaHome: context.toolchain.javaHome,
      gradleVersion: context.toolchain.gradleVersion,
      gradleBinary: context.toolchain.gradleBinary,
    },
    platform,
    resourceBudget: context.services.resourceBudget,
    logs: context.logger.collected(),
    jmcVersion: context.jmcVersion ?? '1.0.0',
    mappingsPath: context.toolchain.mappingsPath,
    mappingsSha256: context.toolchain.mappingsPath === undefined || !fsModule.existsSync(context.toolchain.mappingsPath)
      ? undefined
      : sha256(context.toolchain.mappingsPath),
    gradleDistributionUrl: context.toolchain.gradleVersion === undefined ? undefined : gradleDistributionUrl(context.toolchain.gradleVersion),
  });

  const reportDirectory = context.workspace.logs.path;
  fsModule.mkdirSync(reportDirectory, { recursive: true });
  const logPath = path.join(reportDirectory, 'build.log');
  const jsonPath = path.join(reportDirectory, 'build-report.json');
  const htmlPath = path.join(reportDirectory, 'build-report.html');
  const lockPath = path.join(reportDirectory, 'build-lock.json');

  fsModule.writeFileSync(logPath, renderLog(context), 'utf8');
  fsModule.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  fsModule.writeFileSync(htmlPath, renderBuildReportHtml(report), 'utf8');
  fsModule.writeFileSync(lockPath, `${JSON.stringify(report.lock, null, 2)}\n`, 'utf8');

  return { logPath, jsonPath, htmlPath, lockPath, report };
}

function gradleDistributionUrl(version: string): string {
  return `https://services.gradle.org/distributions/gradle-${version}-bin.zip`;
}

function sizeOf(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function sha256(filePath: string): string {
  try {
    return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  } catch {
    return '';
  }
}

function safeInspect(filePath: string): { entryCount: number; classCount: number } {
  try {
    const inspection = inspectJar(filePath);
    return { entryCount: inspection.entryCount, classCount: inspection.classCount };
  } catch {
    return { entryCount: 0, classCount: 0 };
  }
}

function fallbackProject(context: BuildContext): NonNullable<BuildContext['project']> {
  return {
    root: context.options.projectRoot,
    name: path.basename(context.options.projectRoot),
    buildSystem: 'unknown',
    buildTool: 'unknown',
    languages: 'unknown',
    sourceSets: [],
    localJars: [],
    resourceDirectories: [],
    modMetadata: [],
    mixinConfigs: [],
    annotationProcessors: { classNames: [], declaredInBuild: [], declaredInServices: [] },
    minecraftVersionEvidence: [],
    loader: { kind: 'unknown', confidence: 0, evidence: [] },
    hasWrapper: false,
    isMultiModule: false,
    detectedIssues: ['Project detection did not produce a result'],
    scanFileCount: 0,
  };
}

function renderLog(context: BuildContext): string {
  const lines: string[] = [];
  for (const record of context.logger.collected()) {
    const timestamp = new Date(record.timestamp).toISOString();
    const stage = record.stage === undefined ? '' : ` [${record.stage}]`;
    lines.push(`${timestamp} ${record.level.toUpperCase().padEnd(5)}${stage} ${record.message}`);
    if (record.detail !== undefined && record.detail.length > 0) {
      for (const detailLine of record.detail.split('\n')) lines.push(`    ${detailLine}`);
    }
  }
  if (context.stages.size > 0) {
    lines.push('');
    lines.push('Stage summary');
    for (const [id, status] of context.stages) {
      lines.push(`  ${id.padEnd(14)} ${status.status.padEnd(8)} ${status.durationMs} ms`);
    }
  }
  if (context.diagnostics.length > 0) {
    lines.push('');
    lines.push('Diagnostics');
    for (const diagnostic of context.diagnostics) {
      lines.push(`  ${diagnostic.severity.toUpperCase()} ${diagnostic.id}: ${diagnostic.summary}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export function readLock(filePath: string): BuildLock | undefined {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as BuildLock;
  } catch {
    return undefined;
  }
}