import crypto from 'node:crypto';
import path from 'node:path';
import { defaultFileSystem } from '../platform/fs.js';
import type { JmcPaths } from '../platform/paths.js';

export interface ApprovalRecord {
  projectRoot: string;
  projectKey: string;
  buildSystem: string;
  buildScripts: string[];
  approvedAt: number;
  approvedBy: 'interactive' | 'flag' | 'environment' | 'ci-trusted';
  scriptDigest: string;
}

export interface ApprovalDecisionBase {
  scriptDigest: string;
  buildScripts: string[];
  warnings: string[];
}

export type ApprovalDecision =
  | (ApprovalDecisionBase & { allowed: true; source: ApprovalRecord['approvedBy']; record: ApprovalRecord; persisted: boolean })
  | (ApprovalDecisionBase & { allowed: false; reason: string });

export interface ApprovalServiceOptions {
  paths: JmcPaths;
  assumeYes: boolean;
  isCi: boolean;
  trustEnvironmentVariable: string | undefined;
  interactive: boolean;
  input: (question: string) => Promise<string | undefined>;
  output?: (line: string) => void;
}

export function projectKeyFor(projectRoot: string): string {
  return crypto.createHash('sha256').update(path.resolve(projectRoot)).digest('hex').slice(0, 16);
}

export function normalizeScriptPath(value: string): string {
  return value.split(path.sep).join('/').replace(/^\.\//, '').replace(/^\/+/, '');
}

export function digestOfScripts(scripts: ScriptDescriptor[]): string {
  const hash = crypto.createHash('sha256');
  const sorted = [...scripts].sort((left, right) => normalizeScriptPath(left.path).localeCompare(normalizeScriptPath(right.path)));
  for (const script of sorted) {
    hash.update(normalizeScriptPath(script.path));
    hash.update('\0');
    hash.update(script.digest);
    hash.update('\0');
  }
  return hash.digest('hex');
}

export interface ScriptDescriptor {
  path: string;
  digest: string;
}

const MAX_LISTED_SCRIPTS = 20;

export function describeScripts(scripts: string[], limit = MAX_LISTED_SCRIPTS): string[] {
  const sorted = [...scripts].map(normalizeScriptPath).sort();
  const lines: string[] = [];
  for (const script of sorted.slice(0, limit)) lines.push(`  ${script}`);
  const remaining = sorted.length - lines.length;
  if (remaining > 0) lines.push(`  and ${remaining} more`);
  return lines;
}

export class ApprovalService {
  private readonly options: ApprovalServiceOptions;
  private readonly fs = defaultFileSystem;
  private readonly storePath: string;

  constructor(options: ApprovalServiceOptions) {
    this.options = options;
    this.storePath = path.join(options.paths.approvals, 'project-approvals.json');
  }

  storeFilePath(): string {
    return this.storePath;
  }

  list(): ApprovalRecord[] {
    if (!this.fs.isFile(this.storePath)) return [];
    try {
      const parsed = JSON.parse(this.fs.readText(this.storePath)) as { records?: ApprovalRecord[] };
      return parsed.records ?? [];
    } catch {
      return [];
    }
  }

  private save(records: ApprovalRecord[]): void {
    this.fs.writeText(this.storePath, JSON.stringify({ version: 1, records }, null, 2));
  }

  find(projectRoot: string): ApprovalRecord | undefined {
    const key = projectKeyFor(projectRoot);
    return this.list().find((record) => record.projectKey === key);
  }

  revoke(projectRoot: string): boolean {
    const key = projectKeyFor(projectRoot);
    const records = this.list();
    const remaining = records.filter((record) => record.projectKey !== key);
    if (remaining.length === records.length) return false;
    this.save(remaining);
    return true;
  }

  private emit(line: string): void {
    this.options.output?.(line);
  }

  async requireAuthorization(input: {
    projectRoot: string;
    buildSystem: string;
    scripts: ScriptDescriptor[];
    warningText: string[];
  }): Promise<ApprovalDecision> {
    const scriptPaths = input.scripts.map((script) => normalizeScriptPath(script.path)).sort();
    const scriptDigest = digestOfScripts(input.scripts);
    const warnings = this.buildWarnings(input.warningText, scriptPaths);
    const existing = this.find(input.projectRoot);
    if (existing !== undefined && existing.scriptDigest === scriptDigest && existing.buildSystem === input.buildSystem) {
      return { allowed: true, source: existing.approvedBy, record: existing, persisted: true, scriptDigest, buildScripts: scriptPaths, warnings };
    }
    if (existing !== undefined && existing.scriptDigest !== scriptDigest) {
      this.revoke(input.projectRoot);
    }

    const draft = (approvedBy: ApprovalRecord['approvedBy']): ApprovalRecord => ({
      projectRoot: path.resolve(input.projectRoot),
      projectKey: projectKeyFor(input.projectRoot),
      buildSystem: input.buildSystem,
      buildScripts: scriptPaths,
      approvedAt: Date.now(),
      approvedBy,
      scriptDigest,
    });

    const envTrust = this.options.trustEnvironmentVariable;
    if (envTrust !== undefined && (envTrust === '1' || envTrust.toLowerCase() === 'true')) {
      const record = draft('environment');
      for (const line of warnings) this.emit(line);
      return { allowed: true, source: 'environment', record, persisted: false, scriptDigest, buildScripts: scriptPaths, warnings };
    }

    if (this.options.assumeYes) {
      const record = draft('flag');
      for (const line of warnings) this.emit(line);
      return { allowed: true, source: 'flag', record, persisted: false, scriptDigest, buildScripts: scriptPaths, warnings };
    }

    if (this.options.interactive) {
      for (const line of warnings) this.emit(line);
      const answer = await this.options.input(
        `Authorize running ${input.buildSystem} build scripts for ${path.resolve(input.projectRoot)}? [y/N] `,
      );
      const normalized = (answer ?? '').trim().toLowerCase();
      if (normalized === 'y' || normalized === 'yes') {
        const record = draft('interactive');
        this.upsert(record);
        return { allowed: true, source: 'interactive', record, persisted: true, scriptDigest, buildScripts: scriptPaths, warnings };
      }
      return {
        allowed: false,
        reason: `Build script execution was not authorized. Re-run and approve, pass --yes, or set JMC_TRUST_PROJECT_SCRIPTS=1. ${warnings.join(' ')}`,
        scriptDigest,
        buildScripts: scriptPaths,
        warnings,
      };
    }

    for (const line of warnings) this.emit(line);
    return {
      allowed: false,
      reason: `Non-interactive session requires explicit authorization for the first build of this project. Pass --yes, or set JMC_TRUST_PROJECT_SCRIPTS=1. ${warnings.join(' ')}`,
      scriptDigest,
      buildScripts: scriptPaths,
      warnings,
    };
  }

  private buildWarnings(warningText: string[], scriptPaths: string[]): string[] {
    return [
      ...warningText,
      `The following ${scriptPaths.length} build ${scriptPaths.length === 1 ? 'script' : 'scripts'} would run:`,
      ...describeScripts(scriptPaths),
    ];
  }

  private upsert(record: ApprovalRecord): void {
    const records = this.list().filter((entry) => entry.projectKey !== record.projectKey);
    records.push(record);
    this.save(records);
  }
}

const SKIPPED_DIRECTORIES = new Set([
  '.git',
  '.hg',
  '.svn',
  '.gradle',
  '.idea',
  '.vscode',
  '.ideaX',
  'node_modules',
  'build',
  'out',
  'target',
  '.jmc-build',
  '.jmc-test-tmp',
  '.minecraft',
  '.fabric',
  '.quilt',
  '.neoform',
]);

const TRACKED_FILE_NAMES = new Set([
  'build.gradle',
  'build.gradle.kts',
  'settings.gradle',
  'settings.gradle.kts',
  'pom.xml',
  'gradle.properties',
  'gradlew',
  'gradlew.bat',
  'gradlew.cmd',
  'mvnw',
  'mvnw.cmd',
]);

const GRADLE_DIRECTORY_FILES = new Set([
  'libs.versions.toml',
  'wrapper/gradle-wrapper.jar',
  'wrapper/gradle-wrapper.properties',
  'wrapper/gradle-wrapper.properties.template',
]);

const MVN_DIRECTORY_FILES = new Set(['extensions.xml', 'jvm.config', 'maven.config', 'maven.config.template']);

function isTrackedScript(relative: string, roots: string[]): boolean {
  const normalized = normalizeScriptPath(relative);
  const segments = normalized.split('/');
  const base = segments[segments.length - 1] as string;
  if (segments.some((segment) => SKIPPED_DIRECTORIES.has(segment))) return false;
  if (TRACKED_FILE_NAMES.has(base)) return true;
  const scope = roots.find((root) => root.length > 0 && (normalized === root || normalized.startsWith(`${root}/`)));
  const inScope = scope ?? '';
  if (inScope === 'buildSrc') return true;
  const tail = inScope.length === 0 ? normalized : normalized.slice(inScope.length + 1);
  if (inScope === 'gradle') {
    if (GRADLE_DIRECTORY_FILES.has(tail)) return true;
    if (tail.length > 0 && !tail.includes('/') && /\.gradle(\.kts)?$/i.test(tail)) return true;
    return false;
  }
  if (inScope === '.mvn') return MVN_DIRECTORY_FILES.has(tail);
  if (inScope.length > 0) return /\.gradle(\.kts)?$/i.test(tail) || tail === 'gradle.properties';
  if (/\.gradle(\.kts)?$/i.test(base)) return true;
  return false;
}

function scopeOf(relative: string): string {
  return relative.split('/')[0] ?? '';
}

function parseSettingsTargets(content: string): { includes: string[]; includeBuilds: string[] } {
  const includes: string[] = [];
  const includeBuilds: string[] = [];
  const includePattern = /(^|[\s(])include\s+([^\n]*)/g;
  let match = includePattern.exec(content);
  while (match !== null) {
    for (const literal of extractLiterals(match[2] as string)) {
      if (includes.includes(literal)) continue;
      includes.push(literal);
    }
    match = includePattern.exec(content);
  }
  const buildPattern = /includeBuild\s*\(?\s*["']([^"']+)["']/g;
  let buildMatch = buildPattern.exec(content);
  while (buildMatch !== null) {
    const literal = buildMatch[1] as string;
    if (!includeBuilds.includes(literal)) includeBuilds.push(literal);
    buildMatch = buildPattern.exec(content);
  }
  return { includes, includeBuilds };
}

function extractLiterals(text: string): string[] {
  const literals: string[] = [];
  const pattern = /["']([^"']+)["']/g;
  let match = pattern.exec(text);
  while (match !== null) {
    literals.push(match[1] as string);
    match = pattern.exec(text);
  }
  return literals;
}

function parseAppliedScripts(content: string): string[] {
  const applied: string[] = [];
  const fromPattern = /apply\s*(?:\(\s*)?from\s*:\s*(?:\(\s*)?["']([^"']+)["']/g;
  let match = fromPattern.exec(content);
  while (match !== null) {
    applied.push(match[1] as string);
    match = fromPattern.exec(content);
  }
  return applied;
}

function joinRelative(root: string, relative: string): string {
  return relative.length === 0 ? root : path.join(root, relative.split('/').join(path.sep));
}

export function collectBuildScripts(projectRoot: string): ScriptDescriptor[] {
  const fs = defaultFileSystem;
  const root = path.resolve(projectRoot);
  if (!fs.isDirectory(root)) return [];

  const specialScopes = new Set<string>(['buildSrc', 'gradle', '.mvn']);
  const selected = new Map<string, string>();

  const consider = (relative: string): void => {
    const normalized = normalizeScriptPath(relative);
    if (normalized.length === 0 || selected.has(normalized)) return;
    const absolute = joinRelative(root, normalized);
    if (!fs.isFile(absolute)) return;
    selected.set(normalized, absolute);
  };

  const visit = (relativeDirectory: string, scopes: string[]): void => {
    const absolute = joinRelative(root, relativeDirectory);
    for (const entry of fs.readDir(absolute)) {
      const relative = relativeDirectory.length === 0 ? entry.name : `${relativeDirectory}/${entry.name}`;
      if (entry.isDirectory) {
        if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
        const nextScope = relativeDirectory.length === 0 && specialScopes.has(entry.name) ? entry.name : scopeOf(relative);
        visit(relative, scopes.includes(nextScope) ? scopes : [...scopes, nextScope]);
        continue;
      }
      if (!entry.isFile) continue;
      if (isTrackedScript(relative, scopes)) consider(relative);
    }
  };
  visit('', []);

  const extraScopes = new Set<string>();
  for (const file of [...selected.values()]) {
    if (!/\.gradle(\.kts)?$/i.test(file)) continue;
    let content = '';
    try {
      content = fs.readText(file);
    } catch {
      continue;
    }
    if (/(^|[\s(])include\s/.test(content)) {
      const { includes, includeBuilds } = parseSettingsTargets(content);
      for (const target of includes) extraScopes.add(normalizeScriptPath(target));
      for (const target of includeBuilds) {
        const normalized = normalizeScriptPath(target);
        if (normalized !== '.' && normalized.length > 0) extraScopes.add(normalized);
      }
    }
  }
  for (const scope of extraScopes) {
    visit(scope, [scope]);
  }

  const applied = new Map<string, string[]>();
  const queue: string[] = [...selected.keys()];
  while (queue.length > 0) {
    const relative = queue.pop() as string;
    if (applied.has(relative)) continue;
    const absolute = selected.get(relative);
    if (absolute === undefined || !/\.gradle(\.kts)?$/i.test(absolute)) {
      applied.set(relative, []);
      continue;
    }
    let content = '';
    try {
      content = fs.readText(absolute);
    } catch {
      applied.set(relative, []);
      continue;
    }
    const targets: string[] = [];
    const directory = path.dirname(relative).split(path.sep).join('/');
    for (const target of parseAppliedScripts(content)) {
      const normalized = normalizeScriptPath(target);
      if (/^[a-z]+:\/\//i.test(normalized)) continue;
      const fromRoot = normalizeScriptPath(path.posix.join('/', normalized));
      const fromFile = normalizeScriptPath(path.posix.join(directory.length === 0 ? '.' : directory, normalized));
      for (const candidate of [fromRoot, fromFile]) {
        if (!fs.isFile(joinRelative(root, candidate))) continue;
        targets.push(candidate);
        if (!selected.has(candidate)) {
          selected.set(candidate, joinRelative(root, candidate));
          queue.push(candidate);
        }
        break;
      }
    }
    applied.set(relative, targets);
  }

  const descriptors: ScriptDescriptor[] = [];
  for (const relative of [...selected.keys()].sort()) {
    const absolute = selected.get(relative) as string;
    let digest: string;
    try {
      digest = crypto.createHash('sha256').update(fs.readBytes(absolute)).digest('hex');
    } catch {
      continue;
    }
    descriptors.push({ path: normalizeScriptPath(relative), digest });
  }
  return descriptors;
}
