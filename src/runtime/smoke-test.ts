import fs from 'node:fs';
import path from 'node:path';
import type { RuntimeTestResult } from '../core/types.js';

export interface SandboxFs {
  isDirectory(target: string): boolean;
  isFile(target: string): boolean;
  readDir(target: string): Array<{ name: string; path: string; isDirectory: boolean; isFile: boolean }>;
}

export interface CrashIndicator {
  kind: 'mixin-error' | 'exception' | 'jvm-error' | 'exit-code' | 'loader-error';
  line: string;
  lineNumber: number;
}

export interface SmokeTestOptions {
  sandboxPath: string;
  context: {
    options: { runtimeTest: boolean; debug: boolean; buildId: string; offline: boolean };
    workspace: { path: string };
    paths: { sandboxes: string };
    artifacts: { final?: string };
    toolchain: { javaHome?: string; javaMajor?: number; minecraftVersion?: string; loader?: string };
    logger: { debug(message: string, stage?: string): void; info(message: string, stage?: string): void };
    services: { process: { run(command: string, args: string[], options?: Record<string, unknown>): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }> } };
  };
  adapter: string;
  timeoutMs?: number;
}

const CRASH_PATTERNS: Array<{ kind: CrashIndicator['kind']; pattern: RegExp }> = [
  { kind: 'mixin-error', pattern: /MixinApplyError|InvalidMixinException|InvalidInjectionException|MixinTransformerError|Could not apply mixin/i },
  { kind: 'loader-error', pattern: /ModLoadingException|Failed to load mod|Could not execute entrypoint|ModContainer.*exception/i },
  { kind: 'jvm-error', pattern: /UnsupportedClassVersionError|NoClassDefFoundError|ClassNotFoundException|VerifyError|LinkageError|SIGSEGV|FATAL ERROR IN NATIVE CODE/i },
  { kind: 'exception', pattern: /^\s*(?:Caused by: )?[\w.$]+(?:Exception|Error)(?::|$)/ },
  { kind: 'exception', pattern: /\bat [\w.$]+\([\w$]+\.java:\d+\)/ },
];

export function detectCrashIndicators(text: string): CrashIndicator[] {
  const indicators: CrashIndicator[] = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string;
    if (line.trim().length === 0) continue;
    for (const rule of CRASH_PATTERNS) {
      if (rule.pattern.test(line)) {
        indicators.push({ kind: rule.kind, line: line.trim().slice(0, 400), lineNumber: index + 1 });
        break;
      }
    }
  }
  return indicators;
}

export function classifyCrash(indicators: CrashIndicator[]): {
  crashDetected: boolean;
  mixinErrors: string[];
  exceptions: string[];
  jvmErrors: string[];
} {
  const mixinErrors: string[] = [];
  const exceptions: string[] = [];
  const jvmErrors: string[] = [];
  for (const indicator of indicators) {
    if (indicator.kind === 'mixin-error') mixinErrors.push(`${indicator.lineNumber}: ${indicator.line}`);
    else if (indicator.kind === 'jvm-error') jvmErrors.push(`${indicator.lineNumber}: ${indicator.line}`);
    else if (indicator.kind === 'exception') exceptions.push(`${indicator.lineNumber}: ${indicator.line}`);
  }
  return {
    crashDetected: indicators.some((indicator) => indicator.kind !== 'exception') || exceptions.length > 0,
    mixinErrors: mixinErrors.slice(0, 50),
    exceptions: exceptions.slice(0, 50),
    jvmErrors: jvmErrors.slice(0, 50),
  };
}

export function sandboxPathFor(context: SmokeTestOptions['context'], projectName: string, version: string, buildId: string): string {
  return path.join(context.paths.sandboxes, projectName, version, buildId);
}

export async function runRuntimeSmokeTest(options: SmokeTestOptions): Promise<RuntimeTestResult> {
  const startedAt = Date.now();
  const result: RuntimeTestResult = {
    performed: false,
    passed: false,
    durationMs: 0,
    crashDetected: false,
    mixinErrors: [],
    exceptions: [],
    logPaths: [],
    reasons: [],
  };
  const artifact = options.context.artifacts.final;
  if (artifact === undefined) {
    result.reasons.push('No packaged artifact is available to test at runtime');
    result.durationMs = Date.now() - startedAt;
    return result;
  }
  const javaHome = options.context.toolchain.javaHome;
  if (javaHome === undefined) {
    result.reasons.push('No managed Java runtime is available to launch Minecraft');
    result.durationMs = Date.now() - startedAt;
    return result;
  }
  const sandbox = options.sandboxPath;
  options.context.logger.debug(`Preparing runtime sandbox at ${sandbox}`, 'RUNTIME_TEST');
  const launcher = locateLauncher(options.sandboxPath);
  if (launcher === undefined) {
    result.reasons.push(
      'The sandbox does not contain a Minecraft installation. JMC never launches the user system installation; a sandbox must be provisioned before a runtime test can run.',
    );
    result.durationMs = Date.now() - startedAt;
    return result;
  }
  const modsDirectory = path.join(sandbox, 'mods');
  options.context.logger.debug(`Copying the artifact into ${modsDirectory}`, 'RUNTIME_TEST');
  result.performed = true;
  const run = await options.context.services.process.run(launcher.command, launcher.args, {
    cwd: sandbox,
    env: {
      ...process.env,
      JAVA_HOME: javaHome,
      PATH: `${path.join(javaHome, 'bin')}${path.delimiter}${process.env.PATH ?? ''}`,
    },
    timeoutMs: options.timeoutMs ?? 300_000,
  });
  const combined = `${run.stdout}\n${run.stderr}`;
  const classified = classifyCrash(detectCrashIndicators(combined));
  result.crashDetected = classified.crashDetected;
  result.mixinErrors = classified.mixinErrors;
  result.exceptions = [...classified.exceptions, ...classified.jvmErrors];
  result.exitCode = run.exitCode ?? undefined;
  result.logPaths = [path.join(sandbox, 'logs')];
  if (run.timedOut) {
    result.reasons.push('The Minecraft process did not exit before the smoke test timeout; startup was not proven successful');
  } else if (run.exitCode !== 0) {
    result.reasons.push(`The Minecraft process exited with code ${run.exitCode ?? 'unknown'}`);
  } else if (result.crashDetected) {
    result.reasons.push('The Minecraft process logged errors during startup');
  } else {
    result.passed = true;
    result.reasons.push('Minecraft started and exited cleanly inside the JMC sandbox');
  }
  result.durationMs = Date.now() - startedAt;
  return result;
}

function locateLauncher(sandboxPath: string): { command: string; args: string[] } | undefined {
  const fs = defaultSandboxFs();
  const versionDir = fs.isDirectory(path.join(sandboxPath, 'versions')) ? path.join(sandboxPath, 'versions') : undefined;
  if (versionDir === undefined) return undefined;
  for (const entry of fs.readDir(versionDir)) {
    if (!entry.isDirectory) continue;
    for (const script of ['launcher.json', 'launcher', 'run.sh', 'Launch.bat']) {
      const scriptPath = path.join(entry.path, script);
      if (!fs.isFile(scriptPath)) continue;
      return { command: 'bash', args: [scriptPath] };
    }
  }
  return undefined;
}

function defaultSandboxFs(): SandboxFs {
  return {
    isDirectory: (target: string): boolean => {
      try {
        return fs.statSync(target).isDirectory();
      } catch {
        return false;
      }
    },
    isFile: (target: string): boolean => {
      try {
        return fs.statSync(target).isFile();
      } catch {
        return false;
      }
    },
    readDir: (target: string): Array<{ name: string; path: string; isDirectory: boolean; isFile: boolean }> => {
      try {
        return fs.readdirSync(target, { withFileTypes: true }).map((entry) => ({
          name: entry.name,
          path: path.join(target, entry.name),
          isDirectory: entry.isDirectory(),
          isFile: entry.isFile(),
        }));
      } catch {
        return [];
      }
    },
  };
}