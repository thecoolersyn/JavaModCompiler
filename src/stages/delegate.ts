import path from 'node:path';
import type {
  BuildContext,
  Diagnostic,
  Stage,
  StageResult,
} from '../core/types.js';
import { formatCommand, type ProcessRunResult } from '../platform/process.js';
import { defaultFileSystem } from '../platform/fs.js';
import { fileUriForPath } from '../platform/uri.js';
import { collectRepositories } from './resolve.js';
import { gradleEnvironment, gradleJavaArgs } from '../loader/base-adapter.js';

export interface DelegateExecutionInput {
  context: BuildContext;
  plan: NonNullable<BuildContext['loaderPlan']>;
  tasks: string[];
  stage: 'COMPILE' | 'TRANSFORM' | 'REMAP' | 'PACKAGE';
}

export interface DelegateExecutionResult {
  invocations: Array<{ task: string; result: ProcessRunResult; command: string }>;
  succeeded: boolean;
  diagnostics: Diagnostic[];
  rawOutput: string;
}

export const GRADLE_TASK_TIMEOUT_MS = 45 * 60 * 1000;

export function writeRepositoryInitScript(context: BuildContext): string | undefined {
  const project = context.project;
  if (project === undefined || project.buildSystem !== 'gradle') return undefined;
  const fs = defaultFileSystem;
  const repositories = collectRepositories(project.gradle?.repositories ?? []);
  const mavenUrls = repositories.filter((repository) => repository.kind === 'maven').map((repository) => repository.url);
  const resolvedRepositories = [
    ...new Set((context.dependencies?.roots.map((node) => node.repositoryId).filter((id): id is string => id !== undefined) ?? [])),
  ];
  if (mavenUrls.length === 0 && resolvedRepositories.length === 0) return undefined;
  const scriptPath = context.workspace.toolchain.file('jmc-repositories.init.gradle');

  const lines: string[] = [];
  lines.push('def jmcMavenUrls = [');
  for (const url of mavenUrls) lines.push(`    '${url}',`);
  lines.push(']');
  lines.push('def jmcCachedRepositories = [');
  for (const id of resolvedRepositories) lines.push(`    '${id}': '${uriForCache(context, id)}',`);
  lines.push(']');
  lines.push('');
  lines.push('settingsEvaluated { settings ->');
  lines.push('    settings.pluginManagement.repositories {');
  lines.push("        gradlePluginPortal()");
  for (const url of mavenUrls) lines.push(`        maven { url = '${url}' }`);
  lines.push('    }');
  lines.push('}');
  lines.push('');
  lines.push('allprojects {');
  lines.push('    buildscript {');
  lines.push('        repositories {');
  lines.push('            gradlePluginPortal()');
  lines.push('            mavenCentral()');
  for (const url of mavenUrls) lines.push(`            maven { url = '${url}' }`);
  lines.push('        }');
  lines.push('    }');
  lines.push('    afterEvaluate {');
  lines.push('        if (repositories.isEmpty()) {');
  lines.push('            repositories {');
  lines.push('                jmcCachedRepositories.each { name, location -> maven { name = name; url = location } }');
  lines.push('                jmcMavenUrls.each { location -> maven { url = location } }');
  lines.push('            }');
  lines.push('        }');
  lines.push('    }');
  lines.push('}');
  fs.writeText(scriptPath, `${lines.join('\n')}\n`);
  return scriptPath;
}

function uriForCache(context: BuildContext, repositoryId: string): string {
  const directory = path.join(context.paths.cacheMaven, repositoryId);
  return fileUriForPath(directory);
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/[^\w.-]/g, '_');
  } catch {
    return url.replace(/[^\w.-]/g, '_');
  }
}

export function gradleUserHomeFor(context: BuildContext): string {
  return context.workspace.toolchain.dir('gradle-user-home');
}

export function projectStagingRoot(context: BuildContext): string {
  const project = context.project;
  if (project === undefined) return context.workspace.root;
  return context.workspace.readonly.mkdir('project');
}

export async function stageProjectCopy(context: BuildContext): Promise<string> {
  const project = context.project;
  const fs = defaultFileSystem;
  const destination = projectStagingRoot(context);
  if (project === undefined) return destination;
  const ignore = new Set(['.git', '.gradle', 'build', '.idea', '.vscode', 'node_modules', '.jmc-build']);
  const copy = (from: string, to: string): void => {
    fs.ensureDir(to);
    for (const entry of fs.readDir(from)) {
      if (ignore.has(entry.name)) continue;
      const target = path.join(to, entry.name);
      if (entry.isDirectory) copy(entry.path, target);
      else if (entry.isFile) fs.copy(entry.path, target);
    }
  };
  copy(project.root, destination);
  return destination;
}

export async function executeGradleTasks(input: DelegateExecutionInput): Promise<DelegateExecutionResult> {
  const { context, plan, tasks } = input;
  const projectDir = context.workspace.readonly.path.endsWith('project')
    ? context.workspace.readonly.path
    : context.workspace.readonly.mkdir('project');
  const launcher = await resolveLauncher(context, projectDir);
  const gradleUserHome = gradleUserHomeFor(context);
  const invocations: Array<{ task: string; result: ProcessRunResult; command: string }> = [];
  const rawChunks: string[] = [];
  const diagnostics: Diagnostic[] = [];

  const environment = gradleEnvironment(context, context.toolchain.javaHome, gradleUserHome);
  const initScript = writeRepositoryInitScript(context);
  if (initScript !== undefined) {
    environment.JMC_INIT_SCRIPT = initScript;
  }
  for (const [key, value] of Object.entries(plan.properties)) {
    environment[`JMC_${key.toUpperCase().replace(/[.\-]/g, '_')}`] = value;
  }

  for (const task of tasks) {
    const args = [
      ...gradleJavaArgs(context),
      ...launcher.prefixArguments,
      ...plan.gradleArguments,
      ...(initScript === undefined ? [] : ['--init-script', initScript]),
      ...plan.buildTaskArguments,
      task,
    ];
    const command = formatCommand(launcher.command, args);
    context.logger.debug(`$ ${command}`, input.stage);
    const result = await context.services.process.run(launcher.command, args, {
      cwd: projectDir,
      env: environment,
      timeoutMs: GRADLE_TASK_TIMEOUT_MS,
      onStdout: (chunk) => context.logger.raw(chunk),
      onStderr: (chunk) => context.logger.raw(chunk),
    });
    invocations.push({ task, result, command });
    rawChunks.push(`$ ${command}\n${result.stdout}\n${result.stderr}`);
    if (result.timedOut) {
      diagnostics.push({
        id: 'gradle-timeout',
        severity: 'error',
        title: 'Build System',
        summary: `Gradle task ${task} exceeded the execution timeout`,
        stage: input.stage,
        detected: [`task: ${task}`, `timeout: ${result.durationMs} ms`],
        cause: 'The delegated build did not finish within the allocated time.',
        suggestions: ['Re-run with a longer timeout or reduce build parallelism.', 'Check the build log for a task that waits on input.'],
        evidence: [command],
        rawMessages: result.stdout.split(/\r?\n/).slice(-30),
      });
      return { invocations, succeeded: false, diagnostics, rawOutput: rawChunks.join('\n') };
    }
    if (result.spawnError !== undefined) {
      diagnostics.push({
        id: 'gradle-spawn-failed',
        severity: 'error',
        title: 'Build System',
        summary: `The Gradle launcher could not be started: ${result.spawnError}`,
        stage: input.stage,
        detected: [launcher.command, launcher.description],
        cause: result.spawnError,
        suggestions: ['Verify the Gradle distribution was downloaded successfully.', 'Check the JMC cache for the Gradle section.'],
        evidence: [command],
        rawMessages: [],
      });
      return { invocations, succeeded: false, diagnostics, rawOutput: rawChunks.join('\n') };
    }
    if (result.exitCode !== 0) {
      const classified = context.services.diagnostics.classify(
        {
          stage: input.stage,
          rawOutput: `${result.stdout}\n${result.stderr}`,
          detectedJavaTarget: context.project?.javaTarget,
          activeJavaMajor: context.toolchain.javaMajor,
          requestedJavaMajor: context.options.javaOverride,
          detectedMinecraft: context.project?.minecraftVersion,
          detectedLoader: context.project?.loader.kind,
          detectedBuildSystem: context.project?.buildSystem,
          mappingsFormat: context.mappingsDescriptor?.format,
          mappingsVersion: context.mappingsDescriptor?.minecraft.version,
          evidence: [`task: ${task}`, `exit code: ${result.exitCode ?? 'null'}`],
        },
      );
      diagnostics.push(...classified);
      return { invocations, succeeded: false, diagnostics, rawOutput: rawChunks.join('\n') };
    }
  }

  return { invocations, succeeded: true, diagnostics, rawOutput: rawChunks.join('\n') };
}

export interface LauncherResolution {
  command: string;
  prefixArguments: string[];
  description: string;
}

export async function resolveLauncher(context: BuildContext, projectDir: string): Promise<LauncherResolution> {
  const fs = defaultFileSystem;
  const platformOs = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';
  const wrapper = path.join(projectDir, platformOs === 'win32' ? 'gradlew.bat' : 'gradlew');
  if (fs.isFile(wrapper)) {
    if (platformOs !== 'win32') {
      try {
        const mode = (await import('node:fs')).statSync(wrapper).mode;
        if ((mode & 0o111) === 0) (await import('node:fs')).chmodSync(wrapper, 0o755);
      } catch {
        context.logger.warn('The project Gradle wrapper is not executable; invoking it through the shell instead', 'COMPILE');
        return { command: 'sh', prefixArguments: [wrapper], description: 'gradlew via sh' };
      }
    }
    return { command: wrapper, prefixArguments: [], description: 'project Gradle wrapper' };
  }
  const managed = context.toolchain.gradleBinary;
  if (managed === undefined || !fs.isFile(managed)) {
    throw new Error('No Gradle launcher is available: the project has no wrapper and no managed distribution was prepared');
  }
  return { command: managed, prefixArguments: [], description: `JMC-managed Gradle ${context.toolchain.gradleVersion ?? ''}` };
}

export type { Stage };