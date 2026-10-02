import path from 'node:path';
import { defaultFileSystem } from '../platform/fs.js';
import { detectLoaderFromSignals, loaderFromCoordinate, type LoaderDetectionResult } from '../loader/detection.js';
import { parseGradleProject } from './gradle-parser.js';
import { parseMavenModel } from './maven-parser.js';
import { lookupProperty } from './properties.js';
import type { GradleProjectModel, MavenModel } from './gradle-model.js';
import { VersionEvidence, javaBaselineForVersion, parseMinecraftVersion, pickVersionFromEvidence } from '../minecraft/version.js';

export type BuildEcosystem = 'gradle' | 'maven' | 'plain-javac' | 'unknown';
export type LanguageSet = 'java' | 'kotlin' | 'java+kotlin' | 'scala' | 'groovy' | 'mixed' | 'unknown';

export interface SourceSetInfo {
  name: string;
  root: string;
  fileCount: number;
  languages: LanguageSet;
}

export type ModMetadataKind =
  | 'fabric.mod.json'
  | 'META-INF/mods.toml'
  | 'META-INF/neoforge.mods.toml'
  | 'quilt.mod.json'
  | 'quilted_fabric.json'
  | 'mcmod.info'
  | 'pack.mcmeta'
  | 'architectury.common.json';

export interface ModMetadataInfo {
  kind: ModMetadataKind;
  path: string;
  declared?: Record<string, unknown>;
  modId?: string;
  version?: string;
  minecraftVersionRange?: string;
  loaderVersionRange?: string;
  environment?: string;
  mixinConfigs?: string[];
}

export interface AnnotationProcessorInfo {
  classNames: string[];
  declaredInBuild: string[];
  declaredInServices: string[];
}

export interface ProjectDetection {
  root: string;
  name: string;
  buildSystem: BuildEcosystem;
  buildTool: string;
  languages: LanguageSet;
  gradle?: GradleProjectModel;
  maven?: MavenModel;
  sourceSets: SourceSetInfo[];
  localJars: string[];
  resourceDirectories: string[];
  modMetadata: ModMetadataInfo[];
  mixinConfigs: string[];
  annotationProcessors: AnnotationProcessorInfo;
  minecraftVersion?: string;
  minecraftVersionEvidence: VersionEvidence[];
  minecraftVersionSource?: string;
  loader: LoaderDetectionResult;
  gradleWrapperVersion?: string;
  javaTarget?: number;
  javaBaseline?: number;
  hasWrapper: boolean;
  isMultiModule: boolean;
  detectedIssues: string[];
  scanFileCount: number;
}

const MIXIN_CONFIG_PATTERN = /^.*mixin(s)?\..*\.json$/i;

export function detectProject(root: string, options: { logger?: { debug(message: string, stage?: string): void } } = {}): ProjectDetection {
  const fs = defaultFileSystem;
  const absoluteRoot = path.resolve(root);
  const hasGradleBuild = fs.isFile(path.join(absoluteRoot, 'build.gradle')) || fs.isFile(path.join(absoluteRoot, 'build.gradle.kts'));
  const hasGradleSettings = fs.isFile(path.join(absoluteRoot, 'settings.gradle')) || fs.isFile(path.join(absoluteRoot, 'settings.gradle.kts'));
  const hasMaven = fs.isFile(path.join(absoluteRoot, 'pom.xml'));
  const gradle = hasGradleBuild || hasGradleSettings ? parseGradleProject({ root: absoluteRoot, logger: options.logger }) : undefined;
  const maven = hasMaven ? parseMavenModel(path.join(absoluteRoot, 'pom.xml')) : undefined;

  const scan = fs.walk(absoluteRoot, { maxDepth: 12 });
  const filePaths = scan.filter((entry) => entry.isFile).map((entry) => entry.path);
  const relativePaths = scan.filter((entry) => entry.isFile).map((entry) => path.relative(absoluteRoot, entry.path).split(path.sep).join('/'));

  const sourceSets = detectSourceSets(absoluteRoot, relativePaths);
  const languages = mergeLanguages(sourceSets);
  const localJars = relativePaths.filter((relative) => relative.toLowerCase().endsWith('.jar') && !relative.includes('/build/') && !relative.includes('/target/'));
  const resourceDirectories = fs
    .readDir(absoluteRoot)
    .filter((entry) => entry.isDirectory && entry.name === 'resources')
    .map((entry) => path.relative(absoluteRoot, entry.path).split(path.sep).join('/'));
  const modMetadata = detectModMetadata(absoluteRoot, relativePaths);
  const mixinConfigs = relativePaths.filter((relative) => MIXIN_CONFIG_PATTERN.test(relative) && relative.toLowerCase().endsWith('.json'));
  const annotationProcessors = detectAnnotationProcessors(absoluteRoot, relativePaths, gradle);

  const versionEvidence = collectVersionEvidence(gradle, maven, modMetadata, relativePaths, absoluteRoot);
  const picked = pickVersionFromEvidence(versionEvidence);
  const loader = detectLoader(signalsFrom(absoluteRoot, gradle, maven, modMetadata, relativePaths, versionEvidence));

  const hasWrapper =
    fs.isFile(path.join(absoluteRoot, 'gradlew')) ||
    fs.isFile(path.join(absoluteRoot, 'gradlew.bat')) ||
    fs.isFile(path.join(absoluteRoot, 'mvnw')) ||
    fs.isFile(path.join(absoluteRoot, 'mvnw.cmd'));

  const javaTarget =
    gradle?.javaToolchain ??
    gradle?.targetCompatibility ??
    gradle?.sourceCompatibility ??
    parseIntOrUndefined(maven?.mavenCompilerTarget ?? maven?.mavenCompilerSource);
  const javaBaseline = picked !== undefined ? javaBaselineForVersion(picked.version) : undefined;

  const issues: string[] = [];
  if (!hasGradleBuild && !hasMaven) {
    issues.push('No build.gradle, build.gradle.kts or pom.xml was found in the project root');
  }
  if (sourceSets.length === 0) {
    issues.push('No source directories were found under src/ or the project root');
  }
  if (picked === undefined) {
    issues.push('Minecraft version could not be determined from project metadata');
  }

  const buildEcosystem: BuildEcosystem = gradle !== undefined ? 'gradle' : maven !== undefined ? 'maven' : sourceSets.length > 0 ? 'plain-javac' : 'unknown';

  return {
    root: absoluteRoot,
    name: path.basename(absoluteRoot),
    buildSystem: buildEcosystem,
    buildTool: gradle !== undefined ? 'Gradle' : maven !== undefined ? 'Maven' : buildEcosystem === 'plain-javac' ? 'javac' : 'unknown',
    languages,
    gradle,
    maven,
    sourceSets,
    localJars,
    resourceDirectories,
    modMetadata,
    mixinConfigs,
    annotationProcessors,
    minecraftVersion: picked?.version,
    minecraftVersionEvidence: versionEvidence,
    minecraftVersionSource: picked?.source,
    loader,
    gradleWrapperVersion: gradle?.wrapperVersion,
    javaTarget,
    javaBaseline,
    hasWrapper,
    isMultiModule: gradle?.isMultiProject === true,
    detectedIssues: issues,
    scanFileCount: filePaths.length,
  };
}

function parseIntOrUndefined(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

const SOURCE_LANGUAGE_DIRECTORIES = new Set(['java', 'kotlin', 'scala', 'groovy']);

const SOURCE_FILE_EXTENSIONS: Record<string, LanguageSet> = {
  '.java': 'java',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.scala': 'scala',
  '.groovy': 'groovy',
};

function sourceRootOf(directory: string): { name: string; root: string } | undefined {
  const segments = directory.split('/').filter((segment) => segment.length > 0);
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index] as string;
    if (!SOURCE_LANGUAGE_DIRECTORIES.has(segment)) continue;
    if (index > 0 && segments[0] !== 'src') continue;
    const preceding = index > 0 ? segments.slice(0, index) : [];
    if (preceding.some((entry) => SOURCE_LANGUAGE_DIRECTORIES.has(entry))) continue;
    const name = [...preceding, segment].join('-');
    return { name, root: segments.slice(0, index + 1).join('/') };
  }
  return undefined;
}

function detectSourceSets(root: string, relativePaths: string[]): SourceSetInfo[] {
  const groups = new Map<string, SourceSetInfo>();
  for (const relative of relativePaths) {
    const extension = path.extname(relative).toLowerCase();
    const language = SOURCE_FILE_EXTENSIONS[extension];
    if (language === undefined) continue;
    const directory = relative.slice(0, relative.length - path.basename(relative).length).replace(/\/$/, '');
    const rule = sourceRootOf(directory);
    if (rule === undefined) continue;
    const key = `${rule.root}|${rule.name}`;
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, {
        name: rule.name,
        root: path.join(root, rule.root.split('/').join(path.sep)),
        fileCount: 1,
        languages: language,
      });
    } else {
      existing.fileCount += 1;
      existing.languages = mergeLanguagePair(existing.languages, language);
    }
  }
  void root;
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function languageOf(extension: string): LanguageSet {
  switch (extension) {
    case '.java':
      return 'java';
    case '.kt':
    case '.kts':
      return 'kotlin';
    case '.scala':
      return 'scala';
    case '.groovy':
      return 'groovy';
    default:
      return 'unknown';
  }
}

function mergeLanguagePair(left: LanguageSet, right: LanguageSet): LanguageSet {
  if (left === right) return left;
  const set = new Set<string>([left, right]);
  set.delete('unknown');
  if (set.size === 1) return [...set][0] as LanguageSet;
  if (set.has('java') && set.has('kotlin')) return 'java+kotlin';
  return 'mixed';
}

function mergeLanguages(sourceSets: SourceSetInfo[]): LanguageSet {
  let accumulated: LanguageSet = 'unknown';
  for (const set of sourceSets) accumulated = mergeLanguagePair(accumulated, set.languages);
  return accumulated;
}

const METADATA_FILES: Array<ModMetadataInfo['kind'] | 'quilted_fabric.json'> = [
  'fabric.mod.json',
  'META-INF/mods.toml',
  'META-INF/neoforge.mods.toml',
  'quilt.mod.json',
  'mcmod.info',
  'pack.mcmeta',
  'architectury.common.json',
];

function detectModMetadata(root: string, relativePaths: string[]): ModMetadataInfo[] {
  const results: ModMetadataInfo[] = [];
  for (const kind of METADATA_FILES) {
    const direct = path.join(root, kind.split('/').join(path.sep));
    if (defaultFileSystem.isFile(direct)) {
      results.push(parseModMetadata(kind, direct, root));
      continue;
    }
    for (const relative of relativePaths) {
      const normalized = relative.toLowerCase();
      const target = kind.toLowerCase();
      if (normalized.endsWith(`/${target}`)) {
        results.push(parseModMetadata(kind, path.join(root, relative.split('/').join(path.sep)), root));
        break;
      }
    }
  }
  return results;
}

function parseModMetadata(kind: ModMetadataInfo['kind'], filePath: string, root: string): ModMetadataInfo {
  const info: ModMetadataInfo = { kind, path: path.relative(root, filePath).split(path.sep).join('/') };
  const fs = defaultFileSystem;
  try {
    if (filePath.toLowerCase().endsWith('.json')) {
      const parsed = JSON.parse(fs.readText(filePath)) as Record<string, unknown>;
      info.declared = parsed;
      if (typeof parsed.id === 'string') info.modId = parsed.id;
      if (typeof parsed.version === 'string') info.version = parsed.version;
      if (typeof parsed.environment === 'string') info.environment = parsed.environment;
      if (Array.isArray(parsed.mixin)) {
        info.mixinConfigs = parsed.mixin
          .map((entry) => (typeof entry === 'string' ? entry : ((entry as { config?: string }).config ?? '')))
          .filter((entry) => entry.length > 0);
      }
      const dependsRaw = parsed.depends ?? parsed.breaks;
      if (dependsRaw !== undefined) info.minecraftVersionRange = collectVersionRanges(dependsRaw);
      const loaderRaw = (parsed as { entrypoints?: unknown }).entrypoints;
      void loaderRaw;
    } else if (filePath.toLowerCase().endsWith('.toml')) {
      const content = fs.readText(filePath);
      info.modId = /^\s*modId\s*=\s*"([^"]+)"/m.exec(content)?.[1];
      info.version = /^\s*version\s*=\s*"([^"]+)"/m.exec(content)?.[1];
      info.environment = /^\s*displayTest\s*=\s*"([^"]+)"/m.exec(content)?.[1];
      info.minecraftVersionRange = /^\s*minecraftVersion\s*=\s*"([^"]+)"/m.exec(content)?.[1];
      info.loaderVersionRange = /^\s*loaderVersion\s*=\s*"([^"]+)"/m.exec(content)?.[1];
      info.mixinConfigs = [...content.matchAll(/^\s*config\s*=\s*"([^"]+\.json)"/gm)].map((match) => match[1] as string);
    } else {
      info.declared = { raw: fs.readText(filePath) };
    }
  } catch (error) {
    info.declared = { parseError: error instanceof Error ? error.message : String(error) };
  }
  return info;
}

function collectVersionRanges(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value !== null && typeof value === 'object') {
    const ranges = Object.values(value as Record<string, unknown>);
    const strings = ranges.filter((entry): entry is string => typeof entry === 'string');
    if (strings.length > 0) return strings.join(', ');
  }
  return undefined;
}

const PROCESSOR_SERVICE_PATH = 'META-INF/services/javax.annotation.processing.Processor';

function detectAnnotationProcessors(root: string, relativePaths: string[], gradle: GradleProjectModel | undefined): AnnotationProcessorInfo {
  const declaredInBuild: string[] = [];
  for (const dependency of gradle?.dependencies.dependencies ?? []) {
    if (/annotationprocessor|auto-value|lombok|kotlin-.*-annotation/i.test(dependency) && !declaredInBuild.includes(dependency)) {
      declaredInBuild.push(dependency);
    }
  }
  const serviceFiles = relativePaths.filter((relative) => relative.toLowerCase().endsWith('javax.annotation.processing.processor'));
  const declaredInServices: string[] = [];
  for (const relative of serviceFiles) {
    const absolute = path.join(root, relative.split('/').join(path.sep));
    for (const line of defaultFileSystem.readText(absolute).split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length > 0 && !trimmed.startsWith('#') && !declaredInServices.includes(trimmed)) declaredInServices.push(trimmed);
    }
  }
  const classNames: string[] = [];
  for (const relative of relativePaths) {
    if (!/\/(annotation|processor|processors)\//i.test(relative)) continue;
    const className = relative.replace(/\.java$/, '').replace(/^\/+/, '').split('/').join('.');
    if (className.length > 0 && !classNames.includes(className)) classNames.push(className);
  }
  void PROCESSOR_SERVICE_PATH;
  return { classNames, declaredInBuild, declaredInServices };
}

const VERSION_PROPERTY_KEYS = [
  'minecraft.version',
  'minecraft_version',
  'minecraftVersion',
  'minecraft.version.moddev',
  'minecraft.version.gradle',
  'mcversion',
  'version_minecraft',
  'minecraft',
  'version',
  'loom.platform',
  'loom.mappings',
];

function collectVersionEvidence(
  gradle: GradleProjectModel | undefined,
  maven: MavenModel | undefined,
  modMetadata: ModMetadataInfo[],
  relativePaths: string[],
  root: string,
): VersionEvidence[] {
  const evidence: VersionEvidence[] = [];
  const properties = gradle?.properties ?? {};
  for (const key of VERSION_PROPERTY_KEYS) {
    const value = lookupProperty(properties, key);
    if (value === undefined) continue;
    const identity = parseMinecraftVersion(value);
    if (identity.major === undefined) continue;
    evidence.push({ version: identity.normalized, source: `gradle.properties ${key}`, weight: key === 'version' || key === 'minecraft' ? 45 : 80 });
  }
  for (const plugin of gradle?.plugins ?? []) {
    const version = plugin.version;
    if (version === undefined) continue;
    const identity = parseMinecraftVersion(version);
    if (identity.major === undefined) continue;
    if (/loom|forge|neoforge|quilt/i.test(plugin.id)) {
      evidence.push({ version: identity.normalized, source: `plugin ${plugin.id}:${version}`, weight: 55 });
    }
  }
  for (const dependency of gradle?.dependencies.dependencies ?? []) {
    const coordinate = parseCoordinate(dependency);
    if (coordinate === undefined) continue;
    if (/minecraft|forge|neoforge|fabric|loom|quilt/i.test(coordinate.groupId)) {
      evidence.push({ version: coordinate.version, source: `dependency ${dependency}`, weight: 60 });
    }
  }
  const mavenVersion = maven?.properties['minecraft.version'] ?? maven?.properties.minecraftVersion;
  if (mavenVersion !== undefined) {
    evidence.push({ version: parseMinecraftVersion(mavenVersion).normalized, source: 'pom.xml properties', weight: 70 });
  }
  for (const metadata of modMetadata) {
    const range = metadata.minecraftVersionRange;
    if (range === undefined) continue;
    const candidate = extractVersionFromRange(range);
    if (candidate !== undefined) evidence.push({ version: candidate, source: `${metadata.kind} depends range`, weight: 50 });
  }
  for (const relative of relativePaths) {
    if (!relative.toLowerCase().endsWith('version_manifest.json') && !relative.toLowerCase().endsWith('.version.json')) continue;
    try {
      const parsed = JSON.parse(defaultFileSystem.readText(path.join(root, relative.split('/').join(path.sep)))) as { id?: number; release?: { id?: string } };
      const version = parsed.release?.id ?? (parsed.id !== undefined ? String(parsed.id) : undefined);
      if (version !== undefined) evidence.push({ version, source: relative, weight: 65 });
    } catch {
      continue;
    }
  }
  return dedupeEvidence(evidence);
}

function dedupeEvidence(evidence: VersionEvidence[]): VersionEvidence[] {
  const best = new Map<string, VersionEvidence>();
  for (const item of evidence) {
    const existing = best.get(item.version);
    if (existing === undefined || existing.weight < item.weight) best.set(item.version, item);
  }
  return [...best.values()].sort((a, b) => b.weight - a.weight);
}

export function extractVersionFromRange(range: string): string | undefined {
  const stripped = range.replace(/[<>=~!\[\]\s]/g, ' ').split(/\s+/).filter((part) => part.length > 0 && /\d/.test(part));
  const concrete = stripped.filter((part) => /^v?\d+(\.\d+)*$/.test(part) && !part.startsWith('1.0'));
  if (concrete.length > 0) return concrete[concrete.length - 1]?.replace(/^v/, '');
  return undefined;
}

function signalsFrom(
  root: string,
  gradle: GradleProjectModel | undefined,
  maven: MavenModel | undefined,
  modMetadata: ModMetadataInfo[],
  relativePaths: string[],
  versionEvidence: VersionEvidence[],
): Array<{ text: string; origin: string }> {
  const fs = defaultFileSystem;
  const signals: Array<{ text: string; origin: string }> = [];
  const readIfPresent = (relative: string): void => {
    const absolute = path.join(root, relative.split('/').join(path.sep));
    if (fs.isFile(absolute)) signals.push({ text: fs.readText(absolute), origin: relative });
  };
  for (const file of gradle?.buildFiles ?? []) signals.push({ text: fs.readText(file), origin: path.relative(root, file) });
  for (const file of gradle?.settingsFiles ?? []) signals.push({ text: fs.readText(file), origin: path.relative(root, file) });
  readIfPresent('gradle/libs.versions.toml');
  readIfPresent('gradle.properties');
  readIfPresent('build.gradle');
  readIfPresent('build.gradle.kts');
  readIfPresent('settings.gradle');
  readIfPresent('settings.gradle.kts');
  readIfPresent('pom.xml');
  readIfPresent('quilt.mod.json');
  for (const metadata of modMetadata) {
    readIfPresent(metadata.path);
    signals.push({ text: `${metadata.kind} ${metadata.path}`, origin: metadata.path });
  }
  for (const relative of relativePaths) {
    if (/mixin.*\.json$/i.test(relative) || relative.toLowerCase().endsWith('.cfg')) {
      signals.push({ text: relative, origin: relative });
    }
  }
  for (const evidence of versionEvidence) signals.push({ text: evidence.source, origin: evidence.source });
  void maven;
  return signals;
}

function detectLoader(signals: Array<{ text: string; origin: string }>): LoaderDetectionResult {
  const base = detectLoaderFromSignals(signals);
  for (const signal of signals) {
    const kind = loaderFromCoordinate(signal.text.trim());
    if (kind !== undefined && base.kind !== kind) {
      return {
        kind,
        confidence: Math.max(base.confidence, 55),
        evidence: [...base.evidence, { kind, signal: 'loader coordinate', weight: 55, detail: signal.origin }],
      };
    }
  }
  return base;
}

export interface Coordinate {
  groupId: string;
  artifactId: string;
  version: string;
}

export function parseCoordinate(notation: string): Coordinate | undefined {
  const cleaned = notation.trim().replace(/\s/g, '');
  const parts = cleaned.split(':');
  if (parts.length < 2) return undefined;
  const groupId = parts[0] as string;
  const artifactId = parts[1] as string;
  const version = parts.length >= 3 ? (parts[2] as string) : '';
  if (groupId.length === 0 || artifactId.length === 0) return undefined;
  return { groupId, artifactId, version };
}