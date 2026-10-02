import fs from 'node:fs';
import path from 'node:path';
import { parseArguments, resolveBuildArguments, emptyArguments } from './arguments.js';
import { EXIT_CODES, JMC_VERSION, helpText } from './help.js';
import { Logger } from '../logging/logger.js';
import { ConsoleSink, paint } from '../logging/console-sink.js';
import type { LogSink } from '../logging/types.js';
import { createBuildId, createBuildContext } from '../core/context.js';
import type { BuildContext } from '../core/types.js';
import { buildOptionsFrom, executeBuild } from '../core/build-runner.js';
import { doctorToJson, renderDoctorReport, runDoctor } from './doctor.js';
import { runDependencies, runDetect, runMappings } from './inspect.js';
import { writeJson } from './json-output.js';
import { PluginHost, describePlugins } from '../plugins/plugin-host.js';
import { LoaderRegistry } from '../loader/registry.js';
import { createBuiltinLoaders } from '../loader/builtin-adapters.js';
import { createPaths, ensurePathTree } from '../platform/paths.js';
import { defaultFileSystem } from '../platform/fs.js';
import { detectPlatform } from '../platform/os.js';
import { formatBytes } from '../platform/resources.js';
import { formatUpdateNotice, UpdateService, type UpdateCheck } from '../update/update-service.js';

export interface CliStreams {
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
  stdin?: NodeJS.ReadStream;
}

export async function runCli(argv: string[], streams: CliStreams): Promise<number> {
  const { parsed } = parseArguments(argv);

  if (parsed.json) {
    const logger = createLogger(parsed, streams, true);
    return dispatchWithUpdate(parsed, streams, logger);
  }
  const logger = createLogger(parsed, streams, false);
  return dispatchWithUpdate(parsed, streams, logger);
}

interface PendingUpdateCheck {
  promise?: Promise<void>;
  cancelled: boolean;
  latest?: UpdateCheck;
}

async function dispatchWithUpdate(
  parsed: ReturnType<typeof parseArguments>['parsed'],
  streams: CliStreams,
  logger: Logger,
): Promise<number> {
  const pending = startUpdateCheck(parsed);
  try {
    const exitCode = await dispatch(parsed, streams, logger, parsed.json);
    await settleUpdateCheck(pending, logger);
    return exitCode;
  } finally {
    pending.cancelled = true;
  }
}

function startUpdateCheck(parsed: ReturnType<typeof parseArguments>['parsed']): PendingUpdateCheck {
  const pending: PendingUpdateCheck = { cancelled: false };
  if (parsed.command === 'update' || parsed.command === 'init') return pending;
  if (parsed.quiet) return pending;
  if (process.env.JMC_DISABLE_UPDATE_CHECK === '1') return pending;
  const paths = createPaths(process.env);
  try {
    ensurePathTree(paths);
  } catch {
    return pending;
  }
  const service = new UpdateService({ paths });
  pending.promise = service
    .check({ currentVersion: JMC_VERSION, offline: parsed.offline, force: false, json: parsed.json })
    .then((check) => {
      pending.latest = check;
    })
    .catch(() => undefined);
  return pending;
}

async function settleUpdateCheck(pending: PendingUpdateCheck, logger: Logger): Promise<void> {
  if (pending.promise === undefined) return;
  await pending.promise;
  if (pending.cancelled) return;
  const check = pending.latest;
  if (check === undefined || check.updateAvailable === false) return;
  for (const line of formatUpdateNotice(check)) logger.raw(line);
  await logger.flush();
}

async function runUpdateCommand(
  parsed: ReturnType<typeof parseArguments>['parsed'],
  streams: CliStreams,
  json: boolean,
): Promise<number> {
  const paths = createPaths(process.env);
  ensurePathTree(paths);
  const service = new UpdateService({ paths });
  const check = await service.check({
    currentVersion: JMC_VERSION,
    offline: parsed.offline,
    force: true,
    json,
  });
  if (json) {
    writeJson(streams.stdout, {
      command: 'update',
      currentVersion: check.currentVersion,
      latestVersion: check.latestVersion ?? null,
      updateAvailable: check.updateAvailable,
      releaseTitle: check.releaseTitle ?? null,
      releaseUrl: check.releaseUrl ?? null,
      publishedAt: check.publishedAt ?? null,
      prerelease: check.prerelease,
      summary: check.summary,
      offline: parsed.offline,
      checkedAt: check.checkedAt,
      fromCache: check.fromCache,
      failure: check.failure ?? null,
    });
    return EXIT_CODES.success;
  }
  const lines = [`Installed version: ${check.currentVersion}`];
  if (check.failure !== undefined) {
    lines.push(`Update check: unavailable (${check.failure})`);
    lines.push('JMC continues regardless; run jmc update again later.');
  } else if (check.latestVersion === undefined) {
    lines.push('Latest version: unknown');
  } else {
    lines.push(`Latest version: ${check.latestVersion}`);
    lines.push(check.updateAvailable ? 'An update is available. JMC does not install updates automatically.' : 'JMC is up to date.');
    if (check.releaseTitle !== undefined) lines.push(`Release: ${check.releaseTitle}`);
    if (check.summary.length > 0) {
      lines.push('Release notes:');
      let currentHeading: string | undefined;
      for (const entry of check.summary) {
        if (entry.heading !== undefined && entry.heading !== currentHeading) {
          currentHeading = entry.heading;
          lines.push(`  ${entry.heading}`);
          continue;
        }
        lines.push(`  - ${entry.text}`);
      }
    }
    if (check.releaseUrl !== undefined) lines.push(`GitHub: ${check.releaseUrl}`);
  }
  for (const line of lines) streams.stdout.write(`${line}\n`);
  return EXIT_CODES.success;
}

class JsonModeSink implements LogSink {
  emit(): void {
    return;
  }
}

function createLogger(parsed: ReturnType<typeof parseArguments>['parsed'], streams: CliStreams, json: boolean): Logger {
  return new Logger({
    verbose: parsed.verbose,
    quiet: parsed.quiet,
    debug: parsed.debug,
    json,
    sinks: [
      json
        ? new JsonModeSink()
        : new ConsoleSink({
            stream: streams.stdout,
            errorStream: streams.stderr,
            verbose: parsed.verbose,
            quiet: parsed.quiet,
            debug: parsed.debug,
          }),
    ],
  });
}

async function dispatch(
  parsed: ReturnType<typeof parseArguments>['parsed'],
  streams: CliStreams,
  logger: Logger,
  json: boolean,
): Promise<number> {
  if (parsed.unknownFlags.length > 0) {
    logger.failed(`Unknown option${parsed.unknownFlags.length === 1 ? '' : 's'}: ${parsed.unknownFlags.join(', ')}`);
    logger.raw('Run jmc --help to see the supported options.');
    await logger.flush();
    return EXIT_CODES.invalidUsage;
  }
  if (parsed.errors.length > 0) {
    for (const error of parsed.errors) logger.failed(error);
    await logger.flush();
    return EXIT_CODES.invalidUsage;
  }

  switch (parsed.command) {
    case 'help':
      streams.stdout.write(`${helpText()}\n`);
      return EXIT_CODES.success;
    case 'version':
      if (json) writeJson(streams.stdout, { name: 'jmc', version: JMC_VERSION, node: process.version });
      else streams.stdout.write(`jmc ${JMC_VERSION}\n`);
      return EXIT_CODES.success;
    case undefined:
      streams.stdout.write(`${helpText()}\n`);
      return json ? EXIT_CODES.success : EXIT_CODES.invalidUsage;
    case 'doctor':
      return runDoctorCommand(parsed, streams, logger, json);
    case 'detect':
      return runDetectCommand(parsed, streams, logger, json);
    case 'mappings':
      return runMappingsCommand(parsed, streams, logger, json);
    case 'dependencies':
      return runDependenciesCommand(parsed, streams, logger, json);
    case 'plugins':
      return runPluginsCommand(streams, logger, json);
    case 'cache':
      return runCacheCommand(streams, logger, json);
    case 'init':
      return runInitCommand(parsed, streams, logger, json);
    case 'update':
      return runUpdateCommand(parsed, streams, json);
    case 'build':
      return runBuildCommand(parsed, streams, logger, json);
    default:
      logger.failed(`Unknown command: ${parsed.command}`);
      await logger.flush();
      return EXIT_CODES.invalidUsage;
  }
}

async function runDoctorCommand(
  parsed: ReturnType<typeof parseArguments>['parsed'],
  streams: CliStreams,
  logger: Logger,
  json: boolean,
): Promise<number> {
  const report = await runDoctor(logger, {
    offline: parsed.offline,
    executablePath: process.argv[1],
  });
  await logger.flush();
  if (json) {
    writeJson(streams.stdout, doctorToJson(report));
  } else {
    const lines: string[] = [];
    renderDoctorReport(report, (line) => lines.push(line));
    streams.stdout.write(`${lines.join('\n')}\n`);
  }
  return report.ok ? EXIT_CODES.success : EXIT_CODES.generalFailure;
}

async function runDetectCommand(
  parsed: ReturnType<typeof parseArguments>['parsed'],
  streams: CliStreams,
  logger: Logger,
  json: boolean,
): Promise<number> {
  const projectRoot = path.resolve(parsed.positionals[0] ?? parsed.project ?? process.cwd());
  if (!defaultFileSystem.isDirectory(projectRoot)) {
    logger.failed(`Project directory does not exist: ${projectRoot}`);
    await logger.flush();
    return EXIT_CODES.invalidUsage;
  }
  const result = runDetect(logger, projectRoot);
  await logger.flush();
  if (json) writeJson(streams.stdout, result.json);
  else streams.stdout.write(`${result.lines.join('\n')}\n`);
  return EXIT_CODES.success;
}

async function runMappingsCommand(
  parsed: ReturnType<typeof parseArguments>['parsed'],
  streams: CliStreams,
  logger: Logger,
  json: boolean,
): Promise<number> {
  const target = parsed.positionals[0];
  if (target === undefined) {
    logger.failed('mappings requires a path argument, for example: jmc mappings ./mappings-26.2');
    await logger.flush();
    return EXIT_CODES.invalidUsage;
  }
  const inspection = await runMappings(logger, path.resolve(target));
  await logger.flush();
  if (json) writeJson(streams.stdout, inspection.json);
  else streams.stdout.write(`${inspection.lines.join('\n')}\n`);
  return inspection.exists ? EXIT_CODES.success : EXIT_CODES.generalFailure;
}

async function runDependenciesCommand(
  parsed: ReturnType<typeof parseArguments>['parsed'],
  streams: CliStreams,
  logger: Logger,
  json: boolean,
): Promise<number> {
  const projectRoot = path.resolve(parsed.positionals[0] ?? parsed.project ?? process.cwd());
  if (!defaultFileSystem.isDirectory(projectRoot)) {
    logger.failed(`Project directory does not exist: ${projectRoot}`);
    await logger.flush();
    return EXIT_CODES.invalidUsage;
  }
  const inspection = await runDependencies(logger, projectRoot, { offline: parsed.offline });
  await logger.flush();
  if (json) writeJson(streams.stdout, inspection.json);
  else streams.stdout.write(`${inspection.lines.join('\n')}\n`);
  return inspection.json.unresolved !== undefined && (inspection.json.unresolved as unknown[]).length > 0
    ? EXIT_CODES.generalFailure
    : EXIT_CODES.success;
}

async function runPluginsCommand(streams: CliStreams, logger: Logger, json: boolean): Promise<number> {
  const registry = new LoaderRegistry(createBuiltinLoaders());
  const paths = createPaths();
  ensurePathTree(paths);
  const host = new PluginHost(paths, registry);
  const result = await host.loadAll();
  await registry.activatePlugins();
  await logger.flush();
  const payload = {
    pluginDirectory: host.pluginDirectory(),
    builtInAdapters: registry.list().map((adapter) => ({ id: adapter.id, displayName: adapter.displayName })),
    plugins: result.loaded,
    failed: result.failed,
  };
  if (json) writeJson(streams.stdout, payload);
  else streams.stdout.write(`${describePlugins(result).join('\n')}\n`);
  return result.failed.length === 0 ? EXIT_CODES.success : EXIT_CODES.generalFailure;
}

async function runCacheCommand(streams: CliStreams, logger: Logger, json: boolean): Promise<number> {
  const paths = createPaths();
  ensurePathTree(paths);
  const { ContentCache } = await import('../cache/cache.js');
  const cache = new ContentCache({ paths, logger, offline: false, noCache: false });
  const stats = cache.stats();
  await logger.flush();
  if (json) {
    writeJson(streams.stdout, { home: paths.home, sections: stats });
    return EXIT_CODES.success;
  }
  const lines = [`JMC home: ${paths.home}`];
  for (const section of stats) lines.push(`  ${section.section.padEnd(14)} ${formatBytes(section.bytes)}`);
  streams.stdout.write(`${lines.join('\n')}\n`);
  return EXIT_CODES.success;
}

async function runInitCommand(
  parsed: ReturnType<typeof parseArguments>['parsed'],
  streams: CliStreams,
  logger: Logger,
  json: boolean,
): Promise<number> {
  const projectRoot = path.resolve(parsed.positionals[0] ?? parsed.project ?? process.cwd());
  const target = path.join(projectRoot, 'jmc.json');
  const payload = {
    version: 1,
    project: '.',
    java: { prefer: 'auto' },
    mappings: { path: null },
    output: 'build/libs/mod.jar',
    loader: 'auto',
    validation: { mixin: true, clientServer: true, bytecode: true },
  };
  defaultFileSystem.writeText(target, `${JSON.stringify(payload, null, 2)}\n`);
  await logger.flush();
  if (json) writeJson(streams.stdout, { created: target, config: payload });
  else streams.stdout.write(`Created ${target}\n`);
  return EXIT_CODES.success;
}

async function runBuildCommand(
  parsed: ReturnType<typeof parseArguments>['parsed'],
  streams: CliStreams,
  logger: Logger,
  json: boolean,
): Promise<number> {
  const resolved = resolveBuildArguments(parsed);
  if (resolved.errors.length > 0) {
    for (const error of resolved.errors) logger.failed(error);
    logger.raw('Usage: jmc <mappings> <output.jar>');
    await logger.flush();
    return EXIT_CODES.invalidUsage;
  }
  if (resolved.outputPath === undefined) {
    logger.failed('An output artifact path is required, for example: jmc mappings-26.2 mod.jar');
    logger.raw('Usage: jmc <mappings> <output.jar>');
    await logger.flush();
    return EXIT_CODES.invalidUsage;
  }
  if (!defaultFileSystem.isDirectory(resolved.projectRoot)) {
    logger.failed(`Project directory does not exist: ${resolved.projectRoot}`);
    await logger.flush();
    return EXIT_CODES.invalidUsage;
  }

  const platform = detectPlatform();
  const buildId = createBuildId();
  const options = buildOptionsFrom({
    projectRoot: resolved.projectRoot,
    mappingsPath: resolved.mappingsPath,
    outputPath: resolved.outputPath,
    minecraft: parsed.minecraft,
    loader: parsed.loader,
    java: parsed.java,
    offline: parsed.offline,
    debug: parsed.debug,
    verbose: parsed.verbose,
    quiet: parsed.quiet,
    json,
    keepWorkspace: parsed.keepWorkspace,
    runtimeTest: parsed.runtimeTest,
    noCache: parsed.noCache,
    clean: parsed.clean,
    force: parsed.force,
    yes: parsed.yes,
    buildId,
  });

  if (parsed.clean || parsed.force) {
    const cacheSection = parsed.noCache ? pathsSectionFor(options.projectRoot) : undefined;
    void cacheSection;
  }

  const context = createBuildContext({ options, logger, env: process.env, interactive: streams.stdin?.isTTY === true });
  context.jmcVersion = JMC_VERSION;
  await loadPluginsForContext(context);
  const startedAt = Date.now();

  const result = await executeBuild({ context, startedAt });
  await logger.flush();

  const outputAbsolute = path.resolve(options.projectRoot, options.outputPath);
  const summary = {
    status: result.success ? (result.warnings > 0 ? 'warning' : 'pass') : 'failed',
    buildId: result.buildId,
    project: options.projectRoot,
    output: result.artifactPath === undefined ? undefined : path.relative(options.projectRoot, result.artifactPath),
    outputAbsolute: result.artifactPath,
    failedStage: result.failedStage,
    durationMs: result.durationMs,
    stages: [...context.stages.entries()].map(([id, entry]) => ({
      stage: id,
      status: entry.status,
      durationMs: entry.durationMs,
      label: entry.label,
      messages: entry.messages,
      artifacts: entry.artifacts,
    })),
    buildPassed: result.buildPassed,
    runtimeTest: runtimeSummaryFor(context),
    runtimeTestPassed: result.runtimeTestPassed,
    diagnostics: context.diagnostics,
    warnings: result.warnings,
    workspace: options.keepWorkspace || options.debug ? context.workspace.root : undefined,
  };

  if (json) {
    writeJson(streams.stdout, summary);
  } else {
    streams.stdout.write('\n');
    if (result.success) {
      streams.stdout.write(`${paint('FINAL STATUS: [PASS]', 'green', 'bold')}\n`);
      const produced = result.artifactPath ?? outputAbsolute;
      const relative = path.relative(options.projectRoot, produced);
      streams.stdout.write(`\nOutput:\n${relative.length > 0 && !relative.startsWith('..') ? relative : produced}\n`);
      const runtimeStage = context.stages.get('RUNTIME_TEST');
      if (result.runtimeTestPassed === true) {
        streams.stdout.write(`${paint('[PASS] Runtime Smoke Test', 'green')} (executed inside an isolated sandbox)\n`);
      } else if (result.runtimeTestPassed === false) {
        streams.stdout.write(`${paint('[FAILED] Runtime Smoke Test', 'red')} (the build passed; the runtime test did not)\n`);
      } else {
        const reason = runtimeStage?.messages[0] ?? 'the runtime test was not executed';
        streams.stdout.write(`${paint('[INFO] Runtime Smoke Test', 'cyan')} was not executed: ${reason}\n`);
      }
    } else {
      streams.stdout.write(`${paint('FINAL STATUS: [FAILED]', 'red', 'bold')}\n`);
      const failedStage = result.failedStage === undefined ? 'unknown' : result.failedStage;
      streams.stdout.write(`\nFailed stage: ${failedStage}\n`);
      const primary = context.diagnostics.find((diagnostic) => diagnostic.severity === 'error' && diagnostic.stage === failedStage) ?? context.diagnostics.find((diagnostic) => diagnostic.severity === 'error');
      if (primary !== undefined) {
        streams.stdout.write(`Diagnostic: ${primary.title} - ${primary.summary}\n`);
        if (primary.cause !== undefined) streams.stdout.write(`Cause: ${primary.cause}\n`);
        for (const suggestion of primary.suggestions) streams.stdout.write(`Suggested action: ${suggestion}\n`);
      }
      streams.stdout.write(`\nWorkspace: ${context.workspace.root}\n`);
    }
  }

  if (!result.success) {
    if (!result.authorized) return EXIT_CODES.authorizationRequired;
    if (result.failedStage === 'VALIDATE') return EXIT_CODES.validationFailure;
    if (result.failedStage === 'RUNTIME_TEST') return EXIT_CODES.runtimeTestFailure;
    if (parsed.offline) return EXIT_CODES.offlineMissingArtifacts;
    return EXIT_CODES.generalFailure;
  }
  if (result.runtimeTestPassed === false) return EXIT_CODES.runtimeTestFailure;
  void platform;
  return EXIT_CODES.success;
}

function runtimeSummaryFor(context: BuildContext): Record<string, unknown> | undefined {
  const stage = context.stages.get('RUNTIME_TEST');
  if (stage === undefined) return undefined;
  const executed = stage.status === 'pass' || stage.status === 'failed';
  return {
    executed,
    outcome: stage.status,
    messages: stage.messages,
  };
}

function pathsSectionFor(projectRoot: string): string {
  return path.join(projectRoot, '.jmc-build');
}

async function loadPluginsForContext(context: ReturnType<typeof createBuildContext>): Promise<void> {
  const registry = context.services.loaderRegistry;
  if (registry.list().length === 0) {
    for (const adapter of createBuiltinLoaders()) registry.register(adapter);
  }
  const host = new PluginHost(context.paths, registry);
  await host.loadAll();
  await registry.activatePlugins();
  for (const plugin of registry.listPlugins()) {
    context.logger.debug(`Loaded plugin ${plugin.id}@${plugin.version} (${plugin.kind})`, 'DISCOVER');
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  try {
    return await runCli(argv, { stdout: process.stdout, stderr: process.stderr, stdin: process.stdin });
  } catch (error) {
    process.stderr.write(`[FAILED] JMC crashed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    return EXIT_CODES.generalFailure;
  }
}

export { emptyArguments, fs };