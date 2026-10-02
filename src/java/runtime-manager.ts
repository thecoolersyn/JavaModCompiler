import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from '../logging/logger.js';
import { defaultFileSystem } from '../platform/fs.js';
import { detectPlatform, javaPlatformKey, type OperatingSystem } from '../platform/os.js';
import { defaultProcessRunner } from '../platform/process.js';
import type { JmcPaths } from '../platform/paths.js';
import {
  detectJavaHomeFromReleaseFile,
  javaExecutableName,
  javaVersionToMajor,
  javacExecutableName,
  parseJavaVendorFromHome,
  parseJavaVersionOutput,
  type JdkInstallation,
} from './jdk-model.js';
import { downloadFile, sha256File } from '../net/download.js';
import { extractArchive } from '../net/archive.js';

export interface JavaRuntimeManagerOptions {
  paths: JmcPaths;
  logger: Logger;
  offline: boolean;
  fsImpl?: typeof defaultFileSystem;
}

export interface AdoptResult {
  installation: JdkInstallation;
  source: 'installed' | 'downloaded' | 'bundled';
  downloaded: boolean;
}

const ADOPTIUM_API = 'https://api.adoptium.net/v3/assets/latest';

const MAX_VERSION_FALLBACK = 6;

const LARGE_ARTIFACT_TIMEOUT_MS = 30 * 60 * 1000;

interface AdoptiumRelease {
  version?: { semver?: string };
  release_name?: string;
  bin?: AdoptiumBinary[];
  binary?: AdoptiumBinary;
}

interface AdoptiumBinary {
  image_type?: string;
  os?: string;
  arch?: string;
  architecture?: string;
  libc?: string;
  package?: {
    link?: string;
    checksum?: string;
    checksum_link?: string;
    size?: number;
    name?: string;
  };
  release_name?: string;
}

export class JavaRuntimeManager {
  private readonly options: JavaRuntimeManagerOptions;
  private readonly fs = defaultFileSystem;
  private cachedScan: JdkInstallation[] | undefined;

  constructor(options: JavaRuntimeManagerOptions) {
    this.options = options;
  }

  listInstalled(): JdkInstallation[] {
    if (this.cachedScan !== undefined) return this.cachedScan;
    const platform = detectPlatform();
    const found = new Map<string, JdkInstallation>();

    const register = (javaHome: string, origin: JdkInstallation['origin']): void => {
      const normalized = path.resolve(javaHome);
      const key = normalized.toLowerCase();
      if (found.has(key)) return;
      if (this.isJmcManagedRuntimePath(normalized) && this.managedRuntimeIsVerified(normalized) === false) {
        this.discardUnverifiedRuntime(normalized);
        return;
      }
      const installation = this.describeJavaHome(normalized, origin, platform.arch);
      if (installation !== undefined) found.set(key, installation);
    };

    const envHome = process.env.JAVA_HOME;
    if (envHome !== undefined && envHome.length > 0) register(envHome, 'JAVA_HOME');

    for (const entry of this.scanRoots(platform.os)) {
      register(entry, this.originForRoot(entry));
    }

    const managedRoot = this.options.paths.runtimes;
    if (this.fs.isDirectory(managedRoot)) {
      for (const entry of this.fs.readDir(managedRoot)) {
        if (!entry.isDirectory) continue;
        const nested = path.join(entry.path, 'jdk');
        const javaHome = this.fs.isDirectory(nested) ? nested : entry.path;
        if (this.managedRuntimeIsVerified(javaHome) === false) {
          this.discardUnverifiedRuntime(javaHome);
          continue;
        }
        register(javaHome, 'jmc-managed');
      }
    }

    for (const [name, subPath] of [
      ['sdkman', path.join(process.env.HOME ?? '', '.sdkman', 'candidates', 'java')],
      ['jabba', path.join(process.env.HOME ?? '', '.jabba', 'jdk')],
      ['asdf', path.join(process.env.HOME ?? '', '.asdf', 'installs', 'java')],
      ['mise', path.join(process.env.HOME ?? '', '.local', 'share', 'mise', 'installs', 'java')],
      ['brew', '/opt/homebrew/opt'],
      ['brew', '/usr/local/opt'],
    ] as Array<[JdkInstallation['origin'], string]>) {
      if (!this.fs.isDirectory(subPath)) continue;
      for (const entry of this.fs.readDir(subPath)) {
        if (!entry.isDirectory) continue;
        if (!/jdk|java|zulu|temurin|corretto|openjdk|graal/i.test(entry.name)) continue;
        register(entry.path, name as JdkInstallation['origin']);
        const nestedContents = path.join(entry.path, 'Contents', 'Home');
        if (this.fs.isDirectory(nestedContents)) register(nestedContents, name as JdkInstallation['origin']);
      }
    }

    if (platform.os === 'win32') this.registerWindowsRegistryRoots(register);

    this.cachedScan = [...found.values()].sort((a, b) => b.version - a.version);
    return this.cachedScan;
  }

  private registerWindowsRegistryRoots(register: (javaHome: string, origin: JdkInstallation['origin']) => void): void {
    for (const hive of ['HKLM\\SOFTWARE\\JavaSoft\\JDK', 'HKLM\\SOFTWARE\\JavaSoft\\Java Development Kit', 'HKLM\\SOFTWARE\\JavaSoft\\Java Runtime Environment']) {
      const result = defaultProcessRunner.runSync('reg', ['query', hive, '/s', '/v', 'JavaHome'], { timeoutMs: 20_000 });
      if (result.exitCode !== 0) continue;
      for (const line of result.stdout.split(/\r?\n/)) {
        const match = /REG_SZ\s+(.+)$/i.exec(line);
        if (match?.[1] !== undefined) register(match[1].trim(), 'jvm-registry');
      }
    }
    const installed = defaultProcessRunner.runSync('where', ['java'], { timeoutMs: 10_000 });
    if (installed.exitCode === 0) {
      for (const line of installed.stdout.split(/\r?\n/)) {
        const executable = line.trim();
        if (executable.length === 0) continue;
        register(path.dirname(executable), 'PATH');
      }
    }
  }

  private scanRoots(osType: ReturnType<typeof detectPlatform>['os']): string[] {
    const roots: string[] = [];
    const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
    const candidates = [...jdkScanRoots(), path.join(home, '.umc', 'runtimes')];
    for (const root of candidates) {
      if (root.length === 0) continue;
      if (!this.fs.isDirectory(root)) continue;
      if (osType === 'win32') {
        roots.push(root);
        for (const entry of this.fs.readDir(root)) {
          if (entry.isDirectory) roots.push(entry.path);
          if (entry.isDirectory) {
            const nested = path.join(entry.path, 'Contents', 'Home');
            if (this.fs.isDirectory(nested)) roots.push(nested);
          }
        }
      } else {
        for (const entry of this.fs.readDir(root)) {
          if (!entry.isDirectory) continue;
          roots.push(entry.path);
          const macNested = path.join(entry.path, 'Contents', 'Home');
          if (this.fs.isDirectory(macNested)) roots.push(macNested);
        }
      }
    }
    return roots;
  }

  private originForRoot(entry: string): JdkInstallation['origin'] {
    const lower = entry.toLowerCase();
    if (lower.includes('.sdkman')) return 'sdkman';
    if (lower.includes('.jabba')) return 'jabba';
    if (lower.includes('.asdf')) return 'asdf';
    if (lower.includes('mise')) return 'mise';
    if (lower.includes('homebrew') || lower.includes('/opt/')) return 'brew';
    if (lower.includes('.umc') || lower.includes('.umc')) return 'jmc-managed';
    return 'system-scan';
  }

  describeJavaHome(
    javaHome: string,
    origin: JdkInstallation['origin'],
    expectedArch: string,
  ): JdkInstallation | undefined {
    const binDir = path.join(javaHome, 'bin');
    const javaExecutable = path.join(binDir, javaExecutableName());
    if (!this.fs.isFile(javaExecutable)) return undefined;
    const release = detectJavaHomeFromReleaseFile(javaHome);
    let versionText = release.versionText;
    let vendor = release.vendor ?? parseJavaVendorFromHome(javaHome);
    if (versionText === undefined) {
      const result = defaultProcessRunner.runSync(javaExecutable, ['-version'], { timeoutMs: 30_000 });
      if (result.exitCode === 0) {
        const parsed = parseJavaVersionOutput(`${result.stdout}\n${result.stderr}`);
        if (parsed !== undefined) {
          versionText = parsed.versionText;
          vendor = parsed.vendor;
        }
      }
    }
    if (versionText === undefined) return undefined;
    const version = javaVersionToMajor(versionText);
    if (version === undefined) return undefined;
    const javac = path.join(binDir, javacExecutableName());
    let javacVersion: string | undefined;
    if (this.fs.isFile(javac)) {
      const result = defaultProcessRunner.runSync(javac, ['-version'], { timeoutMs: 30_000 });
      if (result.exitCode === 0) {
        javacVersion = (result.stdout || result.stderr).trim().split('\n')[0];
      }
    }
    return {
      javaHome,
      javaExecutable,
      javacExecutable: this.fs.isFile(javac) ? javac : undefined,
      javacVersion,
      javaVersion: versionText,
      version,
      versionText,
      architecture: detectJavaArchitecture(javaExecutable, expectedArch),
      vendor: vendor ?? 'unknown',
      origin,
    };
  }

  findSatisfying(requirement: { minMajor: number; maxMajor?: number }): JdkInstallation | undefined {
    const candidates = this.listInstalled().filter((installation) => {
      if (installation.version < requirement.minMajor) return false;
      if (requirement.maxMajor !== undefined && installation.version > requirement.maxMajor) return false;
      return true;
    });
    if (candidates.length === 0) return undefined;
    const preferred = process.env.JMC_JAVA_HOME;
    if (preferred !== undefined) {
      const normalized = path.resolve(preferred);
      const match = candidates.find((entry) => entry.javaHome === normalized);
      if (match !== undefined) return match;
    }
    return candidates.sort((a, b) => {
      if (a.version !== b.version) return a.version - b.version;
      const score = (installation: JdkInstallation): number => {
        if (installation.origin === 'jmc-managed') return 0;
        if (installation.origin === 'JAVA_HOME') return 1;
        if (installation.javacExecutable !== undefined) return 2;
        return 3;
      };
      return score(a) - score(b);
    })[0];
  }

  async resolve(requirement: { minMajor: number; maxMajor?: number }): Promise<JdkInstallation> {
    const existing = this.findSatisfying(requirement);
    if (existing !== undefined) return existing;
    const installed = this.listInstalled();
    for (let candidate = requirement.minMajor; candidate <= requirement.minMajor + MAX_VERSION_FALLBACK; candidate += 1) {
      const satisfying = installed.find(
        (installation) =>
          installation.version >= candidate &&
          (requirement.maxMajor === undefined || installation.version <= requirement.maxMajor),
      );
      if (satisfying !== undefined) return satisfying;
    }
    for (let candidate = requirement.minMajor; candidate <= requirement.minMajor + MAX_VERSION_FALLBACK; candidate += 1) {
      try {
        return await this.downloadAndInstall(candidate);
      } catch (error) {
        if (error instanceof JavaRuntimeUnavailableError) continue;
        throw error;
      }
    }
    throw new JavaRuntimeUnavailableError(
      requirement.minMajor,
      `no distribution is published for Java ${requirement.minMajor} through ${requirement.minMajor + MAX_VERSION_FALLBACK} on this platform`,
    );
  }

  async downloadAndInstall(majorVersion: number): Promise<JdkInstallation> {
    if (this.options.offline) {
      throw new JavaRuntimeUnavailableError(majorVersion, 'offline mode prevents downloading a JDK');
    }
    const platform = detectPlatform();
    const cacheKey = javaPlatformKey(platform);
    const architecture = cacheKey.includes('-') ? (cacheKey.split('-')[1] as string) : cacheKey;
    const osToken = adoptiumOsToken(platform.os);
    const url = `${ADOPTIUM_API}/${majorVersion}/hotspot?architecture=${architecture}&image_type=jdk&os=${osToken}&vendor=eclipse`;
    this.options.logger.debug(`Querying Adoptium API for JDK ${majorVersion} (${osToken}/${architecture})`, 'Java');
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok) {
      throw new JavaRuntimeUnavailableError(
        majorVersion,
        `Adoptium returned HTTP ${response.status} for ${osToken}/${architecture}`,
      );
    }
    const payload = (await response.json()) as AdoptiumRelease[];
    const asset = selectAdoptiumBinary(payload, platform.os, platform.arch);
    if (asset === undefined) {
      throw new JavaRuntimeUnavailableError(
        majorVersion,
        `Adoptium has no JDK ${majorVersion} binary for ${osToken}/${architecture}`,
      );
    }
    const downloadUrl = asset.package?.link;
    if (downloadUrl === undefined) {
      throw new JavaRuntimeUnavailableError(majorVersion, 'Adoptium asset is missing a download link');
    }
    const expectedChecksum = asset.package?.checksum;
    const installRoot = path.join(this.options.paths.runtimes, `temurin-${majorVersion}-${cacheKey}`);
    const archiveName = asset.package?.name ?? `jdk-${majorVersion}.${platform.os === 'win32' ? 'zip' : 'tar.gz'}`;
    const archivePath = path.join(this.options.paths.cacheJava, archiveName);
    let lastReported = -1;
    this.options.logger.download(`Downloading JDK ${majorVersion} (${architecture})`, 'Java');
    await downloadFile(downloadUrl, archivePath, {
      logger: this.options.logger,
      offline: this.options.offline,
      expectedSha256: expectedChecksum,
      stage: 'Java',
      timeoutMs: LARGE_ARTIFACT_TIMEOUT_MS,
      onProgress: (received, total) => {
        if (total === undefined || total <= 0) return;
        const percent = Math.floor((received / total) * 100);
        if (percent % 25 === 0 && percent !== lastReported) {
          lastReported = percent;
          this.options.logger.debug(`${path.basename(archivePath)} ${percent}% (${received} of ${total} bytes)`, 'Java');
        }
      },
    });
    this.options.logger.info(`Extracting ${archiveName}`, 'Java');
    this.fs.remove(installRoot);
    await extractArchive(archivePath, installRoot);
    const javaHome = locateExtractedJavaHome(installRoot, platform.os);
    const installation = this.describeJavaHome(javaHome, 'jmc-managed', platform.arch);
    if (installation === undefined) {
      throw new JavaRuntimeUnavailableError(majorVersion, `Extracted archive at ${javaHome} does not contain a usable java`);
    }
    if (expectedChecksum === undefined) {
      this.fs.remove(installRoot);
      throw new JavaRuntimeUnavailableError(
        majorVersion,
        `Adoptium did not publish a SHA-256 checksum for ${archiveName}. JMC refuses to install an unverified JDK.`,
      );
    }
    this.writeIntegrityRecord(javaHome, {
      majorVersion,
      cacheKey,
      archiveName,
      archiveChecksum: expectedChecksum,
      algorithm: 'sha256',
    });
    this.cachedScan = undefined;
    return installation;
  }

  private isJmcManagedRuntimePath(javaHome: string): boolean {
    const normalized = path.resolve(javaHome).toLowerCase();
    const markers = [path.resolve(this.options.paths.runtimes).toLowerCase()];
    const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
    if (home.length > 0) markers.push(path.resolve(home, '.umc', 'runtimes').toLowerCase());
    return markers.some((marker) => normalized === marker || normalized.startsWith(`${marker}${path.sep}`));
  }

  private integrityRecordPath(javaHome: string): string {
    return path.join(javaHome, '.jmc-integrity.json');
  }

  private writeIntegrityRecord(
    javaHome: string,
    record: { majorVersion: number; cacheKey: string; archiveName: string; archiveChecksum: string; algorithm: string },
  ): void {
    try {
      this.fs.writeText(
        this.integrityRecordPath(javaHome),
        `${JSON.stringify({ ...record, recordedAt: Date.now() }, null, 2)}\n`,
      );
    } catch {
      return;
    }
  }

  private managedRuntimeIsVerified(javaHome: string): boolean {
    const recordPath = this.integrityRecordPath(javaHome);
    if (this.fs.isFile(recordPath) === false) return false;
    let record: {
      majorVersion?: number;
      cacheKey?: string;
      archiveName?: string;
      archiveChecksum?: string;
      algorithm?: string;
    };
    try {
      record = JSON.parse(this.fs.readText(recordPath)) as typeof record;
    } catch {
      return false;
    }
    if (typeof record.majorVersion !== 'number' || typeof record.cacheKey !== 'string') return false;
    if (record.algorithm !== 'sha256' || typeof record.archiveChecksum !== 'string') return false;
    if (/^[0-9a-f]{64}$/i.test(record.archiveChecksum) === false) return false;
    const archiveName = typeof record.archiveName === 'string' ? record.archiveName : undefined;
    if (archiveName === undefined) return false;
    const archivePath = path.join(this.options.paths.cacheJava, archiveName);
    if (this.fs.isFile(archivePath) === false) return false;
    return sha256File(archivePath).toLowerCase() === record.archiveChecksum.toLowerCase();
  }

  private discardUnverifiedRuntime(javaHome: string): void {
    const root = path.dirname(javaHome);
    const container = path.dirname(root);
    this.fs.remove(container);
    this.options.logger.warn(`Discarded a managed JDK whose integrity could not be verified: ${container}`, 'Java');
  }

  managedJavaHomes(): string[] {
    const root = this.options.paths.runtimes;
    if (!this.fs.isDirectory(root)) return [];
    return this.fs
      .readDir(root)
      .filter((entry) => entry.isDirectory)
      .map((entry) => {
        const nested = path.join(entry.path, 'jdk');
        return this.fs.isDirectory(nested) ? nested : entry.path;
      });
  }

  environmentFor(installation: JdkInstallation, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return {
      ...process.env,
      ...extra,
      JAVA_HOME: installation.javaHome,
      PATH: `${path.join(installation.javaHome, 'bin')}${detectPlatform().pathSeparator}${process.env.PATH ?? ''}`,
    };
  }
}

export class JavaRuntimeUnavailableError extends Error {
  readonly majorVersion: number;

  constructor(majorVersion: number, reason: string) {
    super(`No Java ${majorVersion} runtime is available: ${reason}`);
    this.name = 'JavaRuntimeUnavailableError';
    this.majorVersion = majorVersion;
  }
}

function jdkScanRoots(): string[] {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  return [
    '/usr/lib/jvm',
    '/usr/java',
    '/opt/java',
    '/opt/jdk',
    '/Library/Java/JavaVirtualMachines',
    path.join(home, '.sdkman', 'candidates', 'java'),
    path.join(home, '.jabba', 'jdk'),
    path.join(home, '.asdf', 'installs', 'java'),
    path.join(home, '.local', 'share', 'mise', 'installs', 'java'),
    'C:/Program Files/Java',
    'C:/Program Files/Eclipse Adoptium',
    'C:/Program Files/Microsoft',
    'C:/Program Files/Amazon Corretto',
    'C:/Program Files/BellSoft',
    'C:/Program Files/Zulu',
    'C:/Program Files (x86)/Java',
  ];
}

function detectJavaArchitecture(javaExecutable: string, fallback: string): JdkInstallation['architecture'] {
  try {
    const result = defaultProcessRunner.runSync(javaExecutable, ['-XshowSettings:properties', '-version'], { timeoutMs: 30_000 });
    const combined = `${result.stdout}\n${result.stderr}`;
    const osArch = /os\.arch\s*=\s*(\S+)/i.exec(combined)?.[1];
    if (osArch !== undefined) {
      if (osArch === 'amd64' || osArch === 'x86_64') return 'x64';
      if (osArch === 'aarch64') return 'arm64';
      if (osArch === 'x86' || osArch === 'i386') return 'x86';
      if (osArch === 'arm') return 'arm';
    }
  } catch {
    return fallback as JdkInstallation['architecture'];
  }
  return fallback as JdkInstallation['architecture'];
}

export function adoptiumOsToken(os: OperatingSystem | string): string {
  if (os === 'darwin') return 'mac';
  if (os === 'win32') return 'windows';
  return os;
}

function selectAdoptiumBinary(payload: AdoptiumRelease[], os: string, arch: string): AdoptiumBinary | undefined {
  const wantedOs = adoptiumOsToken(os);
  const wantedArch = arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x64' : arch;
  const binaries: AdoptiumBinary[] = [];
  for (const release of payload) {
    const candidates = [...(release.bin ?? []), ...(release.binary === undefined ? [] : [release.binary])];
    for (const binary of candidates) {
      if (binary.image_type !== 'jdk') continue;
      if (binary.os !== wantedOs) continue;
      const declaredArch = binary.architecture ?? binary.arch;
      if (declaredArch === undefined) continue;
      const binaryArch = declaredArch === 'x86_64' ? 'x64' : declaredArch;
      if (binaryArch !== wantedArch) continue;
      binaries.push({ ...binary, release_name: release.release_name ?? binary.release_name });
    }
  }
  return binaries.find((binary) => binary.package?.link !== undefined);
}

function locateExtractedJavaHome(installRoot: string, os: OperatingSystem): string {
  const binName = javaExecutableName(os);
  const direct = path.join(installRoot, 'bin', binName);
  if (fs.existsSync(direct)) return installRoot;
  const stack = [installRoot];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (fs.existsSync(path.join(full, 'bin', binName))) return full;
        stack.push(full);
      }
    }
  }
  return installRoot;
}