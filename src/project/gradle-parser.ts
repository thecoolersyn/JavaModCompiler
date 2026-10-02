import path from 'node:path';
import type {
  GradleDependencyBlock,
  GradlePluginDescriptor,
  GradleProjectModel,
  GradlePropertyEntry,
  GradleRepositoryDescriptor,
} from './gradle-model.js';
import { containsKotlinOnlySyntax, joinTokens, lex, TokenStream, type Token } from './gradle-lexer.js';
import { parsePropertiesFile } from './properties.js';
import { defaultFileSystem } from '../platform/fs.js';

const GRADLE_FILES = ['build.gradle', 'build.gradle.kts'];
const SETTINGS_FILES = ['settings.gradle', 'settings.gradle.kts'];

export interface ParseGradleProjectInput {
  root: string;
  logger?: { debug(message: string, stage?: string): void };
}

export function parseGradleProject(input: ParseGradleProjectInput): GradleProjectModel {
  const fs = defaultFileSystem;
  const root = input.root;
  const buildFiles: string[] = [];
  const settingsFiles: string[] = [];
  const propertyFiles: string[] = [];
  const properties: Record<string, string> = {};

  for (const name of GRADLE_FILES) {
    if (fs.isFile(path.join(root, name))) buildFiles.push(path.join(root, name));
  }
  for (const name of SETTINGS_FILES) {
    if (fs.isFile(path.join(root, name))) settingsFiles.push(path.join(root, name));
  }
  for (const relative of ['gradle.properties', 'local.properties', 'gradle/libs.versions.toml', 'gradle.properties.local']) {
    const candidate = path.join(root, relative);
    if (fs.isFile(candidate)) {
      propertyFiles.push(candidate);
      if (relative === 'gradle/libs.versions.toml') {
        Object.assign(properties, parseVersionCatalog(fs.readText(candidate)));
      } else {
        Object.assign(properties, parsePropertiesFile(fs.readText(candidate)));
      }
    }
  }

  const plugins: GradlePluginDescriptor[] = [];
  const buildscriptClasspath: string[] = [];
  const repositories: GradleRepositoryDescriptor[] = [];
  const dependencies: GradleDependencyBlock = { dependencies: [], versionCatalogs: {}, platformConstraints: [], fileCollections: [] };
  const tasksOfInterest = new Set<string>();
  const subprojects = new Set<string>();
  let sourceCompatibility: number | undefined;
  let targetCompatibility: number | undefined;
  let javaToolchain: number | undefined;

  const analyzeSource = (filePath: string): void => {
    const source = fs.readText(filePath);
    const tokens = lex(source);
    const stream = new TokenStream(tokens);
    const kotlin = filePath.endsWith('.kts') || containsKotlinOnlySyntax(source);
    while (!stream.done) {
      const loopStart = stream.offset;
      stream.next();
      const token = tokens[loopStart];
      if (token === undefined) break;
      if (token.type !== 'word') continue;

      const word = token.value;
      const cursor = new TokenStream(tokens, loopStart + 1);

      if (word === 'apply' && tokens[loopStart + 1]?.value === 'plugin') {
        let target = loopStart + 2;
        if (tokens[target]?.value === ':') target += 1;
        const literal = tokens[target];
        if (literal?.type === 'string') {
          plugins.push({ id: literal.value, applyDeclaration: 'apply-declaration' });
          for (let step = loopStart; step < target; step += 1) stream.next();
        }
        continue;
      }
      if (word === 'plugins') {
        collectPlugins(cursor.skipBalanced('{', '}'), plugins, kotlin);
        continue;
      }
      if (word === 'buildscript') {
        const body = cursor.skipBalanced('{', '}');
        collectClasspath(body, buildscriptClasspath);
        continue;
      }
      if (word === 'repositories') {
        collectRepositories(cursor.skipBalanced('{', '}'), repositories);
        continue;
      }
      if (word === 'dependencies') {
        collectDependencies(cursor.skipBalanced('{', '}'), dependencies, properties);
        continue;
      }
      if (word === 'settings') {
        cursor.skipBalanced('{', '}');
        continue;
      }
      if (word === 'include') {
        const body = cursor.skipBalanced('(', ')');
        for (const value of stringLiterals(body)) subprojects.add(value);
        continue;
      }
      if (word === 'sourceCompatibility' || word === 'targetCompatibility' || word === 'JavaVersion') {
        const assigned = readAssignedNumber(cursor);
        if (assigned !== undefined) {
          if (word === 'sourceCompatibility') sourceCompatibility = assigned;
          if (word === 'targetCompatibility') targetCompatibility = assigned;
          if (word === 'JavaVersion') javaToolchain = assigned;
        }
        continue;
      }
      if (word === 'toolchain') {
        javaToolchain = readToolchainVersion(cursor.skipBalanced('{', '}')) ?? javaToolchain;
        continue;
      }
      if (word === 'languageVersion') {
        const assigned = readAssignedNumber(cursor);
        if (assigned !== undefined) javaToolchain = assigned;
        continue;
      }
      if (word === 'task' || word === 'tasks' || word === 'tasks.register' || word === 'tasks.registerTask') {
        const nameLiteral = peekStringWithin(cursor, 4);
        if (nameLiteral !== undefined) {
          const relevant = /build|remap|jar|reobf|mixin|compile|shadow|bundle|runClient|runServer|processResources|validate/i;
          if (relevant.test(nameLiteral)) tasksOfInterest.add(nameLiteral);
        }
        continue;
      }
      if (word === 'id' && kotlin) {
        const body = cursor.skipBalanced('(', ')');
        const value = stringLiterals(body)[0];
        if (value !== undefined) plugins.push({ id: value, applyDeclaration: 'kotlin-dsl' });
        continue;
      }
    }

    input.logger?.debug(`Parsed Gradle source ${path.basename(filePath)}: ${plugins.length} plugins, ${repositories.length} repositories`, 'Project');
  };

  for (const file of buildFiles) analyzeSource(file);
  for (const file of settingsFiles) analyzeSource(file);

  const wrapperProperties = path.join(root, 'gradle', 'wrapper', 'gradle-wrapper.properties');
  let wrapperVersion: string | undefined;
  if (fs.isFile(wrapperProperties)) {
    const content = fs.readText(wrapperProperties);
    wrapperVersion = /distributionUrl\s*=\s*\S*gradle-([0-9][^-\s/]*)-(bin|all)\.(?:zip|tar\.gz)/i.exec(content)?.[1];
  }

  const buildDirEntry = fs.readDir(root).find((entry) => entry.isDirectory && (entry.name === 'build' || entry.name === 'out' || entry.name === 'target'));
  const libsEntry = fs.readDir(root).find((entry) => entry.isDirectory && entry.name === 'libs');

  return {
    buildSystem: buildFiles.length > 0 ? 'gradle' : 'unknown',
    buildFiles,
    settingsFiles,
    propertyFiles,
    wrapperVersion,
    plugins: dedupePlugins(plugins),
    buildscriptClasspath: [...new Set(buildscriptClasspath)],
    repositories: dedupeRepositories(repositories),
    dependencies,
    properties,
    sourceCompatibility,
    targetCompatibility,
    javaToolchain,
    subprojects: [...subprojects],
    tasksOfInterest: [...tasksOfInterest],
    isMultiProject: subprojects.size > 0,
    buildDir: buildDirEntry?.name,
    libsDir: libsEntry?.name,
  };
}

const JAVA_VERSION_MEMBERS: Record<string, number> = {
  of: -1,
  VERSION_1_1: 1,
  VERSION_1_5: 5,
  VERSION_1_8: 8,
  VERSION_9: 9,
  VERSION_10: 10,
  VERSION_11: 11,
  VERSION_12: 12,
  VERSION_13: 13,
  VERSION_14: 14,
  VERSION_15: 15,
  VERSION_16: 16,
  VERSION_17: 17,
  VERSION_18: 18,
  VERSION_19: 19,
  VERSION_20: 20,
  VERSION_21: 21,
  VERSION_22: 22,
  VERSION_23: 23,
  VERSION_24: 24,
  VERSION_25: 25,
  LATEST: 25,
};

export function readToolchainVersion(tokens: Token[]): number | undefined {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as Token;
    if (token.type === 'word' && token.value === 'languageVersion') {
      for (let probe = index + 1; probe < Math.min(tokens.length, index + 8); probe += 1) {
        const candidate = tokens[probe] as Token;
        if (candidate.type === 'number') return Number.parseInt(candidate.value, 10);
        if (candidate.type === 'word' && JAVA_VERSION_MEMBERS[candidate.value] !== undefined && JAVA_VERSION_MEMBERS[candidate.value] > 0) {
          return JAVA_VERSION_MEMBERS[candidate.value];
        }
      }
    }
  }
  return undefined;
}

export function readAssignedNumber(stream: TokenStream): number | undefined {
  const equals = stream.peek();
  if (equals !== undefined && equals.type === 'symbol' && equals.value === '=') {
    const direct = stream.peek(1);
    if (direct !== undefined) {
      if (direct.type === 'number') {
        stream.offset = stream.offset + 1;
        return Number.parseInt(direct.value, 10);
      }
      return javaVersionFromExpression(direct.value);
    }
    return undefined;
  }
  return javaVersionFromExpression(stream.peek()?.value);
}

export function javaVersionFromExpression(expression: string | undefined): number | undefined {
  if (expression === undefined) return undefined;
  const trimmed = expression.trim();
  if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  const segments = trimmed.split('.').filter((segment) => segment.length > 0);
  if (segments.length === 1) {
    return JAVA_VERSION_CONSTANTS[segments[0]?.toUpperCase() ?? ''];
  }
  if (segments.length === 2) {
    const owner = segments[0];
    const member = segments[1] as string;
    if (owner === 'of' || owner === 'valueOf' || owner === 'version') return JAVA_VERSION_CONSTANTS[member.toUpperCase()];
    if (owner === 'JavaVersion') return JAVA_VERSION_CONSTANTS[member.toUpperCase()];
    if (owner === 'JavaLanguageVersion') return JAVA_VERSION_CONSTANTS[member.toUpperCase()];
    return undefined;
  }
  if (segments.length === 3) {
    const [, middle, member] = segments;
    if (middle === 'VERSION') return JAVA_VERSION_CONSTANTS[(member as string).toUpperCase()];
  }
  return undefined;
}

const JAVA_VERSION_CONSTANTS: Record<string, number> = {
  VERSION_1_1: 1,
  VERSION_1_2: 2,
  VERSION_1_3: 3,
  VERSION_1_4: 4,
  VERSION_1_5: 5,
  VERSION_1_6: 6,
  VERSION_1_7: 7,
  VERSION_1_8: 8,
  VERSION_9: 9,
  VERSION_10: 10,
  VERSION_11: 11,
  VERSION_12: 12,
  VERSION_13: 13,
  VERSION_14: 14,
  VERSION_15: 15,
  VERSION_16: 16,
  VERSION_17: 17,
  VERSION_18: 18,
  VERSION_19: 19,
  VERSION_20: 20,
  VERSION_21: 21,
  VERSION_22: 22,
  VERSION_23: 23,
  VERSION_24: 24,
  VERSION_25: 25,
  LATEST: 25,
  CURRENT: 21,
  DEFAULT: 17,
};

export function resolveJavaVersionConstant(name: string, fallback: number): number {
  return JAVA_VERSION_CONSTANTS[name.toUpperCase()] ?? fallback;
}

function collectPlugins(tokens: Token[], plugins: GradlePluginDescriptor[], kotlin: boolean): void {
  const declaration = kotlin ? 'plugins-block-kts' : 'plugins-block';
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as Token;
    if (token.type !== 'word') {
      continue;
    }
    if (token.value === 'alias' && tokens[index + 1]?.value === '(') {
      const reference = readDottedName(new TokenStream(tokens, index + 2));
      if (reference !== undefined) plugins.push({ id: '', versionRef: reference, applyDeclaration: 'version-catalog-alias' });
      continue;
    }
    if (token.value === 'apply' && tokens[index + 1]?.value === 'plugin') {
      let cursor = index + 2;
      if (tokens[cursor]?.value === ':') cursor += 1;
      const literal = tokens[cursor];
      if (literal?.type === 'string') {
        plugins.push({ id: literal.value, applyDeclaration: 'apply-declaration' });
        index = cursor;
      }
      continue;
    }
    if (token.value === 'id' || token.value === 'java' || token.value === 'apply') {
      const open = tokens[index + 1];
      if (open === undefined) continue;
      let id: string | undefined;
      let next = index + 2;
      if (open.type === 'string') {
        id = open.value;
        next = index + 2;
      } else if (open.value === '(') {
        const stream = new TokenStream(tokens, index + 1);
        const body = stream.skipBalanced('(', ')');
        id = body.find((entry) => entry.type === 'string')?.value;
        next = stream.offset;
        if (id === undefined) continue;
      } else {
        continue;
      }
      if (token.value === 'apply') {
        plugins.push({ id, applyDeclaration: 'apply-declaration' });
        index = next - 1;
        continue;
      }
      const versionToken = tokens[next]?.value === 'version' ? tokens[next + 1] : undefined;
      plugins.push({ id, ...pluginVersionFields(versionToken), applyDeclaration: declaration });
      index = versionToken === undefined ? next - 1 : next + 1;
      continue;
    }
    if (isVersionLike(token.value) === false) {
      const versionToken = tokens[index + 1]?.value === 'version' ? tokens[index + 2] : undefined;
      plugins.push({ id: token.value, ...pluginVersionFields(versionToken), applyDeclaration: declaration });
      index = versionToken === undefined ? index : index + 2;
    }
  }
}

function pluginVersionFields(versionToken: Token | undefined): { version?: string; versionRef?: string } {
  if (versionToken === undefined) return {};
  if (versionToken.type === 'string' && isVersionLike(versionToken.value)) return { version: versionToken.value };
  if (versionToken.type === 'word' && versionToken.value.length > 0) return { versionRef: versionToken.value };
  if (versionToken.type === 'string' && versionToken.value.length > 0) return { versionRef: versionToken.value };
  return {};
}

function collectClasspath(tokens: Token[], out: string[]): void {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as Token;
    if (token.type === 'string') {
      const parts = token.value.trim().split(':');
      if (parts.length < 2 || parts.some((part) => part.length === 0 || part.includes('/') || part.includes(' '))) continue;
      const normalized = parts.slice(0, 3).join(':');
      if (out.includes(normalized) === false) out.push(normalized);
      continue;
    }
    if (token.type !== 'word' || (token.value !== 'classpath' && token.value !== 'implementation')) continue;
    const open = tokens[index + 1];
    if (open === undefined || open.type !== 'symbol' || open.value !== '(') continue;
    const stream = new TokenStream(tokens, index + 2);
    const body = stream.skipBalanced('(', ')');
    for (const notation of extractNotations(body)) {
      const parts = notation.trim().split(':');
      if (parts.length < 2) continue;
      const normalized = `${parts[0]}:${parts[1]}${parts[2] === undefined ? '' : `:${parts[2]}`}`;
      if (out.includes(normalized) === false) out.push(normalized);
    }
    index += 1;
  }
}

function isVersionLike(value: string): boolean {
  return /^\d+(\.\d+)*([.+-][\w.+-]*)?$/.test(value) || /^(?:latest|SNAPSHOT|dev[.+-]?)/i.test(value);
}

const REPOSITORY_FACTORY_NAMES: Record<string, string> = {
  mavenCentral: 'maven-central',
  mavenLocal: 'maven-local',
  google: 'google',
  jitpack: 'jitpack',
  gradlePluginPortal: 'gradle-plugin-portal',
  maven: 'maven',
  ivy: 'ivy',
  exclusiveContent: 'exclusive-content',
  flatDir: 'flat-dir',
  mavenCentralMirror: 'maven-central-mirror',
};

function collectRepositories(tokens: Token[], repositories: GradleRepositoryDescriptor[]): void {
  const stream = new TokenStream(tokens);
  while (!stream.done) {
    const token = stream.peek();
    if (token === undefined) break;
    if (token.type === 'word') {
      const kind = REPOSITORY_FACTORY_NAMES[token.value];
      if (kind !== undefined) {
        stream.next();
        const body = stream.skipBalanced('(', ')');
        repositories.push(buildRepository(kind, body));
        continue;
      }
    }
    stream.next();
  }
}

function buildRepository(kind: string, body: Token[]): GradleRepositoryDescriptor {
  const descriptor: GradleRepositoryDescriptor = { kind };
  const urlIndex = body.findIndex((token) => token.type === 'word' && token.value === 'url');
  if (urlIndex !== -1) {
    const literal = body.slice(urlIndex + 1).find((token) => token.type === 'string');
    if (literal !== undefined) descriptor.url = literal.value;
  }
  const nameIndex = body.findIndex((token) => token.type === 'word' && token.value === 'name');
  if (nameIndex !== -1) {
    const literal = body.slice(nameIndex + 1).find((token) => token.type === 'string');
    if (literal !== undefined) descriptor.name = literal.value;
  }
  const contentIndex = body.findIndex((token) => token.type === 'word' && token.value === 'content');
  if (contentIndex !== -1) {
    descriptor.contentFilter = joinTokens(body.slice(contentIndex + 1, Math.min(body.length, contentIndex + 40)));
  }
  const metadataIndex = body.findIndex((token) => token.type === 'word' && token.value === 'metadataSources');
  if (metadataIndex !== -1) {
    descriptor.metadataSources = joinTokens(body.slice(metadataIndex + 1, Math.min(body.length, metadataIndex + 40)));
  }
  return descriptor;
}

const CONFIGURATION_NAMES = new Set([
  'implementation',
  'api',
  'compileOnly',
  'runtimeOnly',
  'compileOnlyApi',
  'testImplementation',
  'testRuntimeOnly',
  'annotationProcessor',
  'kapt',
  'kaptTest',
  'developmentOnly',
  'shadowCompile',
]);

const FILE_NOTATION_PATTERN = /files?\s*\(/;

function collectDependencies(tokens: Token[], block: GradleDependencyBlock, properties: Record<string, string>): void {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as Token;
    if (token.type !== 'word') continue;
    const next = tokens[index + 1];
    if (next === undefined) continue;

    if (next.type === 'symbol' && next.value === '(') {
      const stream = new TokenStream(tokens.slice(index + 1));
      const body = stream.skipBalanced('(', ')');
      const consumed = body.length + 2;
      if (token.value === 'platform') {
        for (const notation of extractNotations(body)) {
          const resolved = resolveGradleNotation(notation, properties);
          if (resolved !== undefined) block.platformConstraints.push(resolved);
        }
      } else if (token.value === 'files' || token.value === 'fileTree') {
        const literals = body.filter((entry) => entry.type === 'string').map((entry) => entry.value);
        const jars = literals.filter((literal) => literal.endsWith('.jar') || literal.includes('/'));
        block.fileCollections.push({ notation: `${token.value}(${literals.join(', ')})`, jars });
      } else if (token.value === 'project') {
        block.dependencies.push(`project(${body.map((entry) => entry.value).join('')})`);
      } else {
        for (const notation of extractNotations(body)) {
          block.dependencies.push(resolveGradleNotation(notation, properties));
        }
      }
      index += consumed - 1;
      continue;
    }

    if (next.type === 'word' && (next.value === 'libs.' || next.value === 'project(' || next.value.startsWith('libs.'))) {
      const aliasStream = new TokenStream(tokens, index + 1);
      const notation = readDottedName(aliasStream);
      const resolved = notation ?? next.value;
      if (resolved.startsWith('libs.') || resolved.startsWith('project(')) {
        block.dependencies.push(resolveGradleNotation(resolved, properties));
        if (notation !== undefined) index = aliasStream.offset - 1;
        else index += 1;
        continue;
      }
    }

    if (next.type === 'string') {
      const after = tokens[index + 2];
      if (after !== undefined && after.type === 'symbol' && after.value === '{') {
        const stream = new TokenStream(tokens.slice(index + 2));
        const body = stream.skipBalanced('{', '}');
        for (const notation of extractNotations(body)) {
          block.dependencies.push(resolveGradleNotation(notation, properties));
        }
        index += 2 + body.length;
        continue;
      }
      for (const notation of extractNotations(tokens.slice(index + 1, index + 2))) {
        block.dependencies.push(resolveGradleNotation(notation, properties));
      }
      index += 1;
      continue;
    }
  }
}

function splitCoordinateParts(value: string): string[] {
  const parts: string[] = [];
  let current = '';
  let interpolationDepth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index] as string;
    if (char === '$' && value[index + 1] === '{') {
      interpolationDepth += 1;
      current += '${';
      index += 1;
      continue;
    }
    if (char === '}' && interpolationDepth > 0) {
      interpolationDepth -= 1;
      current += char;
      continue;
    }
    if (char === ':' && interpolationDepth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

export function interpolateGradleString(value: string, properties: Record<string, string>): string {
  return value.replace(/\$\{([^}]+)\}/g, (full, key: string) => {
    const trimmed = key.trim();
    const direct = properties[trimmed];
    if (direct !== undefined) return direct;
    const projectMatch = /^project\.(.+)$/.exec(trimmed);
    if (projectMatch !== null) {
      const nested = properties[projectMatch[1] as string];
      return nested ?? full;
    }
    return full;
  });
}

export function resolveGradleNotation(value: string, properties: Record<string, string>): string {
  const interpolated = interpolateGradleString(value.trim(), properties);
  if (interpolated.includes('(')) return interpolated;
  const parts = splitCoordinateParts(interpolated);
  if (parts.length === 1) return interpolated;
  const group = parts[0] as string;
  const artifact = parts[1] as string;
  const version = parts.length > 2 ? (parts[2] as string) : undefined;
  if (group.length === 0 || artifact.length === 0) return interpolated;
  return `${group}:${artifact}:${version ?? '+'}`;
}

function extractNotations(tokens: Token[]): string[] {
  const notations: string[] = [];
  const stream = new TokenStream(tokens);
  while (!stream.done) {
    const token = stream.peek();
    if (token === undefined) break;

    if (token.type === 'word' && (token.value === 'files' || token.value === 'fileTree')) {
      const body = stream.skipBalanced('(', ')');
      const literals = body.filter((entry) => entry.type === 'string').map((entry) => entry.value);
      notations.push(`${token.value}(${literals.join(', ')})`);
      continue;
    }
    if (token.type === 'word' && token.value === 'project') {
      const body = stream.skipBalanced('(', ')');
      notations.push(`project(${body.map((entry) => entry.value).join('')})`);
      continue;
    }
    if (token.type === 'string') {
      const start = indexOfToken(tokens, token);
      const group = nextString(tokens, start + 1);
      const name = nextString(tokens, group.index + 1);
      const version = nextString(tokens, name.index + 1);
      if (group.value !== undefined && name.value !== undefined) {
        notations.push(`${group.value}:${name.value}:${version.value ?? '+'}`);
        continue;
      }
      notations.push(token.value);
      stream.next();
      continue;
    }
    stream.next();
  }
  return notations;
}

function readDottedName(stream: TokenStream): string | undefined {
  const head = stream.peek();
  if (head === undefined || head.type !== 'word' || !head.value.startsWith('libs')) return undefined;
  if (head.value.length > 4) {
    stream.offset = stream.offset + 1;
    return head.value;
  }
  const parts: string[] = ['libs'];
  let offset = 1;
  for (;;) {
    const dot = stream.peek(offset);
    const name = stream.peek(offset + 1);
    if (dot === undefined || name === undefined) break;
    if (dot.type !== 'symbol' && dot.value !== '.') break;
    if (name.type !== 'word' && name.type !== 'string') break;
    parts.push(name.value);
    offset += 2;
  }
  if (offset === 1) return undefined;
  stream.offset = stream.offset + offset;
  return parts.join('.');
}

function indexOfToken(tokens: Token[], token: Token): number {
  return tokens.findIndex((entry) => entry.start === token.start);
}

function nextString(tokens: Token[], from: number): { value?: string; index: number } {
  let index = from;
  while (index < tokens.length) {
    const token = tokens[index] as Token;
    if (token.type === 'string') return { value: token.value, index };
    if (token.type === 'symbol' && (token.value === ')' || token.value === '}')) break;
    index += 1;
  }
  return { index };
}

function peekStringWithin(stream: TokenStream, window: number): string | undefined {
  for (let offset = 0; offset < window; offset += 1) {
    const token = stream.peek(offset);
    if (token === undefined) return undefined;
    if (token.type === 'string') return token.value;
  }
  return undefined;
}

function stringLiterals(tokens: Token[]): string[] {
  return tokens.filter((token) => token.type === 'string').map((token) => token.value);
}

function dedupePlugins(plugins: GradlePluginDescriptor[]): GradlePluginDescriptor[] {
  const seen = new Map<string, GradlePluginDescriptor>();
  for (const plugin of plugins) {
    const key = plugin.id.length > 0 ? plugin.id : `alias:${plugin.versionRef ?? ''}`;
    const existing = seen.get(key);
    if (existing === undefined) {
      seen.set(key, plugin);
      continue;
    }
    if (existing.version === undefined && plugin.version !== undefined) existing.version = plugin.version;
    if (existing.versionRef === undefined && plugin.versionRef !== undefined) existing.versionRef = plugin.versionRef;
  }
  return [...seen.values()];
}

function dedupeRepositories(repositories: GradleRepositoryDescriptor[]): GradleRepositoryDescriptor[] {
  const seen = new Map<string, GradleRepositoryDescriptor>();
  for (const repository of repositories) {
    const key = `${repository.kind}|${repository.url ?? ''}`;
    if (!seen.has(key)) seen.set(key, repository);
  }
  return [...seen.values()];
}

function readTomlTable(content: string, table: string): string {
  const pattern = new RegExp(`\\[${table}\\]([\\s\\S]*?)(?=\\n\\[|$)`);
  return pattern.exec(content)?.[1] ?? '';
}

function stripTomlComment(line: string): string {
  const trimmed = line.trim();
  if (trimmed.startsWith('#')) return '';
  const hash = line.indexOf('#');
  return hash === -1 ? line : line.slice(0, hash);
}

function parseTomlScalars(content: string): Map<string, string> {
  const values = new Map();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine);
    const match = /^\s*([\w.$-]+)\s*=\s*"([^"]*)"\s*$/.exec(line);
    if (match === null) continue;
    values.set(match[1] as string, match[2] as string);
  }
  return values;
}

function parseTomlInlineTables(content: string): Map<string, Map<string, string>> {
  const tables = new Map();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine);
    const match = /^\s*([\w.$-]+)\s*=\s*\{([\s\S]*?)\}\s*$/.exec(line);
    if (match === null) continue;
    const fields = new Map();
    for (const part of (match[2] ?? '').split(',')) {
      const field = /^\s*([\w.$-]+)\s*=\s*(?:"([^"]*)"|([^\s,]+))\s*$/.exec(part);
      if (field === null) continue;
      const key = field[1] as string;
      fields.set(key, field[2] !== undefined ? field[2] : (field[3] ?? ''));
    }
    tables.set(match[1] as string, fields);
  }
  return tables;
}

export function parseVersionCatalog(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const versions = parseTomlScalars(readTomlTable(content, 'versions'));
  const libraries = parseTomlInlineTables(readTomlTable(content, 'libraries'));
  const plugins = parseTomlInlineTables(readTomlTable(content, 'plugins'));

  const resolveRef = (value: string | undefined): string | undefined => {
    if (value === undefined) return undefined;
    const direct = versions.get(value);
    if (direct !== undefined) return direct;
    const refMatch = /^version\.ref$/.test(value) ? undefined : value;
    void refMatch;
    return versions.get(value);
  };

  for (const [alias, fields] of libraries) {
    const module = fields.get('module');
    if (module === undefined) continue;
    const versionRef = fields.get('version.ref');
    const inlineVersion = fields.get('version');
    const version = inlineVersion ?? (versionRef === undefined ? undefined : resolveRef(versionRef));
    result[`libs.${alias}`] = version === undefined ? module : `${module}:${version}`;
  }

  for (const [alias, value] of versions) result[`version.${alias}`] = value;

  for (const [alias, fields] of plugins) {
    const id = fields.get('id');
    if (id === undefined) continue;
    const versionRef = fields.get('version.ref');
    const inlineVersion = fields.get('version');
    const version = inlineVersion ?? (versionRef === undefined ? undefined : resolveRef(versionRef));
    result[`plugin.${alias}`] = version === undefined ? id : `${id}:${version}`;
  }

  void plugins;
  return result;
}

export function gradlePropertyEntries(content: string): GradlePropertyEntry[] {
  return Object.entries(parsePropertiesFile(content)).map(([key, value]) => ({ key, value }));
}