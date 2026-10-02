import type {
  BuildContext,
  BuildOptions,
  BuildServices,
  BuildWorkspace,
  MutableArtifacts,
  MutableToolchain,
  StageId,
  StageStatus,
} from './types.js';
import { defaultFileSystem, type FileSystem } from '../platform/fs.js';
import { computeResourceBudget, type ResourceBudget } from '../platform/resources.js';
import { createPaths, ensurePathTree, type JmcPaths } from '../platform/paths.js';
import { detectPlatform } from '../platform/os.js';
import { ProcessRunner } from '../platform/process.js';
import { ContentCache } from '../cache/cache.js';
import { JavaRuntimeManager } from '../java/runtime-manager.js';
import { GradleManager } from '../gradle/manager.js';
import { GRADLE_TASK_TIMEOUT_MS } from '../stages/delegate.js';
import { MinecraftArtifactManager } from '../minecraft/artifact-manager.js';
import { MavenRepositoryResolver } from '../deps/maven-resolver.js';
import { LocalJarResolver } from '../deps/local-resolver.js';
import { TinyRemapper, type RemapperService } from '../remap/service.js';
import { DiagnosticEngine } from '../diagnostics/engine.js';
import { ApprovalService } from '../security/approval.js';
import { LoaderRegistry } from '../loader/registry.js';
import type { Logger } from '../logging/logger.js';

export interface CreateContextInput {
  options: BuildOptions;
  logger: Logger;
  env?: NodeJS.ProcessEnv;
  fsImpl?: FileSystem;
  services?: Partial<BuildServices>;
  interactive?: boolean;
}

export function createWorkspace(workspaceRoot: string, fsImpl: FileSystem = defaultFileSystem): BuildWorkspace {
  const section = (name: string): BuildWorkspace['toolchain'] => {
    const base = `${workspaceRoot}/${name}`;
    return {
      path: base,
      file: (...segments: string[]): string => `${base}/${segments.join('/')}`,
      dir: (...segments: string[]): string => `${base}/${segments.join('/')}`,
      mkdir: (...segments: string[]): string => {
        const target = `${base}/${segments.join('/')}`;
        fsImpl.ensureDir(target);
        return target;
      },
    };
  };
  for (const name of ['toolchain', 'minecraft', 'mappings', 'dependencies', 'generated', 'logs', 'output', 'stages']) {
    fsImpl.ensureDir(`${workspaceRoot}/${name}`);
  }
  return {
    root: workspaceRoot,
    readonly: section('readonly'),
    toolchain: section('toolchain'),
    minecraft: section('minecraft'),
    mappings: section('mappings'),
    dependencies: section('dependencies'),
    generated: section('generated'),
    logs: section('logs'),
    output: section('output'),
    stages: section('stages'),
  };
}

export function createBuildId(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
  const suffix = Math.floor(Math.random() * 46656).toString(36).padStart(3, '0');
  return `${stamp}-${suffix}`;
}

export function createBuildContext(input: CreateContextInput): BuildContext {
  const fsImpl = input.fsImpl ?? defaultFileSystem;
  const env = input.env ?? process.env;
  const paths = createPaths(env);
  ensurePathTree(paths);
  const platform = detectPlatform();
  const resourceBudget: ResourceBudget = computeResourceBudget(platform.cpuCount, platform.totalMemoryBytes, platform.freeMemoryBytes, env);
  const cache = new ContentCache({ paths, logger: input.logger, offline: input.options.offline, noCache: input.options.noCache });
  const workspace = createWorkspace(`${paths.workspaces}/${input.options.buildId}`, fsImpl);

  const processRunner = input.services?.process ?? new ProcessRunner(GRADLE_TASK_TIMEOUT_MS);
  const java = input.services?.java ?? new JavaRuntimeManager({ paths, logger: input.logger, offline: input.options.offline, fsImpl: fsImpl as never });
  const gradle = input.services?.gradle ?? new GradleManager({ paths, logger: input.logger, offline: input.options.offline });
  const minecraft = input.services?.minecraft ?? new MinecraftArtifactManager({ paths, logger: input.logger, cache, offline: input.options.offline });
  const resolver = input.services?.resolver ?? new MavenRepositoryResolver({ paths, logger: input.logger, cache, offline: input.options.offline, fsImpl: fsImpl as never });
  const localResolver = input.services?.localResolver ?? new LocalJarResolver({ paths, logger: input.logger, cache, offline: input.options.offline, fsImpl: fsImpl as never });
  const remapper = input.services?.remapper ?? new TinyRemapper({ paths, logger: input.logger, cache, offline: input.options.offline, fsImpl: fsImpl as never });
  const diagnostics = input.services?.diagnostics ?? new DiagnosticEngine();
  const approvals =
    input.services?.approvals ??
    new ApprovalService({
      paths,
      assumeYes: input.options.assumeYes,
      isCi: platform.isCi,
      trustEnvironmentVariable: env.JMC_TRUST_PROJECT_SCRIPTS,
      interactive: resolveInteractivity(input, platform.isCi),
      input: async (question: string) => {
        const readline = await import('node:readline/promises');
        const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
        try {
          return await rl.question(question);
        } finally {
          rl.close();
        }
      },
      output: (line: string) => {
        input.logger.warn(line, 'DISCOVER');
      },
    });
  const loaderRegistry = input.services?.loaderRegistry ?? new LoaderRegistry();

  const services: BuildServices = {
    java,
    gradle,
    process: processRunner,
    minecraft,
    resolver,
    localResolver,
    remapper,
    diagnostics,
    approvals,
    resourceBudget,
    loaderRegistry,
  };

  const context: BuildContext = {
    options: input.options,
    paths,
    logger: input.logger,
    cache,
    workspace,
    stages: new Map<StageId, StageStatus>(),
    toolchain: { notes: [] } as MutableToolchain,
    artifacts: {
      minecraft: [],
      mappings: [],
      loader: [],
      dependencies: [],
      compiled: [],
      transformed: [],
      remapped: [],
      packaged: [],
    } as MutableArtifacts,
    services,
    stageArtifacts: {},
    diagnostics: [],
    repositoriesChecked: [],
    requiresAuthorization: false,
    authorized: false,
  };
  return context;
}

function resolveInteractivity(input: CreateContextInput, isCi: boolean): boolean {
  if (input.interactive !== undefined) return input.interactive;
  const env = input.env ?? process.env;
  if (env.JMC_NON_INTERACTIVE === '1') return false;
  if (isCi) return false;
  if (env.JMC_ASSUME_NON_INTERACTIVE === '1') return false;
  if (process.env.JMC_NON_INTERACTIVE === '1') return false;
  return process.stdin.isTTY === true;
}

export type { JmcPaths };