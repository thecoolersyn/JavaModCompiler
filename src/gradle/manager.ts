import path from 'node:path';
import type { Architecture, OperatingSystem } from '../platform/os.js';
import type { JmcPaths } from '../platform/paths.js';
import { defaultFileSystem } from '../platform/fs.js';
import { detectPlatform } from '../platform/os.js';
import { downloadFile } from '../net/download.js';
import { selectGradleVersion } from './compatibility.js';
import { extractArchive } from '../net/archive.js';
import type { GradleProjectModel } from '../project/gradle-model.js';
import type { Logger } from '../logging/logger.js';

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

  selectVersion(model: GradleProjectModel | undefined): { version: string; reason: string } {
    const selection = selectGradleVersion(model);
    this.lastSelectionReason = selection.reason;
    return { version: selection.version, reason: selection.reason };
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
    const binScript = path.join(root, 'bin', platform.os === 'win32' ? 'gradle.bat' : 'gradle');
    if (!this.fs.isFile(binScript)) return undefined;
    return {
      version,
      gradleHome: root,
      binScript,
      distributionUrl: defaultGradleDistributionUrl(version).url,
      managed: true,
    };
  }

  async ensureDistribution(version: string): Promise<GradleInstall> {
    const existing = this.managedInstall(version);
    if (existing !== undefined) return existing;
    if (this.options.offline) {
      throw new Error(`Gradle ${version} is not present in the JMC cache and offline mode prevents downloading it`);
    }
    const distribution = defaultGradleDistributionUrl(version);
    const archivePath = path.join(this.options.paths.cacheGradle, distribution.archiveName);
    this.options.logger.download(`Downloading Gradle ${version}`, 'Gradle');
    await downloadFile(distribution.url, archivePath, {
      logger: this.options.logger,
      offline: this.options.offline,
      stage: 'Gradle',
      timeoutMs: 30 * 60 * 1000,
    });
    const extractRoot = path.join(this.options.paths.cacheGradle, `gradle-${version}`);
    this.options.logger.info(`Extracting Gradle ${version}`, 'Gradle');
    await extractArchive(archivePath, extractRoot);
    const install = this.managedInstall(version);
    if (install === undefined) {
      const nested = this.findGradleHome(extractRoot);
      if (nested !== undefined) {
        return {
          version,
          gradleHome: nested,
          binScript: path.join(nested, 'bin', detectPlatform().os === 'win32' ? 'gradle.bat' : 'gradle'),
          distributionUrl: distribution.url,
          managed: true,
        };
      }
      throw new Error(`Gradle ${version} distribution extracted but no gradle launcher was found under ${extractRoot}`);
    }
    return install;
  }

  private findGradleHome(root: string): string | undefined {
    const platform = detectPlatform();
    const scriptName = platform.os === 'win32' ? 'gradle.bat' : 'gradle';
    const stack = [root];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      if (this.fs.isFile(path.join(current, 'bin', scriptName))) return current;
      for (const entry of this.fs.readDir(current)) {
        if (entry.isDirectory) stack.push(entry.path);
      }
    }
    return undefined;
  }

  listAvailableForOffline(): string[] {
    return this.installedManagedVersions();
  }
}