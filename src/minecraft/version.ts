export interface MinecraftVersionIdentity {
  raw: string;
  normalized: string;
  major: number | undefined;
  minor: number | undefined;
  patch: number | undefined;
  snapshot: boolean;
  release: boolean;
  scheme: 'classic' | 'numeric' | 'snapshot' | 'unknown';
  era: string;
  familyKey: string;
}

const SNAPSHOT_PATTERN = /^\d{2}w\d{2}[a-z]?$/i;
const PRE_RELEASE_PATTERN = /(pre|rc|snapshot|beta|alpha)/i;

export function parseMinecraftVersion(raw: string): MinecraftVersionIdentity {
  const trimmed = raw.trim();
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(trimmed);
  const major = match?.[1] !== undefined ? Number.parseInt(match[1], 10) : undefined;
  const minor = match?.[2] !== undefined ? Number.parseInt(match[2], 10) : undefined;
  const patch = match?.[3] !== undefined ? Number.parseInt(match[3], 10) : undefined;
  const snapshot = SNAPSHOT_PATTERN.test(trimmed);
  const release = match !== null && !snapshot && !PRE_RELEASE_PATTERN.test(trimmed);
  let scheme: MinecraftVersionIdentity['scheme'] = 'unknown';
  if (snapshot) scheme = 'snapshot';
  else if (major !== undefined && major > 100) scheme = 'numeric';
  else if (major !== undefined && minor !== undefined) scheme = 'classic';
  else if (major !== undefined) scheme = 'numeric';
  return {
    raw: trimmed,
    normalized: normalizeVersionText(trimmed),
    major,
    minor,
    patch,
    snapshot,
    release,
    scheme,
    era: deriveEra(major, minor),
    familyKey: deriveFamilyKey(major, minor),
  };
}

export function normalizeVersionText(value: string): string {
  return value.trim().replace(/^v/i, '');
}

export function deriveEra(major: number | undefined, minor: number | undefined): string {
  if (major === undefined) return 'unknown';
  if (major === 1) {
    if (minor === undefined || minor < 7) return 'classic';
    if (minor < 11) return 'beta';
    if (minor < 13) return '1.12-era';
    if (minor < 16) return '1.13-1.15';
    if (minor < 18) return '1.16-1.17';
    return 'modern';
  }
  if (major < 10) return 'numeric-modern';
  return 'numeric-modern';
}

export function deriveFamilyKey(major: number | undefined, minor: number | undefined): string {
  if (major === undefined) return 'unknown';
  if (major !== 1) return String(major);
  if (minor === undefined) return '1';
  return `1.${minor}`;
}

export function versionsShareFamily(left: string, right: string): boolean {
  return parseMinecraftVersion(left).familyKey === parseMinecraftVersion(right).familyKey;
}

export function compareMinecraftVersions(left: string, right: string): number {
  const a = parseMinecraftVersion(left);
  const b = parseMinecraftVersion(right);
  if (a.major !== b.major) return (a.major ?? 0) - (b.major ?? 0);
  if (a.minor !== b.minor) return (a.minor ?? 0) - (b.minor ?? 0);
  if (a.patch !== b.patch) return (a.patch ?? 0) - (b.patch ?? 0);
  return 0;
}

export function isNewerThan(version: string, floor: string): boolean {
  return compareMinecraftVersions(version, floor) > 0;
}

export function isAtLeast(version: string, floor: string): boolean {
  return compareMinecraftVersions(version, floor) >= 0;
}

export interface VersionEvidence {
  version: string;
  source: string;
  weight: number;
}

export function pickVersionFromEvidence(evidence: VersionEvidence[]): VersionEvidence | undefined {
  if (evidence.length === 0) return undefined;
  return [...evidence].sort((a, b) => b.weight - a.weight || compareMinecraftVersions(b.version, a.version))[0];
}

export function javaBaselineForVersion(version: string): number {
  const identity = parseMinecraftVersion(version);
  if (identity.major === undefined) return 8;
  if (identity.major !== 1) return 21;
  const minor = identity.minor ?? 0;
  const patch = identity.patch ?? 0;
  if (minor < 17) return 8;
  if (minor === 17) return 16;
  if (minor < 20) return 17;
  if (minor === 20) return patch >= 5 ? 21 : 17;
  return 21;
}

export function formatVersionIdentity(identity: MinecraftVersionIdentity): string {
  const kind = identity.snapshot ? 'snapshot' : identity.release ? 'release' : identity.scheme;
  return `${identity.raw} (${kind}, era ${identity.era})`;
}