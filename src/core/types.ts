import type { Logger } from '../logging/logger.js';
import type { JmcPaths } from '../platform/paths.js';
import type { ContentCache } from '../cache/cache.js';
import type { ResourceBudget } from '../platform/resources.js';
import type { ProcessRunner } from '../platform/process.js';
import type { JavaRuntimeManager } from '../java/runtime-manager.js';
import type { GradleManager } from '../gradle/manager.js';
import type { MinecraftArtifactManager } from '../minecraft/artifact-manager.js';
import type { MavenRepositoryResolver } from '../deps/maven-resolver.js';
import type { LocalJarResolver } from '../deps/local-resolver.js';
import type { RemapperService } from '../remap/service.js';
import type { DiagnosticEngine } from '../diagnostics/engine.js';
import type { ApprovalService } from '../security/approval.js';
import type { LoaderRegistry } from '../loader/registry.js';
import type { ProjectDetection } from '../project/detection.js';
import type {
  MappingCompatibilityReport,
  MappingDescriptor,
} from '../mappings/types.js';
import type {
  DependencyNode,
  DependencyResolutionResult,
} from '../deps/model.js';

export interface StageStatus {
  id: string;
  label: string;
  status: 'pass' | 'failed' | 'warning' | 'skipped' | 'running';
  durationMs: number;
  startedAt: number;
  messages: string[];
  diagnostics: Diagnostic[];
  artifacts: string[];
}

export interface StageResult {
  artifacts?: string[];
  diagnostics?: Diagnostic[];
  skipped?: boolean;
  warnings?: string[];
}

export interface Stage {
  readonly id: string;
  readonly label: string;
  run(context: BuildContext): Promise<StageResult>;
}

export type StageId =
  | 'DISCOVER'
  | 'RESOLVE'
  | 'PREPARE'
  | 'COMPILE'
  | 'TRANSFORM'
  | 'REMAP'
  | 'PACKAGE'
  | 'VALIDATE'
  | 'RUNTIME_TEST'
  | 'REPORT';

export const STAGE_ORDER: StageId[] = [
  'DISCOVER',
  'RESOLVE',
  'PREPARE',
  'COMPILE',
  'TRANSFORM',
  'REMAP',
  'PACKAGE',
  'VALIDATE',
  'RUNTIME_TEST',
  'REPORT',
];

export interface Diagnostic {
  id: string;
  severity: 'error' | 'warning' | 'info';
  title: string;
  summary: string;
  stage?: StageId | string;
  detected?: string[];
  expected?: string;
  actual?: string;
  cause?: string;
  suggestions: string[];
  evidence: string[];
  rawMessages: string[];
  file?: string;
  line?: number;
  column?: number;
}

export interface ResolvedDependencyArtifact {
  coordinate: string;
  file?: string;
  kind: 'maven' | 'local' | 'generated' | 'minecraft' | 'loader' | 'mapping' | 'gradle' | 'java';
  configuration?: string;
  direct: boolean;
}

export interface ToolchainState {
  javaMajor?: number;
  javaHome?: string;
  javaVersionText?: string;
  javaVendor?: string;
  gradleVersion?: string;
  gradleHome?: string;
  gradleBinary?: string;
  loader?: string;
  loaderVersion?: string;
  minecraftVersion?: string;
  mappingsPath?: string;
  mappingsFormat?: string;
  mappingsNamespace?: string;
  buildSystem?: string;
}

export interface BuildContext {
  readonly options: BuildOptions;
  readonly paths: JmcPaths;
  readonly logger: Logger;
  readonly cache: ContentCache;
  readonly workspace: BuildWorkspace;
  readonly stages: Map<StageId, StageStatus>;
  readonly toolchain: MutableToolchain;
  readonly artifacts: MutableArtifacts;
  readonly services: BuildServices;
  project?: ProjectDetection;
  mappingsDescriptor?: MappingDescriptor;
  mappingCompatibility?: MappingCompatibilityReport;
  dependencies?: DependencyResolutionResult;
  dependencyGraph?: DependencyNode[];
  repositoriesChecked: string[];
  loaderAdapter?: ModLoaderAdapter;
  loaderPlan?: LoaderPlan;
  finalArtifact?: string;
  stageArtifacts: Record<string, string[]>;
  diagnostics: Diagnostic[];
  requiresAuthorization: boolean;
  authorized: boolean;
  jmcVersion?: string;
}

export interface MutableToolchain extends ToolchainState {
  notes: string[];
}

export interface MutableArtifacts {
  minecraft: string[];
  mappings: string[];
  loader: string[];
  dependencies: string[];
  compiled: string[];
  transformed: string[];
  remapped: string[];
  packaged: string[];
  final?: string;
}

export interface BuildOptions {
  projectRoot: string;
  mappingsPath?: string;
  outputPath: string;
  minecraftOverride?: string;
  loaderOverride?: string;
  javaOverride?: number;
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
  buildId: string;
  assumeYes: boolean;
}

export interface BuildWorkspace {
  root: string;
  readonly: WorkspaceSection;
  toolchain: WorkspaceSection;
  minecraft: WorkspaceSection;
  mappings: WorkspaceSection;
  dependencies: WorkspaceSection;
  generated: WorkspaceSection;
  logs: WorkspaceSection;
  output: WorkspaceSection;
  stages: WorkspaceSection;
}

export interface WorkspaceSection {
  path: string;
  file(...segments: string[]): string;
  dir(...segments: string[]): string;
  mkdir(...segments: string[]): string;
}

export interface BuildServices {
  java: JavaRuntimeManager;
  gradle: GradleManager;
  process: ProcessRunner;
  minecraft: MinecraftArtifactManager;
  resolver: MavenRepositoryResolver;
  localResolver: LocalJarResolver;
  remapper: RemapperService;
  diagnostics: DiagnosticEngine;
  approvals: ApprovalService;
  resourceBudget: ResourceBudget;
  loaderRegistry: LoaderRegistry;
}

export interface LoaderAdapterProfile {
  id: string;
  displayName: string;
  buildTasks: string[];
  mappingsCoordinates?: Array<{ groupId: string; artifactId: string }>;
  compilerRelease?: number;
  clientSourceSets?: string[];
  serverSourceSets?: string[];
  manifestType?: string;
  notes: string[];
}

export interface ModLoaderAdapter {
  readonly id: string;
  readonly displayName: string;
  detect(project: ProjectDetection): LoaderAdapterProfile | undefined;
  plan(project: ProjectDetection, context: BuildContext): Promise<LoaderPlan>;
  configureCompiler(plan: LoaderPlan, context: BuildContext): Promise<void>;
  configureMappings(plan: LoaderPlan, context: BuildContext): Promise<void>;
  configureRemapping(plan: LoaderPlan, context: BuildContext): Promise<void>;
  configurePackaging(plan: LoaderPlan, context: BuildContext): Promise<void>;
  validate(artifactPath: string, context: BuildContext): Promise<Diagnostic[]>;
  runtimeTest?(sandboxPath: string, context: BuildContext): Promise<RuntimeTestResult>;
}

export interface LoaderPlan {
  adapterId: string;
  buildTasks: string[];
  javaMajor?: number;
  remapTask?: string;
  jarTask?: string;
  compileTask?: string;
  notes: string[];
  gradleArguments: string[];
  buildTaskArguments: string[];
  properties: Record<string, string>;
}

export interface RuntimeTestResult {
  performed: boolean;
  passed: boolean;
  exitCode?: number;
  durationMs: number;
  crashDetected: boolean;
  mixinErrors: string[];
  exceptions: string[];
  logPaths: string[];
  reasons: string[];
}

export interface ValidationReport {
  checks: Array<{ id: string; label: string; status: 'pass' | 'warning' | 'failed' | 'skipped'; detail: string[] }>;
  diagnostics: Diagnostic[];
}