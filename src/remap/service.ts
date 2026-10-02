import path from 'node:path';
import type { Logger } from '../logging/logger.js';
import type { ContentCache } from '../cache/cache.js';
import type { JmcPaths } from '../platform/paths.js';
import type { FileSystem } from '../platform/fs.js';
import { defaultFileSystem } from '../platform/fs.js';
import { buildMappingTree, remapClassName, remapMemberName } from '../mappings/providers.js';
import type { MappingDescriptor, MappingTree } from '../mappings/types.js';
import { inspectJar, jarEntryNames, writeJar, type JarEntryInput } from '../jar/jar.js';
import { openZip } from '../jar/zip.js';
import { parseClass, writeClass, type ClassRemapContext, type ClassModel } from './class-writer.js';
import { readZipEntryText } from '../jar/zip.js';

export interface RemapperServiceOptions {
  paths: JmcPaths;
  logger: Logger;
  cache: ContentCache;
  offline: boolean;
  fsImpl?: FileSystem;
}

export interface RemapRequest {
  inputJar: string;
  outputJar: string;
  mappings: MappingDescriptor;
  mappingsFile: string;
  fromNamespace: string;
  toNamespace: string;
  refmapNamespace?: string;
  includes?: string[];
  excludes?: string[];
  mixinConfigs?: string[];
  remapMixinConfigs?: boolean;
  manifestAttributes?: Record<string, string | undefined>;
  deterministic?: boolean;
}

export interface RemapResult {
  outputJar: string;
  classesRemapped: number;
  classesUnchanged: number;
  resourcesCopied: number;
  mixinConfigsRemapped: number;
  warnings: string[];
  tookNoop: boolean;
}

export interface RemapperService {
  remap(request: RemapRequest): Promise<RemapResult>;
  describeTree(mappingsFile: string, descriptor: MappingDescriptor, from: string, to: string): MappingTree;
  remapClassName(tree: MappingTree, className: string): string;
  remapMemberName(tree: MappingTree, owner: string, kind: 'm' | 'f', descriptor: string, name: string): string;
}

const NO_MAPPINGS_FOR = new Set(['java/', 'javax/', 'jdk/', 'sun/', 'com/sun/', 'org/objectweb/asm/']);

export class TinyRemapper implements RemapperService {
  private readonly options: RemapperServiceOptions;
  private readonly fs: FileSystem;

  constructor(options: RemapperServiceOptions) {
    this.options = options;
    this.fs = options.fsImpl ?? defaultFileSystem;
  }

  describeTree(mappingsFile: string, descriptor: MappingDescriptor, from: string, to: string): MappingTree {
    return buildMappingTree(descriptor, mappingsFile, from, to);
  }

  remapClassName(tree: MappingTree, className: string): string {
    return remapClassName(tree, className);
  }

  remapMemberName(tree: MappingTree, owner: string, kind: 'm' | 'f', descriptor: string, name: string): string {
    return remapMemberName(tree, owner, kind, descriptor, name);
  }

  async remap(request: RemapRequest): Promise<RemapResult> {
    const fs = this.fs;
    const result: RemapResult = {
      outputJar: request.outputJar,
      classesRemapped: 0,
      classesUnchanged: 0,
      resourcesCopied: 0,
      mixinConfigsRemapped: 0,
      warnings: [],
      tookNoop: false,
    };
    if (!fs.isFile(request.inputJar)) {
      throw new Error(`Input JAR does not exist: ${request.inputJar}`);
    }
    if (!fs.isFile(request.mappingsFile)) {
      throw new Error(`Mappings file does not exist: ${request.mappingsFile}`);
    }
    const tree = this.describeTree(request.mappingsFile, request.mappings, request.fromNamespace, request.toNamespace);
    if (tree.classes.size === 0) {
      result.tookNoop = true;
      result.warnings.push(
        `No class mappings were loaded from ${path.basename(request.mappingsFile)} for ${request.fromNamespace} -> ${request.toNamespace}; the JAR was copied unchanged.`,
      );
    }
    const archive = openZip(request.inputJar);
    const entries: JarEntryInput[] = [];
    const includeFilter = request.includes;
    const excludeFilter = request.excludes;

    for (const entry of archive.entries) {
      if (entry.isDirectory) continue;
      const name = entry.name;
      if (includeFilter !== undefined && !includeFilter.some((pattern) => name.startsWith(pattern))) continue;
      if (excludeFilter !== undefined && excludeFilter.some((pattern) => name.startsWith(pattern))) continue;
      if (isRemappedResource(name, request.mixinConfigs ?? [])) continue;
      if (name.toLowerCase() === 'meta-inf/manifest.mf') continue;
      if (name.endsWith('.class')) {
        const internalName = name.slice(0, -6);
        if (shouldSkipClass(internalName)) {
          entries.push({ name, data: archive.read(entry) });
          result.classesUnchanged += 1;
          continue;
        }
        const data = archive.read(entry);
        try {
          const model = parseClass(data);
          const remapped = this.remapClass(model, tree);
          const output = writeClass(model, remapped);
          const newName = `${remapClassName(tree, internalName).replace(/\./g, '/')}.class`;
          entries.push({ name: newName, data: output });
          if (newName === name) result.classesUnchanged += 1;
          else result.classesRemapped += 1;
        } catch (error) {
          result.warnings.push(`Class ${name} could not be remapped: ${(error as Error).message}`);
          entries.push({ name, data });
          result.classesUnchanged += 1;
        }
        continue;
      }
      entries.push({ name, data: archive.read(entry) });
      result.resourcesCopied += 1;
    }

    for (const mixinConfig of request.mixinConfigs ?? []) {
      const remappedText = this.remapMixinConfig(request, tree, mixinConfig);
      if (remappedText !== undefined) {
        entries.push({ name: mixinConfig, data: Buffer.from(remappedText, 'utf8'), storeOnly: true });
        result.mixinConfigsRemapped += 1;
      }
    }

    const manifestText = readZipEntryText(request.inputJar, 'META-INF/MANIFEST.MF');
    const manifest = manifestText === undefined ? undefined : rewriteManifest(manifestText, tree);
    writeJar(request.outputJar, entries, {
      manifest: manifest ?? buildFallbackManifest(request),
      deterministic: request.deterministic === true,
    });
    return result;
  }

  private remapMixinConfig(request: RemapRequest, tree: MappingTree, configName: string): string | undefined {
    if (request.remapMixinConfigs !== true) return undefined;
    const text = readZipEntryText(request.inputJar, configName);
    if (text === undefined) return undefined;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return undefined;
    }
    const packages = Array.isArray(parsed.package) ? (parsed.package as string[]) : [];
    const remappedPackages = packages.map((entry) => remapClassName(tree, entry));
    const mixins = Array.isArray(parsed.mixin) ? (parsed.mixin as string[]) : [];
    const remappedMixins = mixins.map((entry) => remapClassName(tree, entry));
    if (request.refmapNamespace !== undefined && typeof parsed.refmap === 'string') {
      parsed.refmap = request.refmapNamespace;
    }
    parsed.package = remappedPackages;
    parsed.mixin = remappedMixins;
    return JSON.stringify(parsed, null, 2);
  }

  private remapClass(model: ClassModel, tree: MappingTree): ClassRemapContext {
    const sourceOwner = model.thisClass;
    const mapInternalName = (name: string): string => {
      if (name.startsWith('[')) return name;
      if (shouldSkipClass(name)) return name;
      return remapClassName(tree, name).replace(/\./g, '/');
    };
    const context: ClassRemapContext = {
      mapInternalName,
      mapMethodName: (owner: string, name: string, descriptor: string): string => {
        if (name.startsWith('<') || shouldSkipClass(owner)) return name;
        const remappedOwner = mapInternalName(owner);
        return remapMemberName(tree, remappedOwner, 'm', descriptor, name);
      },
      mapFieldName: (owner: string, name: string, descriptor: string): string => {
        if (shouldSkipClass(owner)) return name;
        const remappedOwner = mapInternalName(owner);
        return remapMemberName(tree, remappedOwner, 'f', descriptor, name);
      },
      mapInvokeDynamicName: (owner: string, bootstrapName: string): string => {
        if (bootstrapName.startsWith('<')) return bootstrapName;
        const remappedOwner = mapInternalName(owner);
        return remapMemberName(tree, remappedOwner, 'm', '()V', bootstrapName);
      },
    };
    void sourceOwner;
    return context;
  }
}

function shouldSkipClass(internalName: string): boolean {
  for (const prefix of NO_MAPPINGS_FOR) {
    if (internalName.startsWith(prefix)) return true;
  }
  return false;
}

function isRemappedResource(name: string, mixinConfigs: string[]): boolean {
  if (mixinConfigs.includes(name)) return true;
  return name.endsWith('.refmap.json');
}

function rewriteManifest(text: string, tree: MappingTree): string {
  let out = text;
  const mainClass = /Main-Class:\s*(\S+)/.exec(text)?.[1];
  if (mainClass !== undefined) {
    const remapped = remapClassName(tree, mainClass);
    if (remapped !== mainClass) out = out.replace(`Main-Class: ${mainClass}`, `Main-Class: ${remapped}`);
  }
  return out.endsWith('\n') ? out : `${out}\n`;
}

function buildFallbackManifest(request: RemapRequest): string {
  const lines = ['Manifest-Version: 1.0'];
  for (const [key, value] of Object.entries(request.manifestAttributes ?? {})) {
    if (value === undefined) continue;
    lines.push(`${key}: ${value}`);
  }
  lines.push('');
  return lines.join('\r\n');
}

export function classFileNames(jarPath: string): string[] {
  return jarEntryNames(jarPath).filter((name) => name.endsWith('.class'));
}

export function summarizeJar(jarPath: string): string[] {
  const inspection = inspectJar(jarPath);
  return [
    `file: ${jarPath}`,
    `entries: ${inspection.entryCount}`,
    `classes: ${inspection.classCount}`,
    `resources: ${inspection.resourceCount}`,
    `size: ${inspection.sizeBytes} bytes`,
  ];
}

export function mixinConfigNames(jarPath: string): string[] {
  return jarEntryNames(jarPath).filter((name) => /mixin.*\.json$/i.test(name));
}