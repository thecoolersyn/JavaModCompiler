import path from 'node:path';
import type {
  BuildContext,
  Diagnostic,
  LoaderAdapterProfile,
  LoaderPlan,
  ModLoaderAdapter,
  RuntimeTestResult,
} from '../core/types.js';
import type { ProjectDetection } from '../project/detection.js';
import { defaultFileSystem } from '../platform/fs.js';
import { formatCommand, type ProcessRunResult } from '../platform/process.js';
import { readJarManifest } from '../jar/manifest.js';
import { inspectJar, jarEntryNames } from '../jar/jar.js';
import { javaBaselineForVersion } from '../minecraft/version.js';
import { runRuntimeSmokeTest } from '../runtime/smoke-test.js';

export interface GradleInvocation {
  launcher: string;
  args: string[];
  projectDir: string;
  javaHome?: string;
  gradleUserHome?: string;
}

export interface DelegateBuildResult {
  invocations: Array<{ task: string; result: ProcessRunResult; command: string }>;
  succeeded: boolean;
  producedJars: string[];
}

export interface BaseAdapterOptions {
  id: string;
  displayName: string;
}

export abstract class BaseLoaderAdapter implements ModLoaderAdapter {
  abstract readonly id: string;
  abstract readonly displayName: string;


  abstract detect(project: ProjectDetection): LoaderAdapterProfile | undefined;

  async plan(project: ProjectDetection, context: BuildContext): Promise<LoaderPlan> {
    const tasks = this.buildTasks(project);
    const javaMajor = this.requiredJava(project, context);
    const buildId = context.options.buildId;
    const properties: Record<string, string> = {
      'jmc.buildId': buildId,
      'jmc.projectRoot': project.root,
      'jmc.workspace': context.workspace.root,
    };
    const gradleArguments = [
      '--no-daemon',
      '--stacktrace',
      `--project-cache-dir=${context.workspace.toolchain.dir('gradle-project-cache')}`,
      `-Pjmc.buildId=${buildId}`,
    ];
    const buildTaskArguments: string[] = [];
    const notes: string[] = [];
    if (context.options.debug) gradleArguments.push('--info', '--debug');
    else if (context.options.verbose) gradleArguments.push('--info');
    if (context.options.offline) gradleArguments.push('--offline');
    const plan: LoaderPlan = {
      adapterId: this.id,
      buildTasks: tasks,
      javaMajor,
      notes,
      gradleArguments,
      buildTaskArguments,
      properties,
    };
    return plan;
  }

  async configureCompiler(plan: LoaderPlan, context: BuildContext): Promise<void> {
    const javaMajor = plan.javaMajor;
    if (javaMajor === undefined) return;
    const installation = await context.services.java.resolve({ minMajor: javaMajor });
    context.toolchain.javaMajor = installation.version;
    context.toolchain.javaHome = installation.javaHome;
    context.toolchain.javaVersionText = installation.versionText;
    context.toolchain.javaVendor = installation.vendor;
  }

  async configureMappings(plan: LoaderPlan, context: BuildContext): Promise<void> {
    void plan;
    void context;
  }

  async configureRemapping(plan: LoaderPlan, context: BuildContext): Promise<void> {
    const declared = context.project?.gradle?.tasksOfInterest ?? [];
    const remap = this.remapTasks().find((task) => declared.includes(task));
    const jar = this.jarTasks().find((task) => declared.includes(task));
    plan.remapTask = remap;
    plan.jarTask = jar ?? (declared.includes('jar') ? 'jar' : undefined);
  }

  async configurePackaging(plan: LoaderPlan, context: BuildContext): Promise<void> {
    void plan;
    void context;
  }

  async validate(artifactPath: string, context: BuildContext): Promise<Diagnostic[]> {
    const fs = defaultFileSystem;
    if (!fs.isFile(artifactPath)) {
      return [
        {
          id: 'artifact-missing',
          severity: 'error',
          title: 'Artifact',
          summary: `The expected artifact ${path.basename(artifactPath)} was not produced`,
          stage: 'VALIDATE',
          suggestions: ['Inspect the build log for the failing packaging task.'],
          evidence: [`looked for: ${artifactPath}`],
          rawMessages: [],
        },
      ];
    }
    const inspection = inspectJar(artifactPath);
    const diagnostics: Diagnostic[] = [];
    if (inspection.classCount === 0) {
      diagnostics.push({
        id: 'no-classes',
        severity: 'warning',
        title: 'Artifact Content',
        summary: 'The produced JAR contains no class files',
        stage: 'VALIDATE',
        suggestions: ['Confirm the source set was compiled and that classes were not filtered out.'],
        evidence: [`entries: ${inspection.entryCount}`],
        rawMessages: [],
      });
    }
    const manifest = readJarManifest(artifactPath);
    if (manifest === undefined) {
      diagnostics.push({
        id: 'missing-manifest',
        severity: 'warning',
        title: 'Manifest',
        summary: 'The produced JAR has no META-INF/MANIFEST.MF',
        stage: 'VALIDATE',
        suggestions: ['Add a manifest to the JAR through the build configuration.'],
        evidence: [],
        rawMessages: [],
      });
    }
    void context;
    return diagnostics;
  }

  async runtimeTest(sandboxPath: string, context: BuildContext): Promise<RuntimeTestResult> {
    return runRuntimeSmokeTest({ sandboxPath, context: context as never, adapter: this.id });
  }

  protected abstract buildTasks(project: ProjectDetection): string[];
  protected abstract remapTasks(): string[];
  protected abstract jarTasks(): string[];
  protected abstract requiredJava(project: ProjectDetection, context: BuildContext): number | undefined;
}

export function gradleEnvironment(context: BuildContext, javaHome: string | undefined, gradleUserHome: string | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    JMC_BUILD_ID: context.options.buildId,
    JMC_WORKSPACE: context.workspace.root,
    JMC_OFFLINE: context.options.offline ? '1' : '0',
  };
  if (javaHome !== undefined) {
    env.JAVA_HOME = javaHome;
    env.PATH = `${path.join(javaHome, 'bin')}${path.delimiter}${process.env.PATH ?? ''}`;
  }
  if (gradleUserHome !== undefined) {
    env.GRADLE_USER_HOME = gradleUserHome;
  }
  return env;
}

export function gradleTaskArguments(context: BuildContext): string[] {
  const extra: string[] = [];
  if (context.options.clean) extra.push('--rerun-tasks');
  if (context.options.force) extra.push('--refresh-dependencies');
  return extra;
}

export function gradleJavaArgs(context: BuildContext): string[] {
  const heap = Math.floor(context.services.resourceBudget.gradleMaxHeapBytes / (1024 * 1024));
  return [`-Dorg.gradle.jvmargs=-Xmx${heap}m -XX:MaxMetaspaceSize=512m`, '-Dfile.encoding=UTF-8'];
}

export function describeInvocation(invocation: GradleInvocation): string {
  return formatCommand(invocation.launcher, invocation.args);
}

export function collectProducedJars(directory: string, skipDirectories: string[] = []): string[] {
  const fs = defaultFileSystem;
  if (!fs.isDirectory(directory)) return [];
  const jars: string[] = [];
  const stack = [directory];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    for (const entry of fs.readDir(current)) {
      if (entry.isDirectory) {
        if (skipDirectories.includes(entry.name)) continue;
        stack.push(entry.path);
        continue;
      }
      if (entry.name.toLowerCase().endsWith('.jar')) jars.push(entry.path);
    }
  }
  return jars.sort();
}

export function scoreArtifactCandidate(jarPath: string, expectedBaseName: string, project: ProjectDetection): number {
  let score = 0;
  const base = path.basename(jarPath);
  const normalizedBase = base.replace(/\.jar$/, '');
  if (normalizedBase === expectedBaseName) score += 100;
  if (normalizedBase.includes(expectedBaseName)) score += 40;
  if (/-sources\.jar$|-javadoc\.jar$|-dev\.jar$/i.test(base)) score -= 100;
  if (/-remapped\.jar$/i.test(base)) score += 50;
  if (/-mapped/i.test(base)) score += 30;
  const entries = jarEntryNames(jarPath);
  if (entries.some((entry) => /fabric\.mod\.json|mods\.toml|neoforge\.mods\.toml|quilt\.mod\.json/.test(entry))) score += 60;
  if (entries.some((entry) => entry === 'META-INF/MANIFEST.MF')) score += 5;
  if (normalizedBase.toLowerCase().includes('sources')) score -= 50;
  void project;
  return score;
}

export function selectFinalArtifact(candidates: string[], expectedBaseName: string, project: ProjectDetection): string | undefined {
  let best: string | undefined;
  let bestScore = -Infinity;
  for (const candidate of candidates) {
    const score = scoreArtifactCandidate(candidate, expectedBaseName, project);
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  if (best !== undefined && bestScore <= 0) return undefined;
  return best;
}

export function requiredJavaForProject(project: ProjectDetection): number {
  if (project.javaTarget !== undefined) return project.javaTarget;
  if (project.minecraftVersion !== undefined) return javaBaselineForVersion(project.minecraftVersion);
  return 17;
}