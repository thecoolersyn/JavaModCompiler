import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from '../logging/logger.js';
import { ConsoleSink, paint } from '../logging/console-sink.js';
import { detectPlatform, platformLabel } from '../platform/os.js';
import { createPaths, directorySize, ensurePathTree } from '../platform/paths.js';
import { formatBytes } from '../platform/resources.js';
import { defaultProcessRunner } from '../platform/process.js';
import { javaVersionToMajor } from '../java/jdk-model.js';

export type DoctorStatus = 'pass' | 'warning' | 'failed';

export interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  detail: string[];
  remedy?: string[];
}

export interface DoctorReport {
  checks: DoctorCheck[];
  ok: boolean;
  paths: {
    home: string;
    cache: string;
  };
}

export async function runDoctor(logger: Logger, options: { offline: boolean; executablePath?: string; env?: NodeJS.ProcessEnv }): Promise<DoctorReport> {
  const env = options.env ?? process.env;
  const platform = detectPlatform();
  const paths = createPaths(env);
  const checks: DoctorCheck[] = [];

  checks.push(checkInstallation(logger, options.executablePath, env));
  checks.push(checkPath(env));
  checks.push({
    name: 'OS',
    status: 'pass',
    detail: [`Operating system: ${platformLabel(platform)}`, `platform identifier: ${platform.os}`],
  });
  checks.push({
    name: 'Architecture',
    status: 'pass',
    detail: [
      `CPU architecture: ${platform.arch}`,
      `process architecture: ${process.arch}`,
      `libc: ${platform.libc}`,
      `Java platform key: ${javaPlatformKeySafe(platform.arch)}`,
    ],
  });
  checks.push(checkJava());
  checks.push(checkGradle(paths, options.offline));
  checks.push(checkGit());
  checks.push(await checkNetwork(options.offline));
  checks.push(checkCache(paths));
  ensurePathTree(paths);
  checks.push(checkDiskSpace(paths));
  checks.push(checkMavenLocal(env));
  checks.push(checkMinecraftCache(paths));

  const ok = !checks.some((check) => check.status === 'failed');
  return { checks, ok, paths: { home: paths.home, cache: paths.cache } };
}

function javaPlatformKeySafe(arch: string): string {
  if (arch === 'arm64') return 'aarch64';
  if (arch === 'x64') return 'x86_64';
  return arch;
}

function checkInstallation(logger: Logger, executablePath: string | undefined, env: NodeJS.ProcessEnv): DoctorCheck {
  const resolved = executablePath ?? process.argv[1] ?? 'unknown';
  const detail = [`Executable: ${resolved}`, `Runtime: ${process.version}`, `JMC home: ${createPaths(env).home}`];
  void logger;
  const exists = resolved !== 'unknown' && fs.existsSync(resolved);
  if (!exists && resolved !== 'unknown') {
    return {
      name: 'JMC executable',
      status: 'failed',
      detail,
      remedy: ['The launcher could not be found at the recorded path. Re-run the installer to repair the installation.'],
    };
  }
  return { name: 'JMC executable', status: 'pass', detail };
}

function checkPath(env: NodeJS.ProcessEnv): DoctorCheck {
  const platform = detectPlatform();
  const entries = (env.PATH ?? '').split(platform.pathSeparator).filter((entry) => entry.length > 0);
  const home = createPaths(env);
  const binEntryPresent = entries.some((entry) => path.resolve(entry) === path.resolve(home.bin));
  const commandName = platform.os === 'win32' ? 'jmc.cmd' : 'jmc';
  const launcherPresent = entries.some((entry) => fs.existsSync(path.join(entry, commandName)) || fs.existsSync(path.join(entry, 'jmc')));
  const detail = [
    `PATH entries: ${entries.length}`,
    `JMC bin directory on PATH: ${binEntryPresent}`,
    `"${commandName}" resolvable on PATH: ${launcherPresent}`,
    `JMC bin directory: ${home.bin}`,
  ];
  if (launcherPresent) return { name: 'PATH', status: 'pass', detail };
  return {
    name: 'PATH',
    status: 'warning',
    detail,
    remedy: [
      `Add ${home.bin} to your PATH so "jmc" resolves from any directory.`,
      'On Windows run the PowerShell installer; on macOS and Linux run the shell installer.',
    ],
  };
}

function checkJava(): DoctorCheck {
  const detected: string[] = [];
  const home = process.env.JAVA_HOME;
  if (home !== undefined && home.length > 0) {
    detected.push(`JAVA_HOME=${home}`);
  }
  const which = defaultProcessRunner.which('java', [home === undefined ? '' : path.join(home, 'bin')]);
  if (which !== undefined) {
    const result = defaultProcessRunner.runSync(which, ['-version'], { timeoutMs: 20_000 });
    const combined = `${result.stdout}\n${result.stderr}`;
    const version = /version "([^"]+)"/.exec(combined)?.[1];
    detected.push(`java on PATH: ${which}`);
    if (version !== undefined) detected.push(`java version: ${version}`);
    const major = javaVersionToMajor(version ?? '');
    if (major !== undefined) detected.push(`java major: ${major}`);
  }
  const hasLocal = detectManagedRuntimes().length > 0;
  detected.push(`JMC managed runtimes: ${detectManagedRuntimes().join(', ') || 'none'}`);
  if (which === undefined && !hasLocal) {
    return {
      name: 'Java',
      status: 'warning',
      detail: detected,
      remedy: ['No JDK is installed. JMC downloads a managed JDK on demand; pre-seeding one avoids a first-build download.'],
    };
  }
  return { name: 'Java', status: 'pass', detail: detected };
}

function detectManagedRuntimes(): string[] {
  const paths = createPaths();
  const root = paths.runtimes;
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

function checkGradle(paths: ReturnType<typeof createPaths>, offline: boolean): DoctorCheck {
  const root = paths.cacheGradle;
  const managed = fs.existsSync(root)
    ? fs
        .readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith('gradle-'))
        .map((entry) => entry.name)
    : [];
  const onPath = defaultProcessRunner.which('gradle');
  const detail = [
    `JMC managed Gradle distributions: ${managed.length > 0 ? managed.join(', ') : 'none'}`,
    `Gradle on PATH: ${onPath ?? 'not found'}`,
    `Managed Gradle directory: ${root}`,
  ];
  if (onPath === undefined && managed.length === 0) {
    return {
      name: 'Gradle',
      status: 'pass',
      detail: [
        ...detail,
        'No system Gradle is installed. JMC downloads a matching distribution into its own cache, which is the intended configuration.',
      ],
    };
  }
  if (onPath !== undefined && offline) {
    return { name: 'Gradle', status: 'pass', detail };
  }
  return { name: 'Gradle', status: 'pass', detail };
}

function checkGit(): DoctorCheck {
  const which = defaultProcessRunner.which('git');
  const detail = [`git on PATH: ${which ?? 'not found'}`];
  if (which === undefined) {
    return {
      name: 'Git',
      status: 'warning',
      detail,
      remedy: ['Git is optional. It is only needed for projects that fetch sources or submodules from version control.'],
    };
  }
  const version = defaultProcessRunner.runSync(which, ['--version'], { timeoutMs: 10_000 });
  const line = version.stdout.split('\n')[0];
  if (line !== undefined) detail.push(line);
  return { name: 'Git', status: 'pass', detail };
}

async function checkNetwork(offline: boolean): Promise<DoctorCheck> {
  if (offline) {
    return { name: 'Network', status: 'pass', detail: ['Offline mode requested; no network checks were performed.'] };
  }
  const hosts = ['https://repo1.maven.org/maven2/', 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json', 'https://services.gradle.org/'];
  const detail: string[] = [];
  let failures = 0;
  for (const host of hosts) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const response = await awaitFetch(host, controller.signal);
      clearTimeout(timer);
      detail.push(`${host} -> HTTP ${response.status}`);
      if (response.status >= 400) failures += 1;
    } catch (error) {
      detail.push(`${host} -> ${(error as Error).message}`);
      failures += 1;
    }
  }
  if (failures === 0) return { name: 'Network', status: 'pass', detail };
  return {
    name: 'Network',
    status: failures === hosts.length ? 'failed' : 'warning',
    detail,
    remedy: [
      'Check connectivity, proxy settings and TLS trust for these hosts.',
      'Use --offline to build from the JMC cache without network access.',
    ],
  };
}

function awaitFetch(url: string, signal: AbortSignal): Promise<{ status: number }> {
  return fetch(url, { method: 'HEAD', signal }).then((response) => ({ status: response.status }));
}

function checkCache(paths: ReturnType<typeof createPaths>): DoctorCheck {
  const writable = probeWritable(paths.cache);
  const sizes = directorySize(paths);
  const detail = [
    `JMC home: ${paths.home}`,
    `cache total: ${formatBytes(sizes.totalBytes)}`,
    ...Object.entries(sizes.bySection)
      .filter(([, bytes]) => bytes > 0)
      .map(([section, bytes]) => `  ${section}: ${formatBytes(bytes)}`),
    `cache writable: ${writable}`,
  ];
  if (!writable) {
    return {
      name: 'Cache',
      status: 'failed',
      detail,
      remedy: [`Ensure the process can write to ${paths.cache}. Set JMC_HOME to a writable location if needed.`],
    };
  }
  return { name: 'Cache', status: 'pass', detail };
}

function probeWritable(target: string): boolean {
  try {
    fs.mkdirSync(target, { recursive: true });
    const probe = path.join(target, `.jmc-doctor-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

function checkDiskSpace(paths: ReturnType<typeof createPaths>): DoctorCheck {
  const usage = diskUsageOf(paths.home);
  if (usage === undefined) {
    return { name: 'Disk Space', status: 'warning', detail: ['Free disk space could not be determined on this platform.'] };
  }
  const detail = [
    `free: ${formatBytes(usage.free)}`,
    `total: ${formatBytes(usage.total)}`,
    `used by JMC: ${formatBytes(directorySize(paths).totalBytes)}`,
  ];
  if (usage.free < 2 * 1024 * 1024 * 1024) {
    return {
      name: 'Disk Space',
      status: 'warning',
      detail,
      remedy: ['Less than 2 GiB is free. Minecraft artifacts, JDKs and Gradle distributions require several gigabytes.'],
    };
  }
  return { name: 'Disk Space', status: 'pass', detail };
}

function diskUsageOf(target: string): { free: number; total: number } | undefined {
  try {
    const result = defaultProcessRunner.runSync('df', ['-k', target], { timeoutMs: 10_000 });
    if (result.exitCode === 0) {
      const lines = result.stdout.trim().split('\n');
      const last = lines[lines.length - 1];
      if (last !== undefined) {
        const parts = last.split(/\s+/);
        if (parts.length >= 4) {
          const totalKb = Number.parseInt(parts[1] as string, 10);
          const availableKb = Number.parseInt(parts[3] as string, 10);
          if (!Number.isNaN(totalKb) && !Number.isNaN(availableKb)) {
            return { total: totalKb * 1024, free: availableKb * 1024 };
          }
        }
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function checkMavenLocal(env: NodeJS.ProcessEnv): DoctorCheck {
  const candidates = [
    env.M2_REPO,
    env.maven_repo_local,
    process.env.HOME === undefined ? undefined : path.join(process.env.HOME, '.m2', 'repository'),
  ].filter((entry): entry is string => entry !== undefined && entry.length > 0);
  const detail: string[] = [];
  let found = false;
  for (const candidate of candidates) {
    const exists = fs.existsSync(candidate);
    detail.push(`${candidate}: ${exists ? 'present' : 'absent'}`);
    if (exists) found = true;
  }
  return {
    name: 'Maven Repositories',
    status: 'pass',
    detail: found ? detail : [...detail, 'No local Maven repository was found; JMC uses its own isolated repository cache.'],
  };
}

function checkMinecraftCache(paths: ReturnType<typeof createPaths>): DoctorCheck {
  const versionsRoot = path.join(paths.cacheMinecraft, 'versions');
  const versions = fs.existsSync(versionsRoot)
    ? fs.readdirSync(versionsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    : [];
  return {
    name: 'Minecraft Artifacts',
    status: 'pass',
    detail: [
      `cached versions: ${versions.length > 0 ? versions.join(', ') : 'none'}`,
      `cache location: ${paths.cacheMinecraft}`,
    ],
  };
}

export function renderDoctorReport(report: DoctorReport, write: (line: string) => void): void {
  write(paint('JMC Doctor', 'bold'));
  write('');
  for (const check of report.checks) {
    const label = check.status === 'pass' ? 'PASS' : check.status === 'warning' ? 'WARNING' : 'FAILED';
    const color = check.status === 'pass' ? 'green' : check.status === 'warning' ? 'yellow' : 'red';
    write(`${paint(`[${label}]`, color)} ${check.name}`);
    for (const line of check.detail) write(`  ${paint('|', 'gray')} ${line}`);
    if (check.remedy !== undefined) {
      for (const remedy of check.remedy) write(`  ${paint('->', 'yellow')} ${remedy}`);
    }
  }
  write('');
  write(report.ok ? paint('Doctor result: PASS', 'green', 'bold') : paint('Doctor result: FAILED', 'red', 'bold'));
}

export function doctorToJson(report: DoctorReport): Record<string, unknown> {
  return {
    ok: report.ok,
    paths: report.paths,
    checks: report.checks.map((check) => ({
      name: check.name,
      status: check.status,
      detail: check.detail,
      remedy: check.remedy ?? [],
    })),
  };
}

export { ConsoleSink };