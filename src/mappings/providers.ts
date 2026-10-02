import path from 'node:path';
import { defaultFileSystem } from '../platform/fs.js';
import { detectPlatform } from '../platform/os.js';
import type {
  ClassMapping,
  MappingDescriptor,
  MappingEntryCounts,
  NamespaceSide,
  MappingFormat,
  MappingNamespace,
  MappingProvider,
  MappingProviderDescriptor,
  MappingTree,
} from './types.js';
import { emptyEntryCounts } from './types.js';

const TEXT_EXTENSIONS = new Set(['.tiny', '.txt', '.tsrg', '.srg', '.pro', '.csv', '.json', '.v2', '.mappings', '.map', '.tpl']);

export function detectFormatFromExtension(filePath: string): MappingFormat | undefined {
  const lower = filePath.toLowerCase();
  const base = path.basename(lower);
  if (base.endsWith('.tiny') || base.endsWith('.tiny.v2')) return base.endsWith('.v2') ? 'tiny-v2' : 'tiny-v1';
  if (base.endsWith('.tsrg2')) return 'tsrg2';
  if (base.endsWith('.tsrg')) return 'tsrg';
  if (base.endsWith('.srg')) return 'srg';
  if (base.endsWith('.pro') || base.endsWith('.proguard')) return 'proguard';
  if (base.endsWith('.mappings') || base.endsWith('.map') || base.endsWith('.txt')) return 'mojang';
  if (base.endsWith('.json')) return 'parchment';
  return undefined;
}

const SOURCE_NAMESPACE_ALIASES = new Set(['official', 'obf', 'obfuscated', 'srg', 'notch', 'root', 'a', '0']);
const INTERMEDIARY_NAMESPACE_ALIASES = new Set(['intermediary', 'interm', 'inm']);
const TARGET_NAMESPACE_ALIASES = new Set(['named', 'mcp', 'searparchment', 'parchment', 'b', '1']);

function classifyNamespace(name: string, index: number): NamespaceSide {
  const normalized = name.trim().toLowerCase();
  if (SOURCE_NAMESPACE_ALIASES.has(normalized)) return 'primary';
  if (INTERMEDIARY_NAMESPACE_ALIASES.has(normalized)) return 'intermediary';
  if (TARGET_NAMESPACE_ALIASES.has(normalized)) return 'target';
  return index === 0 ? 'primary' : 'target';
}

function namespacesOf(names: string[]): { mapped: MappingNamespace[]; primary: string; target: string } {
  const mapped = names.map((name, index): MappingNamespace => ({ name, side: classifyNamespace(name, index) }));
  const primary =
    mapped.find((entry) => entry.side === 'primary')?.name ??
    mapped.find((entry) => entry.side === 'intermediary')?.name ??
    mapped[0]?.name ??
    'official';
  const target =
    mapped.find((entry) => entry.side === 'target' && entry.name !== primary)?.name ??
    mapped[mapped.length - 1]?.name ??
    'named';
  return { mapped, primary, target };
}

export class TinyMappingProvider implements MappingProvider {
  readonly descriptor: MappingProviderDescriptor = {
    id: 'tiny',
    name: 'Tiny v1 / v2',
    formats: ['tiny-v1', 'tiny-v2'],
    extensions: ['.tiny'],
    namespaces: [],
    detectConfidence: (entries) => scoreBySuffix(entries, '.tiny', 90),
  };

  async probe(directory: string): Promise<MappingDescriptor | undefined> {
    const fs = defaultFileSystem;
    const files = fs.walk(directory, { maxDepth: 8 }).filter((entry) => entry.isFile);
    const candidates = files.filter((entry) => detectFormatFromExtension(entry.path) === 'tiny-v1' || detectFormatFromExtension(entry.path) === 'tiny-v2');
    if (candidates.length === 0) return undefined;
    let best: MappingDescriptor | undefined;
    for (const candidate of candidates) {
      const descriptor = this.describeFile(directory, candidate.path);
      if (descriptor === undefined) continue;
      if (best === undefined || descriptor.entryCounts.classes > best.entryCounts.classes) best = descriptor;
    }
    return best;
  }

  private describeFile(directory: string, filePath: string): MappingDescriptor | undefined {
    const fs = defaultFileSystem;
    const content = fs.readText(filePath);
    const headerLine = content.split('\n')[0]?.trim() ?? '';
    let format: MappingFormat;
    if (/^tiny\s+2\s+0\s+/.test(headerLine)) format = 'tiny-v2';
    else if (/^tiny\s+1\s+/.test(headerLine)) format = 'tiny-v1';
    else return undefined;
    const declaredFormat = detectFormatFromExtension(filePath);
    const confidence = declaredFormat === format ? 95 : 70;
    const counts = emptyEntryCounts();
    const classNames = new Set<string>();
    const provenance: string[] = [];
    const notes: string[] = [];
    const header = parseTinyHeader(headerLine);
    const namespaces = header?.namespaces ?? [];
    for (const rawLine of content.split('\n')) {
      const line = rawLine.replace(/\r$/, '');
      if (line.length === 0) continue;
      const indented = line.startsWith('\t');
      const kind = indented ? line[1] : line[0];
      if (kind === 'c' && !indented) {
        const parts = line.split('\t');
        classNames.add(parts[1] ?? '');
        counts.classes += 1;
      } else if (kind === 'f' && indented) counts.fields += 1;
      else if (kind === 'm' && indented) counts.methods += 1;
      else if (kind === 'p' && indented) counts.parameters += 1;
    }
    counts.classes = Math.max(counts.classes, classNames.size);
    if (namespaces.length < 2) return undefined;
    const resolved = namespacesOf(namespaces);
    provenance.push(`Header namespaces: ${namespaces.join(', ')}`);
    const parchment = extractParchmentSidecar(directory);
    let versionHint = extractTinyVersionHint(content, filePath);
    if (parchment?.minecraftVersion !== undefined) {
      provenance.push(`Parchment metadata declares Minecraft ${parchment.minecraftVersion}`);
      if (versionHint.version === parchment.minecraftVersion) versionHint = { ...versionHint, confidence: 'high' };
    }
    if (format === 'tiny-v1') {
      notes.push('Tiny v1 does not record parameter names; parameter remapping is limited to descriptors.');
    }
    return {
      format,
      formatConfidence: confidence,
      providerId: this.descriptor.id,
      namespaces: resolved.mapped,
      primaryNamespace: resolved.primary,
      targetNamespace: resolved.target,
      minecraft: versionHint,
      entryCounts: counts,
      fileCount: 1,
      totalBytes: fs.stat(filePath).size,
      files: [{ path: filePath, sizeBytes: fs.stat(filePath).size, declaredFormat }],
      parchment,
      provenance,
      notes,
      directory,
    };
  }
}

export class TsrgMappingProvider implements MappingProvider {
  readonly descriptor: MappingProviderDescriptor = {
    id: 'tsrg',
    name: 'TSRG / TSRG2 / SRG',
    formats: ['tsrg', 'tsrg2', 'srg'],
    extensions: ['.tsrg', '.tsrg2', '.srg'],
    namespaces: ['official', 'named'],
    detectConfidence: (entries) =>
      Math.max(scoreBySuffix(entries, '.tsrg', 90), scoreBySuffix(entries, '.tsrg2', 92), scoreBySuffix(entries, '.srg', 88)),
  };

  async probe(directory: string): Promise<MappingDescriptor | undefined> {
    const fs = defaultFileSystem;
    const files = fs
      .walk(directory, { maxDepth: 8 })
      .filter((entry) => entry.isFile && ['.tsrg', '.tsrg2', '.srg'].includes(path.extname(entry.path).toLowerCase()));
    if (files.length === 0) return undefined;
    const primary = files.find((entry) => entry.path.toLowerCase().endsWith('.tsrg2')) ?? files[0];
    if (primary === undefined) return undefined;
    const extension = path.extname(primary.path).toLowerCase();
    const format: MappingFormat = extension === '.tsrg2' ? 'tsrg2' : extension === '.tsrg' ? 'tsrg' : 'srg';
    const content = fs.readText(primary.path);
    const counts = format === 'srg' ? countSrgEntries(content) : countTsrgEntries(content);
    const resolved = namespacesOf(format === 'tsrg2' ? tsrg2Namespaces(content) : ['official', 'named']);
    const notes: string[] = [];
    if (format === 'tsrg') notes.push('TSRG v1 does not remap method parameters.');
    if (format === 'srg') notes.push('SRG mappings use the official and named namespaces without parameter names.');
    return {
      format,
      formatConfidence: 90,
      providerId: this.descriptor.id,
      namespaces: resolved.mapped,
      primaryNamespace: resolved.primary,
      targetNamespace: resolved.target,
      minecraft: extractVersionHintFromText(content, primary.path),
      entryCounts: counts,
      fileCount: files.length,
      totalBytes: files.reduce((total, entry) => total + entry.size, 0),
      files: files.map((entry) => ({ path: entry.path, sizeBytes: entry.size, declaredFormat: detectFormatFromExtension(entry.path) })),
      provenance: [`Primary mapping file: ${path.basename(primary.path)}`],
      notes,
      directory,
    };
  }
}

function tsrg2Namespaces(content: string): string[] {
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('tsrg2 ')) continue;
    const parts = line.split(/\s+/);
    return parts.slice(1).filter((value) => value.length > 0);
  }
  return ['official', 'named'];
}

function countTsrgEntries(content: string): MappingEntryCounts {
  const counts = emptyEntryCounts();
  for (const rawLine of content.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line.trim().length === 0) continue;
    if (/^tsrg2?\s/.test(line)) continue;
    if (!/^[\t ]/.test(line)) {
      counts.classes += 1;
      continue;
    }
    const body = line.trim();
    if (/^[mp]\b/.test(body) || /\([^)]*\)/.test(body)) counts.methods += 1;
    else if (/^f\b/.test(body)) counts.fields += 1;
    else if (body.split(/\s+/).length >= 3) counts.methods += 1;
    else counts.fields += 1;
  }
  return counts;
}

function countSrgEntries(content: string): MappingEntryCounts {
  const counts = emptyEntryCounts();
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    if (line.startsWith('CL: ')) counts.classes += 1;
    else if (line.startsWith('FD: ')) counts.fields += 1;
    else if (line.startsWith('MD: ')) counts.methods += 1;
  }
  return counts;
}

export class ProguardMappingProvider implements MappingProvider {
  readonly descriptor: MappingProviderDescriptor = {
    id: 'proguard',
    name: 'ProGuard-like',
    formats: ['proguard', 'yarn', 'intermediary'],
    extensions: ['.pro', '.txt'],
    namespaces: [],
    detectConfidence: (entries) => scoreBySuffix(entries, '.pro', 60),
  };

  async probe(directory: string): Promise<MappingDescriptor | undefined> {
    const fs = defaultFileSystem;
    const files = fs
      .walk(directory, { maxDepth: 8 })
      .filter((entry) => entry.isFile && PROGUARD_EXTENSIONS.has(path.extname(entry.path).toLowerCase()))
      .filter((entry) => !looksLikeMojangHeader(entry.path));
    if (files.length === 0) return undefined;
    let best: MappingDescriptor | undefined;
    for (const candidate of files) {
      const descriptor = this.describeFile(directory, candidate.path);
      if (descriptor === undefined) continue;
      if (best === undefined || descriptor.entryCounts.classes > best.entryCounts.classes) best = descriptor;
    }
    return best;
  }

  private describeFile(directory: string, filePath: string): MappingDescriptor | undefined {
    const fs = defaultFileSystem;
    const content = fs.readText(filePath);
    const counts = countProguardEntries(content);
    if (counts.classes === 0) return undefined;
    const kind = classifyProguardSource(directory, filePath);
    const format: MappingFormat = kind === 'yarn' ? 'yarn' : kind === 'intermediary' ? 'intermediary' : 'proguard';
    const namespaces =
      kind === 'yarn'
        ? [
            { name: 'intermediary', side: 'primary' as const },
            { name: 'named', side: 'target' as const },
          ]
        : [
            { name: 'official', side: 'primary' as const },
            { name: 'named', side: 'target' as const },
          ];
    return {
      format,
      formatConfidence: kind === 'proguard' ? 55 : 78,
      providerId: this.descriptor.id,
      namespaces,
      primaryNamespace: namespaces[0]?.name ?? 'official',
      targetNamespace: namespaces[1]?.name ?? 'named',
      minecraft: extractVersionHintFromText(content, filePath),
      entryCounts: counts,
      fileCount: 1,
      totalBytes: fs.stat(filePath).size,
      files: [{ path: filePath, sizeBytes: fs.stat(filePath).size, declaredFormat: format }],
      provenance: [`ProGuard source file: ${path.basename(filePath)}`, `classified as ${kind}`],
      notes: ['ProGuard mappings carry no parameter names; only class, field and method names are available.'],
      directory,
    };
  }
}

const PROGUARD_EXTENSIONS = new Set(['.pro', '.txt']);

export function looksLikeMojangHeader(filePath: string): boolean {
  try {
    const head = defaultFileSystem.readText(filePath).slice(0, 4096);
    return /#\s*(com\.mojang|net\.minecraft)/i.test(head);
  } catch {
    return false;
  }
}

function countProguardEntries(content: string): MappingEntryCounts {
  const counts = emptyEntryCounts();
  let classCount = 0;
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    if (/^[\w.$]+ -> .+:$/.test(line)) classCount += 1;
    else if (/^\s+.*\(.*\)[^;]*;?$/.test(line)) counts.methods += 1;
    else if (/^\s+[\w.$<>\[\]]+\s+[\w.$<>\[\]]+;?$/.test(line)) counts.fields += 1;
  }
  counts.classes = classCount;
  return counts;
}

export class MojangMappingProvider implements MappingProvider {
  readonly descriptor: MappingProviderDescriptor = {
    id: 'mojang',
    name: 'Mojang ProGuard mappings',
    formats: ['mojang', 'parchment'],
    extensions: ['.txt', '.json'],
    namespaces: [],
    detectConfidence: (entries) => Math.max(scoreBySuffix(entries, '.txt', 20), scoreBySuffix(entries, '.json', 10)),
  };

  async probe(directory: string): Promise<MappingDescriptor | undefined> {
    const fs = defaultFileSystem;
    const files = fs
      .walk(directory, { maxDepth: 8 })
      .filter((entry) => entry.isFile && path.extname(entry.path).toLowerCase() === '.txt' && entry.size > 16);
    for (const candidate of files) {
      if (!looksLikeMojangHeader(candidate.path)) continue;
      const content = fs.readText(candidate.path);
      const counts = countProguardEntries(content);
      const namespaces: MappingNamespace[] = [
        { name: 'official', side: 'primary' },
        { name: 'named', side: 'target' },
      ];
      const parchment = extractParchmentSidecar(directory);
      return {
        format: 'mojang',
        formatConfidence: 82,
        providerId: this.descriptor.id,
        namespaces,
        primaryNamespace: 'official',
        targetNamespace: 'named',
        minecraft: extractVersionHintFromText(content, candidate.path),
        entryCounts: counts,
        fileCount: 1,
        totalBytes: candidate.size,
        files: [{ path: candidate.path, sizeBytes: candidate.size, declaredFormat: 'mojang' }],
        parchment,
        provenance: [`Mojang ProGuard header detected in ${path.basename(candidate.path)}`],
        notes: [],
        directory,
      };
    }
    return undefined;
  }
}

export class ParchmentMappingProvider implements MappingProvider {
  readonly descriptor: MappingProviderDescriptor = {
    id: 'parchment',
    name: 'Parchment parameter and documentation data',
    formats: ['parchment'],
    extensions: ['.json'],
    namespaces: ['official', 'named'],
    detectConfidence: (entries) => scoreBySuffix(entries, '.parchment.json', 80),
  };

  async probe(directory: string): Promise<MappingDescriptor | undefined> {
    const fs = defaultFileSystem;
    const files = fs
      .walk(directory, { maxDepth: 8 })
      .filter((entry) => entry.isFile && /parchment.*\.json$/i.test(entry.path));
    if (files.length === 0) return undefined;
    const primary = files[0];
    if (primary === undefined) return undefined;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(fs.readText(primary.path)) as Record<string, unknown>;
    } catch {
      return undefined;
    }
    const classes = Array.isArray(parsed.classes) ? (parsed.classes as unknown[]) : [];
    let parameters = 0;
    for (const entry of classes) {
      const list = (entry as { parameters?: unknown[] }).parameters;
      if (Array.isArray(list)) parameters += list.length;
    }
    const namespaces: MappingNamespace[] = [
      { name: 'official', side: 'primary' },
      { name: 'named', side: 'target' },
    ];
    return {
      format: 'parchment',
      formatConfidence: 85,
      providerId: this.descriptor.id,
      namespaces,
      primaryNamespace: 'official',
      targetNamespace: 'named',
      minecraft: {
        version: typeof parsed.minecraftVersion === 'string' ? parsed.minecraftVersion : undefined,
        confidence: typeof parsed.minecraftVersion === 'string' ? 'high' : 'low',
        source: 'parchment metadata',
      },
      entryCounts: { classes: classes.length, fields: 0, methods: 0, parameters },
      fileCount: files.length,
      totalBytes: files.reduce((total, entry) => total + entry.size, 0),
      files: files.map((entry) => ({ path: entry.path, sizeBytes: entry.size, declaredFormat: 'parchment' })),
      parchment: {
        name: typeof parsed.name === 'string' ? parsed.name : undefined,
        version: typeof parsed.version === 'string' ? parsed.version : undefined,
        targetNamespace: typeof parsed.targetNamespace === 'string' ? parsed.targetNamespace : undefined,
        minecraftVersion: typeof parsed.minecraftVersion === 'string' ? parsed.minecraftVersion : undefined,
      },
      provenance: [`Parchment metadata file: ${path.basename(primary.path)}`],
      notes: ['Parchment supplies parameter names and documentation on top of another mapping set.'],
      directory,
    };
  }
}

export function classifyProguardSource(directory: string, filePath: string): 'yarn' | 'intermediary' | 'proguard' {
  const haystack = `${directory} ${filePath}`.toLowerCase();
  if (haystack.includes('yarn')) return 'yarn';
  if (haystack.includes('intermediary')) return 'intermediary';
  return 'proguard';
}

export function extractParchmentSidecar(directory: string): { name?: string; version?: string; targetNamespace?: string; minecraftVersion?: string } | undefined {
  const fs = defaultFileSystem;
  const files = fs
    .walk(directory, { maxDepth: 6 })
    .filter((entry) => entry.isFile && /parchment.*\.json$/i.test(entry.path));
  for (const file of files) {
    try {
      const parsed = JSON.parse(fs.readText(file.path)) as Record<string, unknown>;
      return {
        name: typeof parsed.name === 'string' ? parsed.name : undefined,
        version: typeof parsed.version === 'string' ? parsed.version : undefined,
        targetNamespace: typeof parsed.targetNamespace === 'string' ? parsed.targetNamespace : undefined,
        minecraftVersion: typeof parsed.minecraftVersion === 'string' ? parsed.minecraftVersion : undefined,
      };
    } catch {
      continue;
    }
  }
  return undefined;
}

const VERSION_PATTERN = /\b(\d{1,2}\.\d{1,2}(?:\.\d{1,3})?)\b/;

export function extractVersionHintFromText(content: string, filePath: string): { version?: string; confidence: 'high' | 'medium' | 'low' | 'none'; source?: string } {
  const headerBlock = content.slice(0, 2048);
  const explicit = /minecraft[^\n\d]{0,24}(\d{1,2}\.\d{1,2}(?:\.\d{1,3})?)/i.exec(headerBlock);
  if (explicit?.[1] !== undefined) {
    return { version: explicit[1], confidence: 'high', source: 'mapping header' };
  }
  const fromName = VERSION_PATTERN.exec(path.basename(filePath));
  if (fromName?.[1] !== undefined) {
    return { version: fromName[1], confidence: 'medium', source: 'file name' };
  }
  const inContent = VERSION_PATTERN.exec(headerBlock);
  if (inContent?.[1] !== undefined) {
    return { version: inContent[1], confidence: 'low', source: 'mapping content' };
  }
  return { confidence: 'none', source: 'not found' };
}

export function extractTinyVersionHint(content: string, filePath: string): { version?: string; confidence: 'high' | 'medium' | 'low' | 'none'; source?: string } {
  return extractVersionHintFromText(content, filePath);
}

function scoreBySuffix(entries: string[], suffix: string, weight: number): number {
  const matches = entries.filter((entry) => entry.toLowerCase().endsWith(suffix));
  if (matches.length === 0) return 0;
  return Math.min(100, weight + matches.length * 2);
}

export function looksLikeMappingsDirectory(directory: string): boolean {
  const fs = defaultFileSystem;
  if (!fs.isDirectory(directory)) return false;
  const entries = fs.readDir(directory);
  if (entries.some((entry) => TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))) return true;
  return fs.walk(directory, { maxDepth: 4 }).some((entry) => entry.isFile && TEXT_EXTENSIONS.has(path.extname(entry.path).toLowerCase()));
}

export function parseTinyHeader(line: string): { version: 1 | 2; namespaces: string[] } | undefined {
  const parts = line.trim().split(/\s+/);
  if (parts[0] !== 'tiny') return undefined;
  const version = Number.parseInt(parts[1] ?? '', 10);
  if (version !== 1 && version !== 2) return undefined;
  const rest = parts.slice(2);
  const namespaces = version === 2 ? rest.slice(1) : rest;
  return { version, namespaces: namespaces.filter((value) => value.length > 0) };
}

export function buildMappingTree(
  descriptor: MappingDescriptor,
  filePath: string,
  fromNamespace: string,
  toNamespace: string,
): MappingTree {
  const fs = defaultFileSystem;
  const content = fs.readText(filePath);
  const headerLine = content.split('\n')[0] ?? '';
  const header = parseTinyHeader(headerLine);
  const namespaces = header?.namespaces ?? [descriptor.primaryNamespace, descriptor.targetNamespace];
  const fromIndex = namespaces.indexOf(fromNamespace);
  const toIndex = namespaces.indexOf(toNamespace);
  const classes = new Map<string, ClassMapping>();
  const parameterNames = new Map<string, string>();
  if (fromIndex === -1 || toIndex === -1) {
    return { format: descriptor.format, namespaces, primaryNamespace: descriptor.primaryNamespace, targetNamespace: descriptor.targetNamespace, classes, parameters: parameterNames };
  }
  let currentClass: ClassMapping | undefined;
  let pendingOwner: string | undefined;
  let pendingDescriptorKey: string | undefined;
  let pendingDescriptor: string | undefined;
  let pendingKind: 'm' | 'f' | undefined;

  const flushMember = (): void => {
    if (currentClass === undefined || pendingOwner === undefined || pendingDescriptorKey === undefined || pendingKind === undefined) return;
    currentClass.names.set(`${pendingKind}\t${pendingDescriptorKey}\t${pendingDescriptor}`, `${pendingOwner}\t${pendingDescriptorKey}`);
  };

  for (const rawLine of content.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line.length === 0) continue;
    const indented = line.startsWith('\t');
    const parts = line.split('\t');
    if (indented) {
      const kind = parts[0];
      if (kind === 'm') {
        flushMember();
        pendingKind = 'm';
        pendingDescriptor = parts[1] ?? '';
        const names = parts.slice(2).filter((value) => value.length > 0);
        if (names.length === 0) {
          pendingOwner = '';
          pendingDescriptorKey = parts[1] ?? '';
        } else {
          const nameList = parts.slice(2);
          pendingOwner = nameList[fromIndex] ?? nameList[0] ?? '';
          pendingDescriptorKey = nameList[toIndex] ?? nameList[nameList.length - 1] ?? '';
        }
        void names;
      } else if (kind === 'f') {
        flushMember();
        pendingKind = 'f';
        pendingDescriptor = parts[1] ?? '';
        const nameList = parts.slice(2);
        pendingOwner = nameList[fromIndex] ?? nameList[0] ?? '';
        pendingDescriptorKey = nameList[toIndex] ?? nameList[nameList.length - 1] ?? '';
      } else if (kind === 'p') {
        const parameterIndex = Number.parseInt(parts[1] ?? '', 10);
        const nameList = parts.slice(2).filter((value) => value.length > 0);
        if (currentClass !== undefined && nameList.length > 0) {
          parameterNames.set(`${currentClass.officialName}\t${parameterIndex}`, nameList[toIndex] ?? nameList[nameList.length - 1] ?? '');
        }
      }
      continue;
    }
    flushMember();
    pendingKind = undefined;
    if (parts[0] === 'c') {
      const nameList = parts.slice(1).filter((value) => value.length > 0);
      const officialName = nameList[fromIndex] ?? nameList[0] ?? '';
      const mappedName = nameList[toIndex] ?? nameList[nameList.length - 1] ?? '';
      const existing = classes.get(officialName);
      if (existing !== undefined) {
        existing.names.set('c\t', mappedName);
      } else {
        currentClass = { officialName, names: new Map([['c\t', mappedName]]) };
        classes.set(officialName, currentClass);
      }
    }
  }
  flushMember();
  return { format: descriptor.format, namespaces, primaryNamespace: descriptor.primaryNamespace, targetNamespace: descriptor.targetNamespace, classes, parameters: parameterNames };
}

export function emptyMappingTree(descriptor: MappingDescriptor): MappingTree {
  return {
    format: descriptor.format,
    namespaces: [descriptor.primaryNamespace, descriptor.targetNamespace],
    primaryNamespace: descriptor.primaryNamespace,
    targetNamespace: descriptor.targetNamespace,
    classes: new Map(),
    parameters: new Map(),
  };
}

export function remapClassName(tree: MappingTree, className: string): string {
  const normalized = className.replace(/\./g, '/');
  const mapped = tree.classes.get(normalized);
  if (mapped === undefined) return className;
  const target = mapped.names.get('c\t');
  return target === undefined ? className : target.replace(/\//g, '.');
}

export function remapMemberName(tree: MappingTree, owner: string, kind: 'm' | 'f', descriptorText: string, name: string): string {
  const ownerMapping = tree.classes.get(owner.replace(/\./g, '/'));
  if (ownerMapping === undefined) return name;
  const direct = ownerMapping.names.get(`${kind}\t${descriptorText}\t${name}`);
  if (direct !== undefined) {
    const parts = direct.split('\t');
    return parts[parts.length - 1] ?? name;
  }
  for (const [key, value] of ownerMapping.names) {
    if (!key.startsWith(`${kind}\t`)) continue;
    const keyParts = key.split('\t');
    const keyName = keyParts[2] ?? '';
    const valueParts = value.split('\t');
    const valueName = valueParts[valueParts.length - 1] ?? '';
    if (keyName === name) return valueName;
  }
  return name;
}

export function mappingPrimaryFile(descriptor: MappingDescriptor, platformOs: string = detectPlatform().os): string {
  const preferred = descriptor.files.find((file) => file.declaredFormat === descriptor.format) ?? descriptor.files[0];
  if (preferred !== undefined) return preferred.path;
  void platformOs;
  throw new Error('Mapping descriptor contains no files');
}