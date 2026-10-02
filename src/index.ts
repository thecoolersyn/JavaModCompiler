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
import type { DeclaredMixinConfigReport } from './validate/mixin.js';
import type { MetadataCheckResult } from './validate/bytecode.js';
import type { SideValidationInput, SideValidationResult } from './validate/sides.js';
import type { ScriptDescriptor, ApprovalService } from './security/approval.js';
import type { GradleSelection } from './gradle/compatibility.js';
import type { GradleManager } from './gradle/manager.js';
import type { GradleProjectModel } from './project/gradle-model.js';

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
  validateDeclaredMixinConfigs(
    jarPath: string,
    metadata: Record<string, unknown>,
    metadataName: string,
  ): Promise<DeclaredMixinConfigReport>;
  checkMetadata(jarPath: string): Promise<MetadataCheckResult>;
  collectBuildScripts(projectRoot: string): Promise<ScriptDescriptor[]>;
  digestOfScripts(scripts: ScriptDescriptor[]): Promise<string>;
  createApprovalService(options: {
    home: string;
    assumeYes: boolean;
    isCi: boolean;
    trustEnvironmentVariable?: string;
    interactive: boolean;
    answer?: string;
    emitted?: string[];
  }): Promise<ApprovalService>;
  selectGradleVersion(model: GradleProjectModel | undefined): Promise<GradleSelection>;
  javaRequiredForGradleVersion(gradleVersion: string): Promise<number>;
  createGradleManager(options: { home: string; offline: boolean; quiet?: boolean }): Promise<GradleManager>;
  javaRequiredForProject(model: GradleProjectModel | undefined): Promise<number>;
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
    collectBuildScripts: async (projectRoot) => {
      const { collectBuildScripts } = await import('./security/approval.js');
      return collectBuildScripts(projectRoot);
    },
    digestOfScripts: async (scripts) => {
      const { digestOfScripts } = await import('./security/approval.js');
      return digestOfScripts(scripts);
    },
    createApprovalService: async (options) => {
      const { ApprovalService } = await import('./security/approval.js');
      const { createPaths, ensurePathTree } = await import('./platform/paths.js');
      const paths = createPaths({ ...process.env, JMC_HOME: options.home });
      ensurePathTree(paths);
      const answer = options.answer;
      const emitted = options.emitted;
      return new ApprovalService({
        paths,
        assumeYes: options.assumeYes,
        isCi: options.isCi,
        trustEnvironmentVariable: options.trustEnvironmentVariable,
        interactive: options.interactive,
        input: async () => answer,
        output: (line) => {
          if (emitted !== undefined) emitted.push(line);
          else process.stderr.write(`${line}\n`);
        },
      });
    },
    selectGradleVersion: async (model) => {
      const { selectGradleVersion } = await import('./gradle/compatibility.js');
      return selectGradleVersion(model);
    },
    javaRequiredForGradleVersion: async (gradleVersion) => {
      const { javaRequiredForGradleVersion } = await import('./gradle/manager.js');
      return javaRequiredForGradleVersion(gradleVersion);
    },
    createGradleManager: async (options) => {
      const { GradleManager } = await import('./gradle/manager.js');
      const { createPaths, ensurePathTree } = await import('./platform/paths.js');
      const { Logger } = await import('./logging/logger.js');
      const paths = createPaths({ ...process.env, JMC_HOME: options.home });
      ensurePathTree(paths);
      const quiet = options.quiet ?? true;
      const logger = new Logger({
        verbose: false,
        quiet,
        debug: false,
        json: true,
        sinks: [
          {
            emit(record) {
              if (!quiet) process.stderr.write(`[gradle] ${record.message}\n`);
            },
            async flush() {
              return undefined;
            },
          },
        ],
      });
      return new GradleManager({ paths, logger, offline: options.offline });
    },
    javaRequiredForProject: async (model) => {
      const { javaRequiredForProjectForModel } = await import('./gradle/compatibility.js');
      return javaRequiredForProjectForModel(model);
    },
    validateDeclaredMixinConfigs: async (jarPath, metadata, metadataName) => {
      const { validateDeclaredMixinConfigs } = await import('./validate/mixin.js');
      return validateDeclaredMixinConfigs(jarPath, metadata, metadataName);
    },
    checkMetadata: async (jarPath) => {
      const { checkMetadata } = await import('./validate/bytecode.js');
      return checkMetadata(jarPath);
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