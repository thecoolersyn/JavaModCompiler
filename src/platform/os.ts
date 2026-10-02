import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type OperatingSystem = 'win32' | 'darwin' | 'linux';
export type Architecture = 'x64' | 'arm64' | 'x86' | 'arm';
export type LibcFlavor = 'gnu' | 'musl' | 'unknown';

export interface PlatformDescriptor {
  os: OperatingSystem;
  arch: Architecture;
  libc: LibcFlavor;
  homedir: string;
  tmpdir: string;
  cpuCount: number;
  totalMemoryBytes: number;
  freeMemoryBytes: number;
  shell: string;
  pathSeparator: string;
  isCi: boolean;
  isContainer: boolean;
  isWsl: boolean;
  isMingw: boolean;
  caseInsensitiveFs: boolean;
  executableSuffix: string;
  launcherExtension: string;
}

let cached: PlatformDescriptor | null = null;

function detectLibc(): LibcFlavor {
  if (process.platform !== 'linux') return 'unknown';
  if (process.report?.getReport) {
    const report = process.report.getReport() as { header?: { glibcVersionRuntime?: string } };
    if (report.header?.glibcVersionRuntime !== undefined) return 'gnu';
  }
  if (process.env.JMC_LIBC) {
    const forced = process.env.JMC_LIBC.toLowerCase();
    if (forced === 'musl' || forced === 'gnu') return forced;
  }
  return 'gnu';
}

function detectContainer(): boolean {
  if (process.env.JMC_IN_CONTAINER === '1') return true;
  if (process.env.container !== undefined) return true;
  try {
    const cgroup = fs.readFileSync('/proc/1/cgroup', 'utf8');
    if (/docker|containerd|kubepods|lxc/.test(cgroup)) return true;
  } catch {
    return false;
  }
  return false;
}

function detectShell(osType: OperatingSystem): string {
  if (process.env.SHELL !== undefined && process.env.SHELL.length > 0) return process.env.SHELL;
  if (process.env.ComSpec !== undefined && process.env.ComSpec.length > 0) return process.env.ComSpec;
  if (osType === 'win32') return 'cmd.exe';
  return '/bin/sh';
}

export function detectPlatform(): PlatformDescriptor {
  if (cached !== null) return cached;
  const rawArch = process.arch;
  const arch: Architecture =
    rawArch === 'x64' ? 'x64' : rawArch === 'arm64' ? 'arm64' : rawArch === 'ia32' ? 'x86' : (rawArch as Architecture);
  const osType = process.platform as OperatingSystem;
  const wsl = process.env.WSL_DISTRO_NAME !== undefined || process.env.WSL_INTEROP !== undefined;
  const mingw =
    osType === 'win32' && (/msys|mingw|cygwin/i.test(process.env.MSYSTEM ?? '') || process.env.MINGW_PREFIX !== undefined);
  cached = {
    os: osType,
    arch,
    libc: detectLibc(),
    homedir: os.homedir(),
    tmpdir: os.tmpdir(),
    cpuCount: Math.max(1, os.cpus().length),
    totalMemoryBytes: os.totalmem(),
    freeMemoryBytes: os.freemem(),
    shell: detectShell(osType),
    pathSeparator: path.sep,
    isCi: process.env.CI !== undefined && process.env.CI !== '' && process.env.CI !== 'false',
    isContainer: detectContainer(),
    isWsl: wsl,
    isMingw: mingw,
    caseInsensitiveFs: osType === 'darwin' || osType === 'win32' || mingw,
    executableSuffix: osType === 'win32' ? '.exe' : '',
    launcherExtension: osType === 'win32' ? '.cmd' : '',
  };
  return cached;
}

export function platformLabel(platform: PlatformDescriptor = detectPlatform()): string {
  const names: Record<OperatingSystem, string> = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };
  const libc = platform.libc === 'unknown' ? '' : `-${platform.libc}`;
  const wsl = platform.isWsl ? ' (WSL)' : '';
  return `${names[platform.os]} ${platform.arch}${libc}${wsl}`;
}

export function javaPlatformKey(platform: PlatformDescriptor = detectPlatform()): string {
  if (platform.os === 'win32') return `windows-${platform.arch}`;
  if (platform.os === 'darwin') return `mac-${platform.arch === 'arm64' ? 'aarch64' : 'x64'}`;
  return `linux-${platform.arch === 'arm64' ? 'aarch64' : 'x64'}`;
}

export function nodePlatformKey(platform: PlatformDescriptor = detectPlatform()): string {
  if (platform.os === 'win32') return `win32-${platform.arch}`;
  if (platform.os === 'darwin') return `darwin-${platform.arch}`;
  return `linux-${platform.arch}`;
}