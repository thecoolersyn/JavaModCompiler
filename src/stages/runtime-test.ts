import path from 'node:path';
import type { BuildContext, RuntimeTestResult, Stage, StageResult } from '../core/types.js';
import { defaultFileSystem } from '../platform/fs.js';

export const runtimeTestStage: Stage = {
  id: 'RUNTIME_TEST',
  label: 'Runtime Smoke Test',
  async run(context: BuildContext): Promise<StageResult> {
    if (!context.options.runtimeTest) {
      return { skipped: true, warnings: ['Runtime testing was not requested; add --runtime-test to enable it'] };
    }
    const artifactPath = context.finalArtifact;
    if (artifactPath === undefined) {
      return { skipped: true, warnings: ['No packaged artifact is available to test'] };
    }
    const sandbox = sandboxPathFor(context);
    defaultFileSystem.ensureDir(sandbox);
    provisionSandbox(context, sandbox);

    const adapter = context.loaderAdapter;
    let result: RuntimeTestResult;
    if (adapter?.runtimeTest !== undefined) {
      result = await adapter.runtimeTest(sandbox, context);
    } else {
      result = {
        performed: false,
        passed: false,
        durationMs: 0,
        crashDetected: false,
        mixinErrors: [],
        exceptions: [],
        logPaths: [],
        reasons: ['No loader adapter provides a runtime sandbox entry point for this project'],
      };
    }
    runtimeResults.set(context, result);
    if (result.performed === false) {
      return {
        skipped: true,
        warnings: result.reasons.map((reason) => `Runtime smoke test was not executed: ${reason}`),
      };
    }
    const warnings = result.reasons.map((reason) => `Runtime smoke test: ${reason}`);
    return {
      skipped: false,
      artifacts: result.logPaths,
      warnings,
      diagnostics: result.passed
        ? []
        : [
            {
              id: 'runtime-smoke-test',
              severity: 'error',
              title: 'Runtime Smoke Test',
              summary: result.reasons[0] ?? 'The runtime smoke test did not pass',
              stage: 'RUNTIME_TEST',
              detected: [
                `exit code: ${result.exitCode ?? 'not reported'}`,
                `duration: ${result.durationMs} ms`,
                ...result.mixinErrors.slice(0, 5),
                ...result.exceptions.slice(0, 5),
              ],
              cause: 'Minecraft was launched inside a disposable JMC sandbox and did not start cleanly.',
              suggestions: [
                'Inspect the sandbox logs retained for this build.',
                'Re-run with --keep-workspace and --debug to retain the full sandbox.',
              ],
              evidence: result.logPaths,
              rawMessages: [...result.mixinErrors, ...result.exceptions],
            },
          ],
    };
  },
};

const runtimeResults = new WeakMap<BuildContext, RuntimeTestResult>();

export function runtimeResultOf(context: BuildContext): RuntimeTestResult | undefined {
  return runtimeResults.get(context);
}

export function sandboxPathFor(context: BuildContext): string {
  const projectName = context.project?.name ?? 'project';
  const version = context.toolchain.minecraftVersion ?? 'unknown';
  return path.join(context.paths.sandboxes, projectName, version, context.options.buildId);
}

function provisionSandbox(context: BuildContext, sandbox: string): void {
  const fs = defaultFileSystem;
  for (const directory of ['mods', 'config', 'logs', 'world', 'resourcepacks', 'versions']) {
    fs.ensureDir(path.join(sandbox, directory));
  }
  const artifact = context.finalArtifact;
  if (artifact !== undefined) {
    fs.copy(artifact, path.join(sandbox, 'mods', path.basename(artifact)));
  }
  fs.writeText(
    path.join(sandbox, 'jmc-sandbox.json'),
    `${JSON.stringify(
      {
        buildId: context.options.buildId,
        project: context.project?.root ?? context.options.projectRoot,
        minecraftVersion: context.toolchain.minecraftVersion,
        loader: context.toolchain.loader,
        javaHome: context.toolchain.javaHome,
        createdAt: new Date().toISOString(),
        note: 'This sandbox is disposable. JMC never launches a user Minecraft installation.',
      },
      null,
      2,
    )}\n`,
  );
  context.logger.debug(`Sandbox prepared at ${sandbox}`, 'RUNTIME_TEST');
}