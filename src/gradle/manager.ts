import path from 'node:path';
import type { Architecture, OperatingSystem } from '../platform/os.js';
import type { JmcPaths } from '../platform/paths.js';
import { defaultFileSystem } from '../platform/fs.js';
import { detectPlatform } from '../platform/os.js';
import { DownloadError, downloadFile, fetchText, sha256File } from '../net/download.js';
import { selectGradleVersion } from './compatibility.js';
import { extractArchive } from '../net/archive.js';
import type { GradleProjectModel } from '../project/gradle-model.js';
import type { Logger } from '../logging/logger.js';

export class GradleDistributionVerificationError extends Error {
  readonly url: string;
  readonly expected: string | undefined;
  readonly actual: string | undefined;

  constructor(message: string, url: string, expected: string | undefined, actual: string | undefined) {
    super(message);
    this.name = 'GradleDistributionVerificationError';
    this.url = url;
    this.expected = expected;
    this.actual = actual;
  }
}

export interface GradleDistribution {
  version: string;
  url: string;
  archiveName: string;
  archiveFormat: 'zip' | 'tar.gz';
  binDirectoryName: string;
  platformToken?: string;
  archToken?: string;
}

export interface GradleManagerOptions {
  paths: JmcPaths;
  logger: Logger;
  offline: boolean;
}

export interface GradleInstall {
  version: string;
  gradleHome: string;
  binScript: string;
  distributionUrl: string;
  managed: boolean;
}

export interface GradleVersionPolicy {
  minMajor: number;
  maxMajor: number;
}

export function gradleVersionPolicy(gradleVersion: string): GradleVersionPolicy {
  const major = Number.parseInt(gradleVersion.split('.')[0] ?? '0', 10);
  if (Number.isNaN(major) || major <= 0) return { minMajor: 7, maxMajor: 9 };
  return { minMajor: major, maxMajor: major };
}

const GRADLE_JAVA_TABLE: Array<{ maxGradleMajor: number; java: number }> = [
  { maxGradleMajor: 4, java: 8 },
  { maxGradleMajor: 6, java: 11 },
  { maxGradleMajor: 7, java: 15 },
  { maxGradleMajor: 8, java: 17 },
  { maxGradleMajor: 9, java: 21 },
];

export function currentGradleVersion(): string {
  return selectGradleVersion(undefined).version;
}

export function javaRequiredForGradleVersion(gradleVersion: string): number {
  const major = Number.parseInt(gradleVersion.split('.')[0] ?? '0', 10);
  const normalized = Number.isNaN(major) ? 0 : major;
  for (const entry of GRADLE_JAVA_TABLE) {
    if (normalized <= entry.maxGradleMajor) return entry.java;
  }
  return 21;
}

export function resolveGradleServiceUrl(serviceRoot: string): string | null {
  try {
    const parsed = new URL(serviceRoot);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

export function defaultGradleDistributionUrl(version: string, os?: OperatingSystem, arch?: Architecture): GradleDistribution {
  const platform = detectPlatform();
  const targetOs = os ?? platform.os;
  const targetArch = arch ?? platform.arch;
  const platformToken = targetOs === 'win32' ? 'windows' : targetOs === 'darwin' ? 'mac' : 'linux';
  const archToken = targetArch === 'x64' ? 'x86_64' : targetArch === 'arm64' ? 'aarch64' : targetArch;
  const archiveName = `gradle-${version}-bin.zip`;
  return {
    version,
    url: `https://services.gradle.org/distributions/${archiveName}`,
    archiveName,
    archiveFormat: 'zip',
    binDirectoryName: `gradle-${version}`,
    platformToken,
    archToken,
  };
}

export class GradleManager {
  private readonly options: GradleManagerOptions;
  private readonly fs = defaultFileSystem;

  constructor(options: GradleManagerOptions) {
    this.options = options;
  }

  wrapperScript(projectRoot: string): string | undefined {
    const platform = detectPlatform();
    const names = platform.os === 'win32' ? ['gradlew.bat', 'gradlew'] : ['gradlew'];
    for (const name of names) {
      const candidate = path.join(projectRoot, name);
      if (this.fs.isFile(candidate)) return candidate;
    }
    return undefined;
  }

  wrapperVersion(projectRoot: string): string | undefined {
    const propertiesPath = path.join(projectRoot, 'gradle', 'wrapper', 'gradle-wrapper.properties');
    if (!this.fs.isFile(propertiesPath)) return undefined;
    const content = this.fs.readText(propertiesPath);
    const match = /distributionUrl\s*=\s*\S*gradle-([0-9][^-\s/]*)-(bin|all)\.(?:zip|tar\.gz)/i.exec(content);
    if (match !== null && match[1] !== undefined) return match[1];
    const fallback = /gradleVersion\s*=\s*([0-9][^\s]*)/i.exec(content);
    return fallback?.[1];
  }

  selectVersion(model: GradleProjectModel | undefined): { version: string; reason: string; javaMajor?: number; conflict?: { plugins: string[]; detail: string } } {
    const selection = selectGradleVersion(model);
    this.lastSelectionReason = selection.reason;
    return { version: selection.version, reason: selection.reason, javaMajor: selection.javaMajor, conflict: selection.conflict };
  }

  lastSelectionReason = '';

  wrapperPropertiesContent(projectRoot: string): { distributionUrl?: string; distributionSha256Sum?: string } | undefined {
    const propertiesPath = path.join(projectRoot, 'gradle', 'wrapper', 'gradle-wrapper.properties');
    if (!this.fs.isFile(propertiesPath)) return undefined;
    const content = this.fs.readText(propertiesPath);
    const url = /distributionUrl\s*=\s*(\S+)/.exec(content)?.[1];
    const sha = /distributionSha256Sum\s*=\s*(\S+)/.exec(content)?.[1];
    return { distributionUrl: url, distributionSha256Sum: sha };
  }

  installedManagedVersions(): string[] {
    const root = this.options.paths.cacheGradle;
    if (!this.fs.isDirectory(root)) return [];
    return this.fs
      .readDir(root)
      .filter((entry) => entry.isDirectory && entry.name.startsWith('gradle-'))
      .map((entry) => entry.name.replace(/^gradle-/, ''))
      .sort();
  }

  managedInstall(version: string): GradleInstall | undefined {
    const platform = detectPlatform();
    const root = path.join(this.options.paths.cacheGradle, `gradle-${version}`);
    if (!this.fs.isDirectory(root)) return undefined;
    const scriptName = platform.os === 'win32' ? 'gradle.bat' : 'gradle';
    const nested = path.join(root, `gradle-${version}`);
    const home = this.fs.isFile(path.join(root, 'bin', scriptName))
      ? root
      : this.fs.isFile(path.join(nested, 'bin', scriptName))
        ? nested
        : this.findGradleHome(root);
    if (home === undefined) return undefined;
    return {
      version,
      gradleHome: home,
      binScript: path.join(home, 'bin', scriptName),
      distributionUrl: defaultGradleDistributionUrl(version).url,
      managed: true,
    };
  }

  async ensureDistribution(version: string, options: { projectRoot?: string; distributionUrl?: string } = {}): Promise<GradleInstall> {
    const distribution = defaultGradleDistributionUrl(version);
    const archiveUrl = options.distributionUrl ?? distribution.url;
    const archiveName = path.basename(new URL(archiveUrl).pathname);
    const archivePath = path.join(this.options.paths.cacheGradle, archiveName);
    const markerPath = `${archivePath}.sha256`;
    const wrapper = options.projectRoot === undefined ? undefined : this.wrapperPropertiesContent(options.projectRoot);

    if (this.options.offline) {
      const cached = this.verifyCachedOnly(version, archivePath, markerPath);
      if (cached !== undefined) return cached;
      throw new Error(`Gradle ${version} is not present in the JMC cache and offline mode prevents downloading it`);
    }

    const expected = await this.expectedChecksum(archiveUrl, markerPath, options.projectRoot, wrapper, version);
    const existing = this.verifiedInstall(version, archivePath, markerPath, expected);
    if (existing !== undefined) return existing;
    this.options.logger.download(`Downloading Gradle ${version}`, 'Gradle');
    try {
      await downloadFile(archiveUrl, archivePath, {
        logger: this.options.logger,
        offline: this.options.offline,
        expectedSha256: expected,
        stage: 'Gradle',
        timeoutMs: 30 * 60 * 1000,
      });
    } catch (error) {
      if (error instanceof DownloadError && error.kind === 'checksum') {
        this.fs.remove(archivePath);
        throw new GradleDistributionVerificationError(
          `${error.message}. The downloaded archive was discarded and was not installed.`,
          archiveUrl,
          expected,
          undefined,
        );
      }
      throw error;
    }
    const actual = sha256File(archivePath);
    this.assertChecksum(archiveUrl, expected, actual, archivePath);
    this.fs.writeText(markerPath, `${actual}\n`);
    const extractRoot = path.join(this.options.paths.cacheGradle, `gradle-${version}`);
    this.options.logger.info(`Extracting Gradle ${version}`, 'Gradle');
    this.fs.remove(extractRoot);
    await extractArchive(archivePath, extractRoot);
    const install = this.managedInstall(version);
    if (install !== undefined) return install;
    throw new Error(`Gradle ${version} distribution extracted but no gradle launcher was found under ${extractRoot}`);
  }

  private verifyCachedOnly(version: string, archivePath: string, markerPath: string): GradleInstall | undefined {
    return this.cacheIsVerified(version, archivePath, markerPath, undefined) ? this.managedInstall(version) : undefined;
  }

  private verifiedInstall(version: string, archivePath: string, markerPath: string, expected: string | undefined): GradleInstall | undefined {
    if (this.cacheIsVerified(version, archivePath, markerPath, expected) === false) return undefined;
    return this.managedInstall(version);
  }

  private cacheIsVerified(version: string, archivePath: string, markerPath: string, expected: string | undefined): boolean {
    if (this.fs.isFile(archivePath) === false || this.fs.isFile(markerPath) === false) {
      if (this.fs.isFile(archivePath) || this.fs.isFile(markerPath)) this.discardCachedDistribution(version, archivePath, markerPath);
      return false;
    }
    const recorded = this.fs.readText(markerPath).trim();
    if (recorded.length !== 64 || /^[0-9a-f]{64}$/.test(recorded) === false) {
      this.discardCachedDistribution(version, archivePath, markerPath);
      return false;
    }
    const actual = sha256File(archivePath);
    const matchesMarker = actual === recorded;
    const matchesPublished = expected === undefined || actual === expected.toLowerCase();
    if (matchesMarker === false || matchesPublished === false) {
      this.discardCachedDistribution(version, archivePath, markerPath);
      return false;
    }
    return this.managedInstall(version) !== undefined;
  }

  private discardCachedDistribution(version: string, archivePath: string, markerPath: string): void {
    this.fs.remove(archivePath);
    this.fs.remove(markerPath);
    this.fs.remove(path.join(this.options.paths.cacheGradle, `gradle-${version}`));
    this.options.logger.warn(`Discarded an unverified cached Gradle ${version} distribution`, 'Gradle');
  }

  private async expectedChecksum(
    url: string,
    markerPath: string,
    projectRoot: string | undefined,
    wrapper: { distributionUrl?: string; distributionSha256Sum?: string } | undefined,
    version: string,
  ): Promise<string> {
    const published = await this.fetchPublishedChecksum(url);
    const declared = declaredChecksum(wrapper, projectRoot, version);
    if (published === undefined && declared === undefined) {
      throw new GradleDistributionVerificationError(
        `The SHA-256 checksum for ${url} could not be retrieved, and the project declares no distributionSha256Sum for Gradle ${version}. JMC refuses to install an unverified Gradle distribution.`,
        url,
        undefined,
        undefined,
      );
    }
    if (published !== undefined && declared !== undefined && published.toLowerCase() !== declared.toLowerCase()) {
      throw new GradleDistributionVerificationError(
        `The published SHA-256 for ${url} does not match distributionSha256Sum in the project Gradle wrapper properties.`,
        url,
        declared,
        published,
      );
    }
    const chosen = published ?? (declared as string);
    if (projectRoot !== undefined) this.fs.writeText(markerPath, `${chosen.toLowerCase()}\n`);
    return chosen.toLowerCase();
  }

  private async fetchPublishedChecksum(url: string): Promise<string | undefined> {
    for (const candidate of [`${url}.sha256`, `${url}.sha256sum`]) {
      try {
        const text = await fetchText(candidate, { timeoutMs: 30_000 });
        const match = /([0-9a-fA-F]{64})/.exec(text);
        if (match !== null) return (match[1] as string).toLowerCase();
      } catch {
        continue;
      }
    }
    return undefined;
  }

  private assertChecksum(url: string, expected: string | undefined, actual: string, archivePath: string): void {
    if (expected === undefined) return;
    if (actual === expected.toLowerCase()) return;
    this.fs.remove(archivePath);
    throw new GradleDistributionVerificationError(
      `Checksum mismatch for ${url}: expected ${expected}, received ${actual}`,
      url,
      expected,
      actual,
    );
  }

  private findGradleHome(root: string): string | undefined {
    const platform = detectPlatform();
    const scriptName = platform.os === 'win32' ? 'gradle.bat' : 'gradle';
    const stack: Array<{ directory: string; depth: number }> = [{ directory: root, depth: 0 }];
    while (stack.length > 0) {
      const current = stack.pop() as { directory: string; depth: number };
      if (current.depth > 3) continue;
      if (this.fs.isFile(path.join(current.directory, 'bin', scriptName))) return current.directory;
      if (current.depth === 3) continue;
      for (const entry of this.fs.readDir(current.directory)) {
        if (entry.isDirectory) stack.push({ directory: entry.path, depth: current.depth + 1 });
      }
    }
    return undefined;
  }

  listAvailableForOffline(): string[] {
    return this.installedManagedVersions();
  }
}

export function declaredChecksum(
  wrapper: { distributionUrl?: string; distributionSha256Sum?: string } | undefined,
  projectRoot: string | undefined,
  version: string,
): string | undefined {
  const declared = wrapper?.distributionSha256Sum?.trim();
  if (declared === undefined || declared.length === 0) return undefined;
  if (/^[0-9a-fA-F]{64}$/.test(declared) === false) return undefined;
  if (projectRoot !== undefined && wrapper?.distributionUrl !== undefined) {
    const match = /gradle-([0-9][^-\s/]*)-(?:bin|all)\.(?:zip|tar\.gz)/i.exec(wrapper.distributionUrl);
    if (match !== null && match[1] !== version) return undefined;
  }
  return declared.toLowerCase();
}