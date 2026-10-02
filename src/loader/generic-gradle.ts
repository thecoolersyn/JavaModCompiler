import path from 'node:path';
import type {
  BuildContext,
  Diagnostic,
  LoaderAdapterProfile,
  LoaderPlan,
  RuntimeTestResult,
} from '../core/types.js';
import type { ProjectDetection } from '../project/detection.js';
import { BaseLoaderAdapter, collectProducedJars, selectFinalArtifact } from './base-adapter.js';
import { defaultFileSystem } from '../platform/fs.js';
import { readJarManifest } from '../jar/manifest.js';
import { jarEntryNames } from '../jar/jar.js';

export interface GenericAdapterOptions {
  preferProjectTasks: boolean;
  buildTasks?: string[];
  remapTasks?: string[];
  jarTasks?: string[];
  extraGradleArguments?: string[];
  gradleProperties?: Record<string, string>;
}

export class GenericGradleAdapter extends BaseLoaderAdapter {
  override readonly id: string = 'generic-gradle';
  override readonly displayName: string = 'Generic Gradle';
  private readonly options: GenericAdapterOptions;

  constructor(options: GenericAdapterOptions = { preferProjectTasks: true }) {
    super();
    this.options = options;
  }

  override detect(project: ProjectDetection): LoaderAdapterProfile | undefined {
    if (project.gradle === undefined) return undefined;
    return {
      id: this.id,
      displayName: this.displayName,
      buildTasks: this.resolveTasks(project),
      manifestType: this.detectManifestType(project),
      notes: [
        'Delegates to the project build system rather than reimplementing loader-specific logic.',
        'The build runs inside the JMC isolated workspace with a managed JDK and Gradle user home.',
      ],
    };
  }

  private detectManifestType(project: ProjectDetection): string | undefined {
    for (const metadata of project.modMetadata) {
      if (metadata.kind === 'META-INF/neoforge.mods.toml') return 'neoforge';
      if (metadata.kind === 'META-INF/mods.toml') return 'forge';
      if (metadata.kind === 'fabric.mod.json') return 'fabric';
      if (metadata.kind === 'quilt.mod.json') return 'quilt';
    }
    return undefined;
  }

  private resolveTasks(project: ProjectDetection): string[] {
    if (this.options.buildTasks !== undefined) return this.options.buildTasks;
    const available = project.gradle?.tasksOfInterest ?? [];
    const candidates = ['build', 'assemble', 'remapJar', 'buildAndRemapJar', 'remap', 'jar', 'shadowJar', 'bundleJar', 'reobfJar', 'createMojmapToNamedJar'];
    const resolved: string[] = [];
    for (const candidate of candidates) {
      if (available.includes(candidate)) {
        resolved.push(candidate);
        break;
      }
    }
    if (resolved.length === 0) resolved.push('build');
    return resolved;
  }

  protected override buildTasks(project: ProjectDetection): string[] {
    return this.resolveTasks(project);
  }

  protected override remapTasks(): string[] {
    return this.options.remapTasks ?? ['remapJar', 'buildAndRemapJar', 'remap', 'reobfJar', 'remapMinecraftJar'];
  }

  protected override jarTasks(): string[] {
    return this.options.jarTasks ?? ['jar', 'shadowJar', 'bundleJar'];
  }

  protected override requiredJava(project: ProjectDetection, context: BuildContext): number | undefined {
    if (context.options.javaOverride !== undefined) return context.options.javaOverride;
    if (project.gradle?.javaToolchain !== undefined) return project.gradle.javaToolchain;
    if (project.gradle?.targetCompatibility !== undefined) return project.gradle.targetCompatibility;
    return project.javaTarget;
  }

  override async plan(project: ProjectDetection, context: BuildContext): Promise<LoaderPlan> {
    const plan = await super.plan(project, context);
    for (const [key, value] of Object.entries(this.options.gradleProperties ?? {})) {
      plan.properties[key] = value;
    }
    for (const argument of this.options.extraGradleArguments ?? []) {
      if (!plan.gradleArguments.includes(argument)) plan.gradleArguments.push(argument);
    }
    const available = project.gradle?.tasksOfInterest ?? [];
    plan.remapTask = this.remapTasks().find((candidate) => available.includes(candidate));
    plan.jarTask = this.jarTasks().find((candidate) => available.includes(candidate));
    const compileCandidates = ['compileJava', 'classes', 'buildClasses'];
    for (const candidate of compileCandidates) {
      if (available.includes(candidate)) {
        plan.compileTask = candidate;
        break;
      }
    }
    if (plan.compileTask === undefined) plan.compileTask = 'classes';
    return plan;
  }

  override async validate(artifactPath: string, context: BuildContext): Promise<Diagnostic[]> {
    const diagnostics = await super.validate(artifactPath, context);
    const fs = defaultFileSystem;
    if (!fs.isFile(artifactPath)) return diagnostics;
    const entries = jarEntryNames(artifactPath);
    const manifest = readJarManifest(artifactPath);
    const expectedType = this.detectManifestType(context.project as ProjectDetection);
    if (expectedType !== undefined) {
      const markers: Record<string, string> = {
        fabric: 'fabric.mod.json',
        forge: 'META-INF/mods.toml',
        neoforge: 'META-INF/neoforge.mods.toml',
        quilt: 'quilt.mod.json',
      };
      const marker = markers[expectedType];
      if (marker !== undefined && !entries.some((entry) => entry.toLowerCase() === marker.toLowerCase())) {
        diagnostics.push({
          id: 'manifest-missing',
          severity: 'error',
          title: 'Loader Metadata',
          summary: `The project declares ${expectedType} but the artifact does not contain ${marker}`,
          stage: 'VALIDATE',
          suggestions: [
            `Ensure the ${expectedType} metadata file is inside src/main/resources so it is packaged into the JAR.`,
          ],
          evidence: [`expected entry: ${marker}`, `artifact: ${path.basename(artifactPath)}`],
          rawMessages: [],
        });
      }
    }
    if (manifest?.['Multi-Release'] === undefined) {
      void manifest;
    }
    return diagnostics;
  }

  collectCandidates(project: ProjectDetection, context: BuildContext): string[] {
    const fs = defaultFileSystem;
    const roots = [
      path.join(context.workspace.root, 'project', 'build', 'libs'),
      path.join(project.root, 'build', 'libs'),
    ].filter((candidate) => fs.isDirectory(candidate));
    const jars: string[] = [];
    for (const root of roots) jars.push(...collectProducedJars(root));
    return [...new Set(jars)];
  }

  selectArtifact(candidates: string[], project: ProjectDetection): string | undefined {
    const baseName = this.expectedBaseName(project);
    return selectFinalArtifact(candidates, baseName, project);
  }

  expectedBaseName(project: ProjectDetection): string {
    const properties = project.gradle?.properties ?? {};
    const candidates = [properties['archivesBaseName'], properties['modId'], properties['rootProject.name'], properties['archivesBaseName ']];
    for (const candidate of candidates) {
      if (candidate !== undefined && candidate.trim().length > 0) return candidate.trim();
    }
    const metadata = project.modMetadata[0];
    if (metadata?.modId !== undefined) return metadata.modId;
    return project.name;
  }

  override async runtimeTest(): Promise<RuntimeTestResult> {
    return {
      performed: false,
      passed: false,
      durationMs: 0,
      crashDetected: false,
      mixinErrors: [],
      exceptions: [],
      logPaths: [],
      reasons: ['The generic adapter cannot construct a runtime sandbox without loader-specific launch metadata'],
    };
  }
}

export function createGenericAdapterForProject(project: ProjectDetection): GenericGradleAdapter {
  return new GenericGradleAdapter({ preferProjectTasks: true });
}