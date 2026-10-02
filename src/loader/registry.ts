import path from 'node:path';
import type {
  BuildContext,
  Diagnostic,
  LoaderAdapterProfile,
  LoaderPlan,
  ModLoaderAdapter,
  RuntimeTestResult,
} from '../core/types.js';
import type {
  PluginDescriptor,
  PluginRegistration as PluginsPluginRegistration,
  ValidatorContext as PluginsValidatorContext,
  ValidatorPlugin as PluginsValidatorPlugin,
} from '../plugins/types.js';
import type { LoaderDetectionResult } from './detection.js';
import type { ProjectDetection } from '../project/detection.js';
import { javaBaselineForVersion } from '../minecraft/version.js';

export type AdapterPluginDescriptor = PluginDescriptor;

export type PluginRegistration = PluginsPluginRegistration;

export type ValidatorContext = PluginsValidatorContext;

export type ValidatorPlugin = PluginsValidatorPlugin;

export class LoaderRegistry {
  private readonly adapters: ModLoaderAdapter[] = [];
  private readonly plugins: PluginRegistration[] = [];

  constructor(adapters?: ModLoaderAdapter[]) {
    if (adapters !== undefined) {
      for (const adapter of adapters) this.adapters.push(adapter);
    }
  }

  register(adapter: ModLoaderAdapter): void {
    if (this.adapters.some((existing) => existing.id === adapter.id)) return;
    this.adapters.push(adapter);
  }

  registerPlugin(plugin: PluginRegistration): void {
    this.plugins.push(plugin);
    if (plugin.adapter !== undefined) this.register(plugin.adapter);
  }

  list(): ModLoaderAdapter[] {
    return this.adapters.slice();
  }

  listPlugins(): AdapterPluginDescriptor[] {
    return this.plugins.map((plugin) => plugin.descriptor);
  }

  find(id: string): ModLoaderAdapter | undefined {
    return this.adapters.find((adapter) => adapter.id === id);
  }

  async activatePlugins(): Promise<void> {
    for (const plugin of this.plugins) {
      if (plugin.activate !== undefined) await plugin.activate();
    }
  }

  async validatorsFor(context: ValidatorContext): Promise<Diagnostic[]> {
    const diagnostics: Diagnostic[] = [];
    for (const plugin of this.plugins) {
      if (plugin.validator === undefined) continue;
      diagnostics.push(...(await plugin.validator.validate(context)));
    }
    return diagnostics;
  }

  resolve(
    project: ProjectDetection,
    detection: LoaderDetectionResult,
    options: { minimumConfidence?: number; forced?: string } = {},
  ): { adapter: ModLoaderAdapter; profile: LoaderAdapterProfile } | undefined {
    if (options.forced !== undefined) {
      const forced = this.find(options.forced);
      if (forced !== undefined) {
        const profile = forced.detect(project) ?? baseProfile(forced.id, forced.displayName, ['Adapter selected explicitly by --loader']);
        return { adapter: forced, profile };
      }
      return undefined;
    }
    const minimumConfidence = options.minimumConfidence ?? MINIMUM_ADAPTER_CONFIDENCE;
    if (detection.confidence < minimumConfidence) return undefined;
    const byId = new Map<string, ModLoaderAdapter>();
    for (const adapter of this.adapters) byId.set(adapter.id, adapter);
    const matching = byId.get(detection.kind);
    if (matching !== undefined) {
      const profile = matching.detect(project);
      if (profile !== undefined) return { adapter: matching, profile };
    }
    return undefined;
  }

  genericFallback(): ModLoaderAdapter | undefined {
    return this.adapters.find((adapter) => adapter.id === 'generic-gradle');
  }
}

export const MINIMUM_ADAPTER_CONFIDENCE = 40;

export function profileConfidence(profile: LoaderAdapterProfile | undefined, detection: LoaderDetectionResult): number {
  if (profile === undefined) return -1;
  return Math.max(detection.confidence, 50);
}

export function baseProfile(id: string, displayName: string, notes: string[] = []): LoaderAdapterProfile {
  return { id, displayName, buildTasks: [], notes };
}

export function resolveJavaMajor(project: ProjectDetection, override?: number): number {
  if (override !== undefined) return override;
  if (project.javaTarget !== undefined) return project.javaTarget;
  if (project.minecraftVersion !== undefined) return javaBaselineForVersion(project.minecraftVersion);
  return 17;
}

export function ensurePlan(adapter: ModLoaderAdapter, tasks: string[]): LoaderPlan {
  return {
    adapterId: adapter.id,
    buildTasks: tasks,
    notes: [],
    gradleArguments: [],
    buildTaskArguments: [],
    properties: {},
  };
}

export function firstExistingTask(candidates: string[], available: string[]): string | undefined {
  for (const candidate of candidates) {
    if (available.some((task) => task === candidate || task.endsWith(`:${candidate}`))) return candidate;
  }
  return undefined;
}

export function jarNameWithoutExtension(project: ProjectDetection): string {
  const fromGradle = project.gradle?.properties?.archivesBaseName ?? project.gradle?.properties?.rootProject_name;
  if (fromGradle !== undefined && fromGradle.length > 0) return fromGradle;
  const metadata = project.modMetadata[0];
  if (metadata?.modId !== undefined) return metadata.modId;
  return project.name;
}

export function projectDirectoryName(project: ProjectDetection): string {
  return path.basename(project.root);
}

export function noRuntimeTest(): RuntimeTestResult {
  return {
    performed: false,
    passed: false,
    durationMs: 0,
    crashDetected: false,
    mixinErrors: [],
    exceptions: [],
    logPaths: [],
    reasons: ['This loader adapter does not provide a runtime sandbox entry point'],
  };
}

export function diagnostic(diagnosticInput: Partial<Diagnostic> & { id: string; summary: string }): Diagnostic {
  return {
    severity: diagnosticInput.severity ?? 'error',
    title: diagnosticInput.title ?? 'Validation',
    suggestions: diagnosticInput.suggestions ?? [],
    evidence: diagnosticInput.evidence ?? [],
    rawMessages: diagnosticInput.rawMessages ?? [],
    ...diagnosticInput,
  } as Diagnostic;
}