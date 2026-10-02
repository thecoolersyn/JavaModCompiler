import { JMC_VERSION } from './cli/help.js';
import type { CliStreams } from './cli/run.js';
import type { ParsedArguments } from './cli/arguments.js';
import type { BuildOptions } from './core/types.js';
import type { BuildContext } from './core/types.js';
import type { BuildReport, BuildLock } from './report/build-report.js';
import type { ProjectDetection } from './project/detection.js';
import type { MappingDescriptor, MappingCompatibilityReport } from './mappings/types.js';
import type { DependencyResolutionResult } from './deps/model.js';
import type { ModLoaderAdapter, Diagnostic, StageStatus } from './core/types.js';
import type { LoaderDetectionResult } from './loader/detection.js';
import type { Logger } from './logging/logger.js';

import type { ArgumentParseResult } from './cli/arguments.js';
import type { LoggerOptions } from './logging/types.js';
import type { CreateContextInput } from './core/context.js';
import type { PipelineResult } from './core/pipeline.js';
import type { MappingsProbeResult } from './mappings/registry.js';
import type { ResolveRequest } from './deps/maven-resolver.js';
import type { DoctorReport } from './cli/doctor.js';
import type { RemapRequest, RemapResult } from './remap/service.js';
import type { JarInspection } from './jar/jar.js';
import type { BytecodeCheckInput, BytecodeCheckResult } from './validate/bytecode.js';
import type { MixinValidationInput, MixinValidationResult } from './validate/mixin.js';
import type { SideValidationInput, SideValidationResult } from './validate/sides.js';

export type {
  ArgumentParseResult,
  CliStreams,
  ParsedArguments,
  LoggerOptions,
  CreateContextInput,
  PipelineResult,
  MappingsProbeResult,
  ResolveRequest,
  DoctorReport,
  RemapRequest,
  RemapResult,
  JarInspection,
  BytecodeCheckInput,
  BytecodeCheckResult,
  MixinValidationInput,
  MixinValidationResult,
  SideValidationInput,
  SideValidationResult,
  BuildOptions,
  BuildContext,
  BuildReport,
  BuildLock,
  ProjectDetection,
  MappingDescriptor,
  MappingCompatibilityReport,
  DependencyResolutionResult,
  ModLoaderAdapter,
  Diagnostic,
  StageStatus,
  LoaderDetectionResult,
  Logger,
};

export interface JmcApi {
  version: string;
  runCli(argv: string[], streams: CliStreams): Promise<number>;
  parseArguments(argv: string[]): Promise<ArgumentParseResult>;
  detectProject(root: string): Promise<ProjectDetection>;
  createLogger(options: LoggerOptions): Promise<Logger>;
  createBuildContext(input: CreateContextInput): Promise<BuildContext>;
  executeBuild(input: { context: BuildContext; startedAt: number }): Promise<PipelineResult>;
  probeMappings(directory: string): Promise<MappingsProbeResult | undefined>;
  resolveDependencies(request: ResolveRequest): Promise<DependencyResolutionResult>;
  runDoctor(options: { offline: boolean }): Promise<DoctorReport>;
  renderBuildReportHtml(report: BuildReport): Promise<string>;
  remapJar(request: RemapRequest): Promise<RemapResult>;
  inspectJar(filePath: string): Promise<JarInspection>;
  analyzeBytecode(input: BytecodeCheckInput): Promise<BytecodeCheckResult>;
  validateMixins(input: MixinValidationInput): Promise<MixinValidationResult>;
  validateClientServerSides(input: SideValidationInput): Promise<SideValidationResult>;
}

export function createApi(): JmcApi {
  return {
    version: JMC_VERSION,
    runCli: async (argv, streams) => {
      const { runCli } = await import('./cli/run.js');
      return runCli(argv, streams);
    },
    parseArguments: async (argv) => {
      const { parseArguments } = await import('./cli/arguments.js');
      return parseArguments(argv);
    },
    detectProject: async (root) => {
      const { detectProject } = await import('./project/detection.js');
      return detectProject(root);
    },
    createLogger: async (options) => {
      const { Logger } = await import('./logging/logger.js');
      return new Logger(options);
    },
    createBuildContext: async (input) => {
      const { createBuildContext } = await import('./core/context.js');
      return createBuildContext(input);
    },
    executeBuild: async (input) => {
      const { executeBuild } = await import('./core/build-runner.js');
      return executeBuild(input);
    },
    probeMappings: async (directory) => {
      const { MappingRegistry } = await import('./mappings/registry.js');
      return new MappingRegistry().probeDirectory(directory);
    },
    resolveDependencies: async (request) => {
      const { MavenRepositoryResolver } = await import('./deps/maven-resolver.js');
      const { createPaths } = await import('./platform/paths.js');
      const { ContentCache } = await import('./cache/cache.js');
      const { Logger } = await import('./logging/logger.js');
      const { ConsoleSink } = await import('./logging/console-sink.js');
      const paths = createPaths();
      const logger = new Logger({
        verbose: false,
        quiet: true,
        debug: false,
        json: true,
        sinks: [new ConsoleSink({ stream: process.stderr, errorStream: process.stderr, verbose: false, quiet: true, debug: false })],
      });
      const cache = new ContentCache({ paths, logger, offline: false, noCache: false });
      const resolver = new MavenRepositoryResolver({ paths, logger, cache, offline: false });
      return resolver.resolve(request);
    },
    runDoctor: async (options) => {
      const { runDoctor } = await import('./cli/doctor.js');
      const { Logger } = await import('./logging/logger.js');
      const logger = new Logger({ verbose: false, quiet: true, debug: false, json: true, sinks: [] });
      return runDoctor(logger, options);
    },
    renderBuildReportHtml: async (report) => {
      const { renderBuildReportHtml } = await import('./report/html-report.js');
      return renderBuildReportHtml(report);
    },
    remapJar: async (request) => {
      const { TinyRemapper } = await import('./remap/service.js');
      const { createPaths } = await import('./platform/paths.js');
      const { ContentCache } = await import('./cache/cache.js');
      const { Logger } = await import('./logging/logger.js');
      const paths = createPaths();
      const logger = new Logger({ verbose: false, quiet: true, debug: false, json: true, sinks: [] });
      const cache = new ContentCache({ paths, logger, offline: false, noCache: false });
      return new TinyRemapper({ paths, logger, cache, offline: false }).remap(request);
    },
    inspectJar: async (filePath) => {
      const { inspectJar } = await import('./jar/jar.js');
      return inspectJar(filePath);
    },
    analyzeBytecode: async (input) => {
      const { analyzeBytecode } = await import('./validate/bytecode.js');
      return analyzeBytecode(input);
    },
    validateMixins: async (input) => {
      const { validateMixins } = await import('./validate/mixin.js');
      return validateMixins(input);
    },
    validateClientServerSides: async (input) => {
      const { validateClientServerSides } = await import('./validate/sides.js');
      return validateClientServerSides(input);
    },
  };
}

export async function runCli(argv: string[], streams: CliStreams): Promise<number> {
  const { runCli } = await import('./cli/run.js');
  return runCli(argv, streams);
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  return runCli(argv, { stdout: process.stdout, stderr: process.stderr, stdin: process.stdin });
}