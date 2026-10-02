import path from 'node:path';
import type { Logger } from '../logging/logger.js';
import type { ContentCache } from '../cache/cache.js';
import type { JmcPaths } from '../platform/paths.js';
import type { FileSystem } from '../platform/fs.js';
import { detectPlatform } from '../platform/os.js';
import { downloadFile, fetchJson, fetchText, sha256File } from '../net/download.js';
import { defaultFileSystem } from '../platform/fs.js';

export interface MinecraftVersionManifest {
  latest: { release?: string; snapshot?: string };
  versions: Array<{ id: string; type: 'release' | 'snapshot' | 'old_beta' | 'old_alpha'; url: string; time: string; releaseTime: string }>;
}

export interface MinecraftVersionDetail {
  id: string;
  type: string;
  releaseTime: string;
  javaVersion?: { majorVersion: number };
  assets?: string;
  downloads: {
    client?: { url: string; sha1: string; size: number };
    server?: { url: string; sha1: string; size: number };
    client_mappings?: { url: string; sha1: string; size: number };
    server_mappings?: { url: string; sha1: string; size: number };
  };
  libraries: Array<{
    name: string;
    downloads: { artifact?: { url: string; sha1: string; size: number }; path?: string };
    rules?: Array<{ action: 'allow' | 'disallow'; os?: { name?: string; version?: string } }>;
    natives?: Record<string, { classifier: string; rules?: Array<{ action: 'allow' | 'disallow'; os?: { name?: string } }> }>;
  }>;
}

export interface MinecraftArtifactManagerOptions {
  paths: JmcPaths;
  logger: Logger;
  cache: ContentCache;
  offline: boolean;
  fsImpl?: FileSystem;
}

export interface MinecraftArtifacts {
  version: string;
  client?: string;
  server?: string;
  mojangMappings?: string;
  libraries: Array<{ name: string; file: string }>;
  manifest?: MinecraftVersionDetail;
  javaMajor?: number;
  assetIndex?: string;
}

const MOJANG_MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';

export class MinecraftArtifactManager {
  private readonly options: MinecraftArtifactManagerOptions;
  private readonly fs: FileSystem;
  private manifest: MinecraftVersionManifest | undefined;
  private detailCache = new Map<string, MinecraftVersionDetail>();

  constructor(options: MinecraftArtifactManagerOptions) {
    this.options = options;
    this.fs = options.fsImpl ?? defaultFileSystem;
  }

  manifestCachePath(): string {
    return `${this.options.paths.cacheMinecraft}/version_manifest_v2.json`;
  }

  async loadManifest(force = false): Promise<MinecraftVersionManifest | undefined> {
    if (this.manifest !== undefined && !force) return this.manifest;
    const cached = this.manifestCachePath();
    if (!force && this.fs.isFile(cached)) {
      try {
        this.manifest = JSON.parse(this.fs.readText(cached)) as MinecraftVersionManifest;
        return this.manifest;
      } catch {
        this.fs.remove(cached);
      }
    }
    if (this.options.offline) {
      return this.manifest;
    }
    try {
      const manifest = await fetchJson<MinecraftVersionManifest>(MOJANG_MANIFEST_URL, {
        logger: this.options.logger,
        offline: this.options.offline,
      });
      this.fs.writeText(cached, JSON.stringify(manifest));
      this.manifest = manifest;
      return manifest;
    } catch (error) {
      this.options.logger.debug(`Unable to refresh the Mojang version manifest: ${(error as Error).message}`, 'Minecraft');
      if (this.fs.isFile(cached)) {
        this.manifest = JSON.parse(this.fs.readText(cached)) as MinecraftVersionManifest;
        return this.manifest;
      }
      return undefined;
    }
  }

  async knownVersions(): Promise<string[]> {
    const manifest = await this.loadManifest();
    return manifest?.versions.map((entry) => entry.id) ?? [];
  }

  async versionExists(version: string): Promise<boolean> {
    const manifest = await this.loadManifest();
    if (manifest === undefined) return false;
    return manifest.versions.some((entry) => entry.id === version);
  }

  async loadVersionDetail(version: string): Promise<MinecraftVersionDetail | undefined> {
    const cached = this.detailCache.get(version);
    if (cached !== undefined) return cached;
    const localPath = `${this.options.paths.cacheMinecraft}/versions/${version}.json`;
    if (this.fs.isFile(localPath)) {
      try {
        const detail = JSON.parse(this.fs.readText(localPath)) as MinecraftVersionDetail;
        this.detailCache.set(version, detail);
        return detail;
      } catch {
        this.fs.remove(localPath);
      }
    }
    const manifest = await this.loadManifest();
    const entry = manifest?.versions.find((candidate) => candidate.id === version);
    if (entry === undefined) return undefined;
    if (this.options.offline) return undefined;
    try {
      const detail = await fetchJson<MinecraftVersionDetail>(entry.url, {
        logger: this.options.logger,
        offline: this.options.offline,
      });
      this.fs.writeText(localPath, JSON.stringify(detail));
      this.detailCache.set(version, detail);
      return detail;
    } catch (error) {
      this.options.logger.debug(`Unable to download version detail for ${version}: ${(error as Error).message}`, 'Minecraft');
      return undefined;
    }
  }

  async resolve(version: string, options: { includeClient?: boolean; includeServer?: boolean } = {}): Promise<MinecraftArtifacts> {
    const result: MinecraftArtifacts = { version, libraries: [] };
    const detail = await this.loadVersionDetail(version);
    if (detail === undefined) {
      result.manifest = undefined;
      return result;
    }
    result.manifest = detail;
    result.javaMajor = detail.javaVersion?.majorVersion;

    const wantClient = options.includeClient !== false;
    const wantServer = options.includeServer !== false;

    if (wantClient && detail.downloads.client !== undefined) {
      result.client = await this.fetchArtifact('client', version, detail.downloads.client.url, detail.downloads.client.sha1);
    }
    if (wantServer && detail.downloads.server !== undefined) {
      result.server = await this.fetchArtifact('server', version, detail.downloads.server.url, detail.downloads.server.sha1);
    }
    if (detail.downloads.client_mappings !== undefined) {
      result.mojangMappings = await this.fetchArtifact('client-mappings', version, detail.downloads.client_mappings.url, detail.downloads.client_mappings.sha1);
    }
    for (const library of detail.libraries) {
      const artifact = library.downloads.artifact;
      if (artifact === undefined) continue;
      const file = await this.fetchMavenArtifact(version, library.name, artifact.url, artifact.sha1);
      result.libraries.push({ name: library.name, file });
    }
    if (detail.assets !== undefined) {
      result.assetIndex = await this.fetchAssetIndex(detail.assets, version);
    }
    return result;
  }

  private async fetchArtifact(kind: string, version: string, url: string, sha1: string): Promise<string> {
    const fileName = `${version}-${kind}.jar`;
    const target = `${this.options.paths.cacheMinecraft}/versions/${version}/${fileName}`;
    const lookup = this.options.cache.lookup(target);
    if (lookup.hit && lookup.path !== undefined) return lookup.path;
    if (this.options.offline) {
      throw new Error(`Minecraft ${kind} for ${version} is not present in the JMC cache and offline mode is enabled`);
    }
    this.options.logger.download(`Downloading Minecraft ${kind} ${version}`, 'Minecraft');
    await downloadFile(url, target, {
      logger: this.options.logger,
      offline: this.options.offline,
      stage: 'Minecraft',
      expectedSha1: sha1,
      timeoutMs: 30 * 60 * 1000,
    });
    this.options.cache.store(target, { kind: `minecraft-${kind}`, toolchainKey: version, checksum: sha1, checksumAlgorithm: 'sha1' });
    return target;
  }

  private async fetchMavenArtifact(version: string, coordinate: string, url: string, sha1: string): Promise<string> {
    const parts = coordinate.split(':');
    const groupId = parts[0] ?? 'unknown';
    const artifactId = parts[1] ?? 'unknown';
    const artifactVersion = parts[2] ?? 'unknown';
    const classifier = parts[3];
    const extension = parts[4] ?? 'jar';
    const suffix = classifier !== undefined ? `-${classifier}` : '';
    const fileName = `${artifactId}-${artifactVersion}${suffix}.${extension}`;
    const relative = `${groupId.replace(/\./g, '/')}/${artifactId}/${artifactVersion}/${fileName}`;
    const target = `${this.options.paths.cacheMinecraft}/libraries/${relative}`;
    const lookup = this.options.cache.lookup(target);
    if (lookup.hit && lookup.path !== undefined) return lookup.path;
    if (this.options.offline) {
      if (this.fs.isFile(target)) return target;
      throw new Error(`Library ${coordinate} for ${version} is not cached and offline mode is enabled`);
    }
    this.options.logger.download(`Downloading library ${coordinate}`, 'Minecraft');
    await downloadFile(url, target, {
      logger: this.options.logger,
      offline: this.options.offline,
      stage: 'Minecraft',
      expectedSha1: sha1,
      timeoutMs: 30 * 60 * 1000,
    });
    this.options.cache.store(target, { kind: 'minecraft-library', toolchainKey: version, checksum: sha1, checksumAlgorithm: 'sha1' });
    return target;
  }

  private async fetchAssetIndex(assetIndex: string, version: string): Promise<string> {
    const target = `${this.options.paths.cacheMinecraft}/assets/${assetIndex}.json`;
    if (this.fs.isFile(target)) return target;
    if (this.options.offline) return target;
    const url = `https://piston-meta.mojang.com/v1/packages/${assetIndex}/${assetIndex}.json`;
    try {
      const content = await fetchText(url, { logger: this.options.logger, offline: this.options.offline });
      this.fs.writeText(target, content);
      return target;
    } catch (error) {
      this.options.logger.debug(`Asset index ${assetIndex} could not be downloaded: ${(error as Error).message}`, 'Minecraft');
      return target;
    }
  }

  interpolatedJarPath(version: string): string {
    return `${this.options.paths.cacheMinecraft}/versions/${version}/${version}.jar`;
  }

  librariesClasspath(artifacts: MinecraftArtifacts): string[] {
    return artifacts.libraries.map((library) => library.file);
  }

  cachedVersions(): string[] {
    const root = `${this.options.paths.cacheMinecraft}/versions`;
    if (!this.fs.isDirectory(root)) return [];
    return this.fs
      .readDir(root)
      .filter((entry) => entry.isDirectory)
      .map((entry) => entry.name);
  }

  checksumOf(version: string, kind: 'client' | 'server'): string | undefined {
    const filePath = `${this.options.paths.cacheMinecraft}/versions/${version}/${version}-${kind}.jar`;
    if (!this.fs.isFile(filePath)) return undefined;
    return sha256File(filePath);
  }

  platformKey(): string {
    const platform = detectPlatform();
    return `${platform.os}-${platform.arch}`;
  }

  versionCachePath(version: string): string {
    return path.join(this.options.paths.cacheMinecraft, 'versions', `${version}.json`);
  }
}