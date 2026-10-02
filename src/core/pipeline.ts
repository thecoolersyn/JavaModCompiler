import path from 'node:path';
import type {
  BuildContext,
  Diagnostic,
  Stage,
  StageId,
  StageResult,
  StageStatus,
} from './types.js';
import { formatDiagnostic } from '../diagnostics/engine.js';

export interface StageOutcome {
  stage: StageId;
  status: StageStatus['status'];
  durationMs: number;
}

export interface PipelineResult {
  success: boolean;
  failedStage?: StageId;
  warnings: number;
  durationMs: number;
  stages: StageOutcome[];
  artifactPath?: string;
  buildId: string;
  authorized: boolean;
  runtimeTestPassed?: boolean;
  buildPassed: boolean;
}

export interface PipelineOptions {
  stages: Array<{ id: StageId; stage: Stage }>;
  continueOnWarning: boolean;
}

export class BuildPipeline {
  private readonly options: PipelineOptions;

  constructor(options: PipelineOptions) {
    this.options = options;
  }

  async run(context: BuildContext, only?: StageId[]): Promise<PipelineResult> {
    const selected =
      only === undefined
        ? this.options.stages
        : this.options.stages.filter((entry) => only.includes(entry.id));
    return this.execute(context, selected);
  }

  private async execute(context: BuildContext, stages: Array<{ id: StageId; stage: Stage }>): Promise<PipelineResult> {
    const startedAt = Date.now();
    const outcomes: StageOutcome[] = [];
    let failedStage: StageId | undefined;
    let warnings = 0;
    let success = true;
    let runtimeTestPassed: boolean | undefined;

    for (const entry of stages) {
      const status: StageStatus = {
        id: entry.id,
        label: entry.stage.label,
        status: 'running',
        durationMs: 0,
        startedAt: Date.now(),
        messages: [],
        diagnostics: [],
        artifacts: [],
      };
      context.stages.set(entry.id, status);
      const stageStart = Date.now();
      context.logger.debug(`Stage ${entry.id} starting`, entry.id);

      let result: StageResult;
      try {
        result = await entry.stage.run(context);
      } catch (error) {
        if (process.env.JMC_TRACE === '1') context.logger.raw(error instanceof Error ? (error.stack ?? error.message) : String(error));
        const diagnostics = context.services.diagnostics.classifyError(error, entry.id, {
          detectedJavaTarget: context.project?.javaTarget,
          activeJavaMajor: context.toolchain.javaMajor,
          requestedJavaMajor: context.options.javaOverride,
          detectedMinecraft: context.project?.minecraftVersion,
          detectedLoader: context.project?.loader.kind,
          detectedBuildSystem: context.project?.buildSystem,
          mappingsFormat: context.mappingsDescriptor?.format,
          mappingsVersion: context.mappingsDescriptor?.minecraft.version,
        });
        for (const diagnostic of diagnostics) {
          status.diagnostics.push(diagnostic);
          context.diagnostics.push(diagnostic);
        }
        status.status = 'failed';
        status.durationMs = Date.now() - stageStart;
        outcomes.push({ stage: entry.id, status: 'failed', durationMs: status.durationMs });
        failedStage = entry.id;
        success = false;
        this.reportStageFailure(context, entry.id, status, diagnostics);
        break;
      }

      const artifacts = (result.artifacts ?? []).filter(
        (artifact) => typeof artifact === 'string' && artifact.length > 0 && status.artifacts.includes(artifact) === false,
      );
      for (const artifact of artifacts) status.artifacts.push(artifact);
      context.stageArtifacts[entry.id] = artifacts;
      for (const artifact of artifacts) this.recordArtifact(context, entry.id, artifact);

      for (const warning of result.warnings ?? []) {
        status.messages.push(warning);
        context.logger.warn(warning, entry.id);
      }
      for (const diagnostic of result.diagnostics ?? []) {
        status.diagnostics.push(diagnostic);
        context.diagnostics.push(diagnostic);
        if (diagnostic.severity === 'warning') warnings += 1;
      }

      const skipped = result.skipped === true;
      const hasErrors = status.diagnostics.some((diagnostic) => diagnostic.severity === 'error');
      status.status = skipped ? 'skipped' : hasErrors ? 'failed' : 'pass';
      status.durationMs = Date.now() - stageStart;
      outcomes.push({ stage: entry.id, status: status.status, durationMs: status.durationMs });

      if (hasErrors) {
        failedStage = entry.id;
        success = false;
        const errors = status.diagnostics.filter((item) => item.severity === 'error');
        this.reportStageFailure(context, entry.id, status, errors);
        for (const diagnostic of errors.slice(1)) {
          context.logger.warn(`${diagnostic.title}: ${diagnostic.summary}`, entry.id);
        }
        break;
      }

      if (skipped) {
        context.logger.info(`Skipped ${entry.stage.label}`, entry.id);
      } else if (result.warnings !== undefined && result.warnings.length > 0) {
        context.logger.pass(entry.stage.label, entry.id);
      } else {
        context.logger.pass(entry.stage.label, entry.id);
      }

      for (const diagnostic of result.diagnostics ?? []) {
        if (diagnostic.severity === 'warning') {
          context.logger.warn(`${diagnostic.title}: ${diagnostic.summary}`, entry.id);
        }
      }

      if (entry.id === 'RUNTIME_TEST') {
        runtimeTestPassed = (context as BuildContext & { runtimeTestResult?: { passed: boolean } }).runtimeTestResult?.passed;
      }

      void this.options.continueOnWarning;
    }

    const durationMs = Date.now() - startedAt;
    return {
      success,
      failedStage,
      warnings,
      durationMs,
      stages: outcomes,
      artifactPath: context.finalArtifact,
      buildId: context.options.buildId,
      runtimeTestPassed,
      buildPassed: success,
      authorized: context.authorized,
    };
  }

  private recordArtifact(context: BuildContext, stage: StageId, artifactPath: string): void {
    if (typeof artifactPath !== 'string' || artifactPath.length === 0) return;
    const target = artifactBucketFor(context, stage);
    if (target === undefined) return;
    if (target.includes(artifactPath)) return;
    target.push(artifactPath);
  }

  private reportStageFailure(context: BuildContext, stage: StageId, status: StageStatus, diagnostics: Diagnostic[]): void {
    if (diagnostics.length === 0) {
      context.logger.failed(`${status.label} failed`, stage);
      return;
    }
    const primary = diagnostics.find((diagnostic) => diagnostic.severity === 'error') ?? diagnostics[0];
    if (primary === undefined) {
      context.logger.failed(`${status.label} failed`, stage);
      return;
    }
    context.logger.failed(`${primary.title}: ${primary.summary}`, stage);
    context.logger.detail(formatDiagnostic(primary).slice(1).join('\n'));
    for (const diagnostic of diagnostics) {
      if (diagnostic.id === primary.id) continue;
      if (diagnostic.rawMessages.length > 0) context.logger.detail(diagnostic.rawMessages.join('\n'));
    }
    for (const diagnostic of diagnostics.slice(1)) {
      context.logger.warn(`${diagnostic.title}: ${diagnostic.summary}`, stage);
    }
  }
}

function artifactBucketFor(context: BuildContext, stage: StageId): string[] | undefined {
  switch (stage) {
    case 'RESOLVE':
      return context.artifacts.dependencies;
    case 'PREPARE':
      return context.artifacts.mappings;
    case 'COMPILE':
      return context.artifacts.compiled;
    case 'TRANSFORM':
      return context.artifacts.transformed;
    case 'REMAP':
      return context.artifacts.remapped;
    case 'PACKAGE':
      return context.artifacts.packaged;
    default:
      return undefined;
  }
}

export function stageNameOf(stage: StageId): string {
  return stage.charAt(0) + stage.slice(1).toLowerCase();
}

export function workspaceReportPath(context: BuildContext, fileName: string): string {
  return context.workspace.logs.file(fileName);
}

export function projectArtifactName(context: BuildContext, baseName: string): string {
  return path.join(context.workspace.output.path, baseName);
}

export type { StageResult };