import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectPlatform } from './os.js';

export interface ProcessRunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  input?: string;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  inheritStdio?: boolean;
  windowsHide?: boolean;
  maxBufferBytes?: number;
}

export interface ProcessRunResult {
  command: string;
  args: string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  spawnError?: string;
}

export class ProcessRunner {
  private readonly defaultTimeoutMs: number;

  constructor(defaultTimeoutMs = 30 * 60 * 1000) {
    this.defaultTimeoutMs = defaultTimeoutMs;
  }

  run(command: string, args: string[], options: ProcessRunOptions = {}): Promise<ProcessRunResult> {
    const platform = detectPlatform();
    const startedAt = Date.now();
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const maxBufferBytes = options.maxBufferBytes ?? 16 * 1024 * 1024;
    return new Promise<ProcessRunResult>((resolve) => {
      const spawnOptions: SpawnOptions = {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: options.inheritStdio === true ? ['pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
        windowsHide: options.windowsHide ?? true,
      };
      let child: ChildProcess;
      const invocation = resolveInvocation(platform.os, command, args);
      try {
        child = spawn(invocation.command, invocation.args, spawnOptions);
      } catch (error) {
        resolve({
          command,
          args,
          exitCode: null,
          signal: null,
          stdout: '',
          stderr: '',
          durationMs: Date.now() - startedAt,
          timedOut: false,
          spawnError: error instanceof Error ? error.message : String(error),
        });
        return;
      }

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;

      const append = (buffer: string, chunk: string, onData?: (data: string) => void): string => {
        onData?.(chunk);
        if (buffer.length + chunk.length > maxBufferBytes) return buffer.slice(-maxBufferBytes);
        return buffer + chunk;
      };

      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        stdout = append(stdout, chunk, options.onStdout);
      });
      child.stderr?.on('data', (chunk: string) => {
        stderr = append(stderr, chunk, options.onStderr);
      });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
        if (platform.os === 'win32') {
          spawn('taskkill', ['/pid', String(child.pid ?? -1), '/T', '/F'], { windowsHide: true });
        }
      }, timeoutMs);

      const finish = (exitCode: number | null, signal: NodeJS.Signals | null, spawnError?: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        invocation.cleanup?.();
        resolve({
          command,
          args,
          exitCode,
          signal,
          stdout,
          stderr,
          durationMs: Date.now() - startedAt,
          timedOut,
          spawnError,
        });
      };

      child.on('error', (error: Error) => finish(null, null, error.message));
      child.on('close', (code, signal) => finish(code, signal));

      if (options.input !== undefined) {
        child.stdin?.end(options.input);
      } else {
        child.stdin?.end();
      }
    });
  }

  async tryRun(
    command: string,
    args: string[],
    options: ProcessRunOptions = {},
  ): Promise<ProcessRunResult | undefined> {
    const result = await this.run(command, args, options);
    if (result.spawnError !== undefined) return undefined;
    return result;
  }

  runSync(command: string, args: string[], options: ProcessRunOptions = {}): ProcessRunResult {
    const startedAt = Date.now();
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const maxBufferBytes = options.maxBufferBytes ?? 16 * 1024 * 1024;
    const platform = detectPlatform();
    const invocation = resolveInvocation(platform.os, command, args);
    const result = spawnSync(invocation.command, invocation.args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: maxBufferBytes,
      windowsHide: options.windowsHide ?? true,
    });
    const error = result.error;
    invocation.cleanup?.();
    return {
      command,
      args,
      exitCode: result.status,
      signal: result.signal ?? null,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? (error === undefined ? '' : error.message),
      durationMs: Date.now() - startedAt,
      timedOut: error !== undefined && /ETIMEDOUT|ENOBUFS/.test((error as { code?: string }).code ?? error.message),
      spawnError: error === undefined ? undefined : error.message,
    };
  }

  which(command: string, extraPaths: string[] = []): string | undefined {
    const platform = detectPlatform();
    const pathValue = process.env.PATH ?? '';
    const entries = [...pathValue.split(platform.pathSeparator), ...extraPaths].filter((entry) => entry.length > 0);
    const suffixes = platform.os === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
    for (const entry of entries) {
      for (const suffix of suffixes) {
        const candidate = path.join(entry, command + suffix);
        try {
          const stats = fs.statSync(candidate);
          if (stats.isFile()) return candidate;
        } catch {
          continue;
        }
      }
    }
    return undefined;
  }
}

const BATCH_SAFE_ARGUMENT = /^[A-Za-z0-9_@+=:,./\\-]+$/;
let batchCounter = 0;

function quoteForBatch(value: string): string {
  const sanitized = value.replace(/[\r\n]/g, ' ');
  if (BATCH_SAFE_ARGUMENT.test(sanitized)) return sanitized;
  return `"${sanitized.replace(/%/g, '%%').replace(/"/g, '""')}"`;
}

function writeBatchShim(command: string, args: string[]): { directory: string; file: string } {
  batchCounter += 1;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `jmc-launch-${process.pid}-${batchCounter}-`));
  const file = path.join(directory, 'launch.cmd');
  const body = ['@echo off', 'setlocal', `"${command}" ${args.map(quoteForBatch).join(' ')}`, 'exit /b %ERRORLEVEL%', ''].join('\r\n');
  fs.writeFileSync(file, body, 'utf8');
  return { directory, file };
}

function removeBatchShim(directory: string): void {
  try {
    fs.rmSync(directory, { recursive: true, force: true });
  } catch {
    return;
  }
}

function resolveInvocation(
  operatingSystem: string,
  command: string,
  args: string[],
): { command: string; args: string[]; cleanup?: () => void } {
  if (operatingSystem !== 'win32') return { command, args };
  if (!/\.(bat|cmd)$/i.test(command)) return { command, args };
  const shim = writeBatchShim(command, args);
  return {
    command: process.env.ComSpec ?? 'cmd.exe',
    args: ['/d', '/s', '/c', shim.file],
    cleanup: () => {
      removeBatchShim(shim.directory);
    },
  };
}

export const defaultProcessRunner = new ProcessRunner();

export function quoteForShell(value: string): string {
  const platform = detectPlatform();
  if (platform.os === 'win32') {
    return /[\s"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  }
  return /[\s'"$`]/.test(value) ? `'${value.replace(/'/g, `'\\''`)}'` : value;
}

export function formatCommand(command: string, args: string[]): string {
  return [command, ...args].map(quoteForShell).join(' ');
}