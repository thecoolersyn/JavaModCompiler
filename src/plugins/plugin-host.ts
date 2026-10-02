import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { LoaderRegistry } from '../loader/registry.js';
import type { MappingProvider } from '../mappings/types.js';
import type { ModLoaderAdapter } from '../core/types.js';
import type { PluginModuleShape as LoadedPluginShape, ValidatorPlugin } from './types.js';
import type { JmcPaths } from '../platform/paths.js';
import { detectPlatform } from '../platform/os.js';
import { readJarManifest } from '../jar/manifest.js';

export interface PluginModuleShape {
  name?: string;
  version?: string;
  capabilities?: string[];
  description?: string;
  adapters?: ModLoaderAdapter[];
  mappingProviders?: MappingProvider[];
  validators?: ValidatorPlugin[];
  activate?: () => Promise<void> | void;
}

export interface LoadedPlugin {
  source: string;
  name: string;
  version: string;
  capabilities: string[];
  adapterIds: string[];
  mappingProviderIds: string[];
  validatorIds: string[];
  error?: string;
}

export interface PluginLoadResult {
  loaded: LoadedPlugin[];
  failed: LoadedPlugin[];
}

export class PluginHost {
  private readonly paths: JmcPaths;
  private readonly registry: LoaderRegistry;

  constructor(paths: JmcPaths, registry: LoaderRegistry) {
    this.paths = paths;
    this.registry = registry;
  }

  pluginDirectory(): string {
    return this.paths.plugins;
  }

  discover(): string[] {
    const directory = this.pluginDirectory();
    if (!fs.existsSync(directory)) return [];
    const platform = detectPlatform();
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        const packageJson = path.join(full, 'package.json');
        if (fs.existsSync(packageJson)) files.push(full);
        continue;
      }
      if (entry.isFile() && /\.(mjs|js|cjs)$/.test(entry.name)) files.push(full);
      if (platform.os === 'win32' && entry.isFile() && /\.cmd$/i.test(entry.name)) continue;
    }
    return files.sort();
  }

  async loadAll(): Promise<PluginLoadResult> {
    const loaded: LoadedPlugin[] = [];
    const failed: LoadedPlugin[] = [];
    for (const source of this.discover()) {
      try {
        const entry = await importPlugin(source);
        const info = await this.register(entry, source);
        loaded.push(info);
      } catch (error) {
        failed.push({
          source,
          name: path.basename(source),
          version: 'unknown',
          capabilities: [],
          adapterIds: [],
          mappingProviderIds: [],
          validatorIds: [],
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { loaded, failed };
  }

  private async register(entry: PluginModuleShape, source: string): Promise<LoadedPlugin> {
    const name = entry.name ?? path.basename(source);
    const version = entry.version ?? '0.0.0';
    const capabilities = entry.capabilities ?? [];
    const adapters = entry.adapters ?? [];
    const mappingProviders = entry.mappingProviders ?? [];
    const validators = entry.validators ?? [];
    this.registry.registerPlugin({
      descriptor: {
        id: name,
        displayName: name,
        kind: adapters.length > 0 ? 'loader' : mappingProviders.length > 0 ? 'mappings' : 'validator',
        version,
        capabilities,
      },
      adapter: adapters[0],
      mappingProvider: mappingProviders[0],
      validator: validators[0],
      activate: entry.activate,
    });
    for (const adapter of adapters.slice(1)) this.registry.register(adapter);
    return {
      source,
      name,
      version,
      capabilities,
      adapterIds: adapters.map((adapter) => adapter.id),
      mappingProviderIds: mappingProviders.map((provider) => provider.descriptor.id),
      validatorIds: validators.map((validator) => validator.id),
    };
  }
}

async function importPlugin(source: string): Promise<PluginModuleShape> {
  const file = source.endsWith('.json') ? path.join(source, 'index.mjs') : source;
  const url = pathToFileURL(file).href;
  const imported = (await import(url)) as { default?: PluginModuleShape } & PluginModuleShape;
  return imported.default === undefined ? imported : imported.default;
}

export function describePlugins(result: PluginLoadResult): string[] {
  const lines: string[] = [];
  if (result.loaded.length === 0) lines.push('No plugins are installed.');
  for (const plugin of result.loaded) {
    lines.push(`${plugin.name}@${plugin.version}`);
    lines.push(`  source: ${plugin.source}`);
    if (plugin.capabilities.length > 0) lines.push(`  capabilities: ${plugin.capabilities.join(', ')}`);
    if (plugin.adapterIds.length > 0) lines.push(`  loader adapters: ${plugin.adapterIds.join(', ')}`);
    if (plugin.mappingProviderIds.length > 0) lines.push(`  mapping providers: ${plugin.mappingProviderIds.join(', ')}`);
    if (plugin.validatorIds.length > 0) lines.push(`  validators: ${plugin.validatorIds.join(', ')}`);
  }
  for (const plugin of result.failed) {
    lines.push(`${plugin.name} (failed)`);
    lines.push(`  source: ${plugin.source}`);
    lines.push(`  error: ${plugin.error ?? 'unknown'}`);
  }
  return lines;
}

export function pluginManifest(pathToPlugin: string): { name: string; version: string; main: string } | undefined {
  const packageJson = path.join(pathToPlugin, 'package.json');
  if (!fs.existsSync(packageJson)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(packageJson, 'utf8')) as { name?: string; version?: string; main?: string };
    return { name: parsed.name ?? 'plugin', version: parsed.version ?? '0.0.0', main: parsed.main ?? 'index.mjs' };
  } catch {
    return undefined;
  }
}

export function pluginBundleManifest(jarPath: string): Record<string, string> | undefined {
  return readJarManifest(jarPath);
}