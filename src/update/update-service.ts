import path from 'node:path';
import { defaultFileSystem } from '../platform/fs.js';
import { createPaths, ensurePathTree, type JmcPaths } from '../platform/paths.js';
import { JMC_REPOSITORY } from '../cli/constants.js';

export const UPDATE_ENDPOINT = `https://api.github.com/repos/${JMC_REPOSITORY}/releases/latest`;

export const UPDATE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
export const UPDATE_TIMEOUT_MS = 4000;
export const MAX_SUMMARY_LINES = 6;
export const MAX_LINE_LENGTH = 160;

export interface ReleaseSummaryLine {
  heading?: string;
  text: string;
}

export interface UpdateCheck {
  currentVersion: string;
  latestVersion?: string;
  updateAvailable: boolean;
  releaseTitle?: string;
  releaseUrl?: string;
  publishedAt?: string;
  prerelease: boolean;
  summary: ReleaseSummaryLine[];
  checkedAt: number;
  fromCache: boolean;
  failure?: string;
}

export interface UpdateCheckOptions {
  currentVersion: string;
  offline: boolean;
  force: boolean;
  json: boolean;
  now?: number;
  fetchText?: (url: string, timeoutMs: number) => Promise<string>;
}

export function normalizeVersion(value: string): string {
  return value.trim().replace(/^v/i, '').replace(/^=+/, '').trim();
}

export function parsePrereleaseParts(version: string): { release: number[]; prerelease: string[] } {
  const normalized = normalizeVersion(version);
  const [core = '', ...rest] = normalized.split('-');
  const release = core.split('.').map((part) => {
    const parsed = Number.parseInt(part, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  });
  return { release, prerelease: rest.join('-').split('.').filter((part) => part.length > 0) };
}

export function compareVersions(left: string, right: string): number {
  const a = parsePrereleaseParts(left);
  const b = parsePrereleaseParts(right);
  const length = Math.max(a.release.length, b.release.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = a.release[index] ?? 0;
    const rightPart = b.release[index] ?? 0;
    if (leftPart !== rightPart) return leftPart < rightPart ? -1 : 1;
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return Number.parseInt(leftPart, 10) < Number.parseInt(rightPart, 10) ? -1 : 1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

export function isUpdateAvailable(current: string, latest: string): boolean {
  return compareVersions(current, latest) < 0;
}

export function extractSummary(body: string | undefined, limit = MAX_SUMMARY_LINES): ReleaseSummaryLine[] {
  if (body === undefined || body.trim().length === 0) return [];
  const lines: ReleaseSummaryLine[] = [];
  let heading: string | undefined;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (/^!?\[.*\]\(.*\)$/.test(line)) continue;
    if (/^`{3,}/.test(line) || /^~~~/.test(line)) continue;
    if (/^#{1,6}\s+/.test(line)) {
      heading = line.replace(/^#{1,6}\s+/, '').replace(/[*:_`]+$/, '').trim();
      if (heading.length > 0 && lines.length < limit) lines.push({ heading, text: heading });
      continue;
    }
    const bullet = line.replace(/^[-*+]\s+/, '').replace(/^\d+[.)]\s+/, '').replace(/^>\s*/, '').trim();
    if (bullet.length === 0) continue;
    if (lines.length >= limit) break;
    lines.push({ heading, text: bullet.length > MAX_LINE_LENGTH ? `${bullet.slice(0, MAX_LINE_LENGTH - 1)}…` : bullet });
  }
  return lines.slice(0, limit);
}

export interface ParsedRelease {
  latestVersion?: string;
  releaseTitle?: string;
  releaseUrl?: string;
  publishedAt?: string;
  prerelease: boolean;
  body?: string;
}

export function parseReleaseResponse(payload: string): ParsedRelease | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  const tag = typeof record.tag_name === 'string' ? record.tag_name : undefined;
  if (tag === undefined || tag.trim().length === 0) return undefined;
  const version = normalizeVersion(tag);
  if (/^\d/.test(version) === false) return undefined;
  return {
    latestVersion: version,
    releaseTitle: typeof record.name === 'string' && record.name.trim().length > 0 ? record.name.trim() : undefined,
    releaseUrl: typeof record.html_url === 'string' ? record.html_url : undefined,
    publishedAt: typeof record.published_at === 'string' ? record.published_at : undefined,
    prerelease: record.prerelease === true,
    body: typeof record.body === 'string' ? record.body : undefined,
  };
}

export function updateCachePath(paths: JmcPaths): string {
  return path.join(paths.home, 'update-check.json');
}

export function readUpdateCache(paths: JmcPaths): UpdateCheck | undefined {
  const target = updateCachePath(paths);
  if (defaultFileSystem.isFile(target) === false) return undefined;
  try {
    const parsed = JSON.parse(defaultFileSystem.readText(target)) as UpdateCheck;
    if (typeof parsed.checkedAt !== 'number' || typeof parsed.currentVersion !== 'string') return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export function writeUpdateCache(paths: JmcPaths, check: UpdateCheck): void {
  const target = updateCachePath(paths);
  try {
    defaultFileSystem.ensureDir(path.dirname(target));
    defaultFileSystem.writeText(target, JSON.stringify(check, null, 2));
  } catch {
    return;
  }
}

export function isCacheFresh(check: UpdateCheck, now: number, ttl = UPDATE_CACHE_TTL_MS): boolean {
  return now - check.checkedAt < ttl;
}

export function describeFailure(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function formatUpdateNotice(check: UpdateCheck): string[] {
  if (check.updateAvailable === false || check.latestVersion === undefined) return [];
  const lines = [`JMC update available: ${check.currentVersion} → ${check.latestVersion}`];
  if (check.releaseTitle !== undefined && check.releaseTitle.length > 0) lines.push(`Release: ${check.releaseTitle}`);
  if (check.summary.length > 0) {
    lines.push('Latest changes:');
    let currentHeading: string | undefined;
    for (const entry of check.summary) {
      if (entry.heading !== undefined && entry.heading !== currentHeading) {
        currentHeading = entry.heading;
        lines.push(`- ${entry.heading}`);
        continue;
      }
      lines.push(`- ${entry.text}`);
    }
  }
  if (check.releaseUrl !== undefined) lines.push(`GitHub: ${check.releaseUrl}`);
  return lines;
}

export class UpdateService {
  private readonly paths: JmcPaths;
  private readonly fetchTextImpl: (url: string, timeoutMs: number) => Promise<string>;

  constructor(options: { paths: JmcPaths; fetchText?: (url: string, timeoutMs: number) => Promise<string> }) {
    this.paths = options.paths;
    this.fetchTextImpl = options.fetchText ?? defaultFetchText;
  }

  async check(options: UpdateCheckOptions): Promise<UpdateCheck> {
    const now = options.now ?? Date.now();
    if (options.offline) {
      return {
        currentVersion: options.currentVersion,
        updateAvailable: false,
        prerelease: false,
        summary: [],
        checkedAt: now,
        fromCache: false,
        failure: 'offline mode skips the update check',
      };
    }
    const cached = readUpdateCache(this.paths);
    if (options.force === false && cached !== undefined && isCacheFresh(cached, now)) {
      return { ...cached, currentVersion: options.currentVersion, fromCache: true };
    }
    try {
      const payload = await this.fetchTextImpl(UPDATE_ENDPOINT, UPDATE_TIMEOUT_MS);
      const release = parseReleaseResponse(payload);
      if (release === undefined || release.latestVersion === undefined) {
        const failed: UpdateCheck = {
          currentVersion: options.currentVersion,
          updateAvailable: false,
          prerelease: false,
          summary: [],
          checkedAt: now,
          fromCache: false,
          failure: 'the release response could not be understood',
        };
        writeUpdateCache(this.paths, failed);
        return failed;
      }
      const check: UpdateCheck = {
        currentVersion: options.currentVersion,
        latestVersion: release.latestVersion,
        updateAvailable: isUpdateAvailable(options.currentVersion, release.latestVersion),
        releaseTitle: release.releaseTitle,
        releaseUrl: release.releaseUrl,
        publishedAt: release.publishedAt,
        prerelease: release.prerelease,
        summary: extractSummary(release.body),
        checkedAt: now,
        fromCache: false,
      };
      writeUpdateCache(this.paths, check);
      return check;
    } catch (error) {
      const message = describeFailure(error);
      const failed: UpdateCheck = {
        currentVersion: options.currentVersion,
        updateAvailable: false,
        prerelease: false,
        summary: [],
        checkedAt: now,
        fromCache: false,
        failure: message,
      };
      if (cached !== undefined) return { ...cached, currentVersion: options.currentVersion, fromCache: true, failure: message };
      writeUpdateCache(this.paths, failed);
      return failed;
    }
  }
}

async function defaultFetchText(url: string, timeoutMs: number): Promise<string> {
  const response = await fetch(url, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'jmc-update-check',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status === 403 || response.status === 429) {
    throw new Error(`the GitHub API rate limited the update check (HTTP ${response.status})`);
  }
  if (response.status >= 400) {
    throw new Error(`the GitHub API returned HTTP ${response.status}`);
  }
  return response.text();
}

export function createUpdateService(home: string, fetchText?: (url: string, timeoutMs: number) => Promise<string>): UpdateService {
  const paths = createPaths({ ...process.env, JMC_HOME: home });
  ensurePathTree(paths);
  return new UpdateService({ paths, fetchText });
}

