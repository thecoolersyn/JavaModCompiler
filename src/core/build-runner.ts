import path from 'node:path';
import type { BuildContext, BuildOptions, Stage, StageId } from '../core/types.js';
import { BuildPipeline, type PipelineResult, type StageOutcome } from '../core/pipeline.js';
import { discoverStage } from '../stages/discover.js';
import { resolveStage } from '../stages/resolve.js';
import { prepareStage } from '../stages/prepare.js';
import { compileStage } from '../stages/compile.js';
import { transformStage } from '../stages/transform.js';
import { remapStage } from '../stages/remap.js';
import { packageStage } from '../stages/package.js';
import { validateStage } from '../stages/validate.js';
import { runtimeTestStage, runtimeResultOf } from '../stages/runtime-test.js';
import { reportStage } from '../stages/report.js';
import { defaultFileSystem } from '../platform/fs.js';

export interface ExecuteBuildInput {
  context: BuildContext;
  startedAt: number;
}

export async function executeBuild(input: ExecuteBuildInput): Promise<PipelineResult> {
  const { context, startedAt } = input;
  context.jmcVersion = context.jmcVersion ?? '1.0.0';

  const pipeline = new BuildPipeline({
    continueOnWarning: true,
    stages: [
      { id: 'DISCOVER', stage: discoverStage },
      { id: 'RESOLVE', stage: resolveStage },
      { id: 'PREPARE', stage: prepareStage },
      { id: 'COMPILE', stage: compileStage },
      { id: 'TRANSFORM', stage: transformStage },
      { id: 'REMAP', stage: remapStage },
      { id: 'PACKAGE', stage: packageStage },
      { id: 'VALIDATE', stage: validateStage },
      { id: 'RUNTIME_TEST', stage: runtimeTestStage },
    ],
  });

  const discoveryOutcome = await runStage(context, pipeline, 'DISCOVER', discoverStage);
  if (discoveryOutcome === undefined) {
    return abortedResult(context, startedAt, 'DISCOVER');
  }

  await planLoader(context);

  const provisional = await pipeline.run(context, ['RESOLVE', 'PREPARE', 'COMPILE', 'TRANSFORM', 'REMAP', 'PACKAGE', 'VALIDATE', 'RUNTIME_TEST']);
  const status: 'pass' | 'failed' | 'warning' =
    provisional.success === false ? 'failed' : provisional.warnings > 0 || runtimeResultOf(context) !== undefined ? 'warning' : 'pass';
  const durationMs = Date.now() - startedAt;

  const reportInstance = reportStage({ status, startedAt, durationMs });
  await reportInstance.run(context);
  const reportStatus = context.stages.get('REPORT');
  if (reportStatus !== undefined) {
    reportStatus.status = 'pass';
    context.stages.set('REPORT', reportStatus);
  }

  const runtimeResult = runtimeResultOf(context);
  cleanupWorkspace(context, status);

  return {
    ...provisional,
    durationMs,
    runtimeTestPassed: runtimeResult === undefined || runtimeResult.performed === false ? undefined : runtimeResult.passed,
    buildPassed: provisional.success,
    authorized: context.authorized,
  };
}

async function runStage(
  context: BuildContext,
  pipeline: BuildPipeline,
  id: StageId,
  stage: Stage,
): Promise<StageOutcome | undefined> {
  const single = new BuildPipeline({ continueOnWarning: true, stages: [{ id, stage }] });
  void pipeline;
  const result = await single.run(context);
  const outcome = result.stages[0];
  if (outcome === undefined || outcome.status === 'failed') return undefined;
  return outcome;
}

async function planLoader(context: BuildContext): Promise<void> {
  const adapter = context.loaderAdapter;
  const project = context.project;
  if (adapter === undefined || project === undefined) {
    context.logger.warn('No loader adapter matched this project; stages that require a build plan will be reported', 'PREPARE');
    return;
  }
  try {
    const plan = await adapter.plan(project, context);
    context.loaderPlan = plan;
    await adapter.configureCompiler(plan, context);
    await adapter.configureMappings(plan, context);
    await adapter.configureRemapping(plan, context);
    await adapter.configurePackaging(plan, context);
    context.logger.debug(`Loader ${adapter.displayName} plan: tasks ${plan.buildTasks.join(', ') || 'none'}`, 'PREPARE');
  } catch (error) {
    context.diagnostics.push({
      id: 'loader-plan-failed',
      severity: 'error',
      title: 'Loader Planning',
      summary: `The ${adapter.displayName} adapter could not produce a build plan`,
      stage: 'PREPARE',
      detected: [(error as Error).message],
      cause: 'Adapter planning requires project metadata that could not be interpreted.',
      suggestions: ['Run jmc detect <project> to inspect what JMC detected.'],
      evidence: [],
      rawMessages: [(error as Error).message],
    });
  }
}

function abortedResult(context: BuildContext, startedAt: number, failedStage: StageId): PipelineResult {
  const durationMs = Date.now() - startedAt;
  const status = 'failed' as const;
  const reportInstance = reportStage({ status, startedAt, durationMs });
  void reportInstance;
  return {
    success: false,
    failedStage,
    warnings: 0,
    durationMs,
    stages: [...context.stages.entries()].map(([stage, entry]) => ({ stage, status: entry.status, durationMs: entry.durationMs })),
    artifactPath: context.finalArtifact,
    buildId: context.options.buildId,
    runtimeTestPassed: undefined,
    buildPassed: false,
    authorized: context.authorized,
  };
}

function cleanupWorkspace(context: BuildContext, status: 'pass' | 'failed' | 'warning'): void {
  const keep = context.options.keepWorkspace || context.options.debug || status === 'failed';
  if (keep) {
    context.logger.debug(`Workspace retained at ${context.workspace.root}`, 'REPORT');
    return;
  }
  defaultFileSystem.remove(context.workspace.root);
}

export function buildOptionsFrom(input: {
  projectRoot: string;
  mappingsPath?: string;
  outputPath: string;
  minecraft?: string;
  loader?: string;
  java?: number;
  offline: boolean;
  debug: boolean;
  verbose: boolean;
  quiet: boolean;
  json: boolean;
  keepWorkspace: boolean;
  runtimeTest: boolean;
  noCache: boolean;
  clean: boolean;
  force: boolean;
  yes: boolean;
  buildId: string;
}): BuildOptions {
  return {
    projectRoot: input.projectRoot,
    mappingsPath: input.mappingsPath,
    outputPath: input.outputPath,
    minecraftOverride: input.minecraft,
    loaderOverride: input.loader,
    javaOverride: input.java,
    offline: input.offline,
    debug: input.debug,
    verbose: input.verbose,
    quiet: input.quiet,
    json: input.json,
    keepWorkspace: input.keepWorkspace,
    runtimeTest: input.runtimeTest,
    noCache: input.noCache,
    clean: input.clean,
    force: input.force,
    assumeYes: input.yes,
    buildId: input.buildId,
  };
}

export function relativeOutputPath(context: BuildContext): string {
  const relative = path.relative(context.options.projectRoot, context.options.outputPath);
  return relative.startsWith('..') ? context.options.outputPath : relative;
}