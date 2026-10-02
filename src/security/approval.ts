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

export type ApprovalDecision =
  | { allowed: true; source: ApprovalRecord['approvedBy']; record: ApprovalRecord }
  | { allowed: false; reason: string; scriptDigest: string; buildScripts: string[] };

export interface ApprovalServiceOptions {
  paths: JmcPaths;
  assumeYes: boolean;
  isCi: boolean;
  trustEnvironmentVariable: string | undefined;
  interactive: boolean;
  input: (question: string) => Promise<string | undefined>;
}

export function projectKeyFor(projectRoot: string): string {
  return crypto.createHash('sha256').update(path.resolve(projectRoot)).digest('hex').slice(0, 16);
}

export function digestOfScripts(scripts: ScriptDescriptor[]): string {
  const hash = crypto.createHash('sha256');
  for (const script of scripts) {
    hash.update(script.path);
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

export class ApprovalService {
  private readonly options: ApprovalServiceOptions;
  private readonly fs = defaultFileSystem;
  private readonly storePath: string;

  constructor(options: ApprovalServiceOptions) {
    this.options = options;
    this.storePath = path.join(options.paths.approvals, 'project-approvals.json');
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

  async requireAuthorization(input: {
    projectRoot: string;
    buildSystem: string;
    scripts: ScriptDescriptor[];
    warningText: string[];
  }): Promise<ApprovalDecision> {
    const fs = this.fs;
    const scriptDigest = digestOfScripts(input.scripts);
    const existing = this.find(input.projectRoot);
    if (existing !== undefined && existing.scriptDigest === scriptDigest && existing.buildSystem === input.buildSystem) {
      return { allowed: true, source: existing.approvedBy, record: existing };
    }
    if (existing !== undefined && existing.scriptDigest !== scriptDigest) {
      this.revoke(input.projectRoot);
    }

    const envTrust = this.options.trustEnvironmentVariable;
    if (envTrust !== undefined && (envTrust === '1' || envTrust.toLowerCase() === 'true')) {
      const record: ApprovalRecord = {
        projectRoot: path.resolve(input.projectRoot),
        projectKey: projectKeyFor(input.projectRoot),
        buildSystem: input.buildSystem,
        buildScripts: input.scripts.map((script) => script.path),
        approvedAt: Date.now(),
        approvedBy: 'environment',
        scriptDigest,
      };
      this.upsert(record);
      return { allowed: true, source: 'environment', record };
    }

    if (this.options.assumeYes) {
      const record: ApprovalRecord = {
        projectRoot: path.resolve(input.projectRoot),
        projectKey: projectKeyFor(input.projectRoot),
        buildSystem: input.buildSystem,
        buildScripts: input.scripts.map((script) => script.path),
        approvedAt: Date.now(),
        approvedBy: 'flag',
        scriptDigest,
      };
      this.upsert(record);
      return { allowed: true, source: 'flag', record };
    }

    if (this.options.interactive) {
      const answer = await this.options.input(
        `Authorize running ${input.buildSystem} build scripts for ${path.resolve(input.projectRoot)}? [y/N] `,
      );
      const normalized = (answer ?? '').trim().toLowerCase();
      if (normalized === 'y' || normalized === 'yes') {
        const record: ApprovalRecord = {
          projectRoot: path.resolve(input.projectRoot),
          projectKey: projectKeyFor(input.projectRoot),
          buildSystem: input.buildSystem,
          buildScripts: input.scripts.map((script) => script.path),
          approvedAt: Date.now(),
          approvedBy: 'interactive',
          scriptDigest,
        };
        this.upsert(record);
        return { allowed: true, source: 'interactive', record };
      }
      return {
        allowed: false,
        reason: 'Build script execution was not authorized. Re-run and approve, pass --yes, or set JMC_TRUST_PROJECT_SCRIPTS=1.',
        scriptDigest,
        buildScripts: input.scripts.map((script) => script.path),
      };
    }

    void fs;
    void input.warningText;
    return {
      allowed: false,
      reason: `Non-interactive session requires explicit authorization for the first build of this project. Pass --yes, or set JMC_TRUST_PROJECT_SCRIPTS=1. Build scripts: ${input.scripts.map((script) => script.path).join(', ')}`,
      scriptDigest,
      buildScripts: input.scripts.map((script) => script.path),
    };
  }

  private upsert(record: ApprovalRecord): void {
    const records = this.list().filter((entry) => entry.projectKey !== record.projectKey);
    records.push(record);
    this.save(records);
  }
}

export function collectBuildScripts(projectRoot: string, candidates: string[]): ScriptDescriptor[] {
  const fs = defaultFileSystem;
  const descriptors: ScriptDescriptor[] = [];
  for (const relative of candidates) {
    const absolute = path.join(projectRoot, relative);
    if (!fs.isFile(absolute)) continue;
    const stats = fs.stat(absolute);
    descriptors.push({
      path: relative,
      digest: crypto.createHash('sha256').update(`${stats.size}:${stats.modifiedMs}`).digest('hex').slice(0, 32),
    });
  }
  return descriptors;
}

export const BUILD_SCRIPT_CANDIDATES = [
  'build.gradle',
  'build.gradle.kts',
  'settings.gradle',
  'settings.gradle.kts',
  'gradle.properties',
  'gradle/libs.versions.toml',
  'gradle/wrapper/gradle-wrapper.properties',
  'pom.xml',
  'gradlew',
  'gradlew.bat',
  'mvnw',
  'mvnw.cmd',
  'package.json',
];