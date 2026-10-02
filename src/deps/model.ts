export interface MavenCoordinate {
  groupId: string;
  artifactId: string;
  version: string;
  classifier?: string;
  extension: string;
}

export interface MavenRepository {
  id: string;
  url: string;
  kind: 'maven' | 'ivy' | 'local' | 'flat-dir';
  priority: number;
  source: string;
  allowedContent?: string;
}

export interface DependencyNode {
  coordinate: MavenCoordinate;
  configuration?: string;
  scope?: string;
  optional: boolean;
  direct: boolean;
  depth: number;
  path: string[];
  repositoryId?: string;
  resolvedFile?: string;
  status: 'resolved' | 'missing' | 'conflicted' | 'skipped';
  children: DependencyNode[];
  notes: string[];
}

export interface UnresolvedDependency {
  coordinate: MavenCoordinate;
  requestedBy: string;
  repositoriesChecked: string[];
  cause: string;
  statusCode?: number;
}

export interface DependencyResolutionResult {
  roots: DependencyNode[];
  unresolved: UnresolvedDependency[];
  conflicts?: Array<{ coordinate: string; selected: string; rejected: string[] }>;
  totalResolved: number;
  durationMs: number;
}

export function formatCoordinate(coordinate: MavenCoordinate): string {
  const classifier = coordinate.classifier !== undefined && coordinate.classifier.length > 0 ? `:${coordinate.classifier}` : '';
  return `${coordinate.groupId}:${coordinate.artifactId}:${coordinate.version}${classifier}:${coordinate.extension}`;
}

export function parseCoordinateString(input: string, defaultExtension = 'jar'): MavenCoordinate | undefined {
  const trimmed = input.trim();
  if (trimmed.length === 0) return undefined;
  const parts = trimmed.split(':');
  if (parts.length < 2) return undefined;
  const groupId = (parts[0] ?? '').trim();
  const artifactId = (parts[1] ?? '').trim();
  if (groupId.length === 0 || artifactId.length === 0) return undefined;
  const version = (parts[2] ?? '').trim() || '+';
  const classifier = parts.length >= 4 ? (parts[3] ?? '').trim() : undefined;
  const extension = parts.length >= 5 ? (parts[4] ?? '').trim() : defaultExtension;
  return {
    groupId,
    artifactId,
    version,
    classifier: classifier !== undefined && classifier.length > 0 ? classifier : undefined,
    extension: extension.length > 0 ? extension : defaultExtension,
  };
}

export function relativeMavenPath(coordinate: MavenCoordinate): string {
  const classifier = coordinate.classifier !== undefined && coordinate.classifier.length > 0 ? `-${coordinate.classifier}` : '';
  const extension = coordinate.extension.length > 0 ? coordinate.extension : 'jar';
  return `${coordinate.groupId.replace(/\./g, '/')}/${coordinate.artifactId}/${coordinate.version}/${coordinate.artifactId}-${coordinate.version}${classifier}.${extension}`;
}

export function mavenBaseUrl(repository: MavenRepository): string {
  return repository.url.endsWith('/') ? repository.url : `${repository.url}/`;
}

export function normalizeRepositoryUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

export function versionCompare(left: string, right: string): number {
  const leftParts = left.split(/[.\-_+]/);
  const rightParts = right.split(/[.\-_+]/);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const a = leftParts[index];
    const b = rightParts[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) {
      const difference = Number.parseInt(a, 10) - Number.parseInt(b, 10);
      if (difference !== 0) return difference;
      continue;
    }
    if (aNumeric !== bNumeric) return aNumeric ? 1 : -1;
    if (a !== b) return a < b ? -1 : 1;
  }
  return 0;
}

export function versionMatches(requested: string, available: string[]): string | undefined {
  if (available.length === 0) return undefined;
  if (requested === '+' || requested === 'latest.release' || requested.length === 0) {
    return [...available].sort(versionCompare)[available.length - 1];
  }
  const direct = available.find((candidate) => candidate === requested);
  if (direct !== undefined) return direct;
  const normalized = requested.endsWith('+') ? requested.slice(0, -1) : requested;
  const prefixMatches = available.filter((candidate) => candidate.startsWith(normalized));
  if (prefixMatches.length > 0) return [...prefixMatches].sort(versionCompare)[prefixMatches.length - 1] as string;
  return undefined;
}

export function isDynamicVersion(version: string): boolean {
  return version === '+' || version === 'latest.release' || /^[0-9.]+\+$/.test(version) || version.includes('${') || version.includes('SNAPSHOT');
}

export function sortDependencies(nodes: DependencyNode[]): DependencyNode[] {
  return nodes.sort((a, b) => {
    const directOrder = Number(b.direct) - Number(a.direct);
    if (directOrder !== 0) return directOrder;
    return a.coordinate.groupId.localeCompare(b.coordinate.groupId) || a.coordinate.artifactId.localeCompare(b.coordinate.artifactId);
  });
}

export function flattenDependencies(nodes: DependencyNode[], include = new Set<string>()): DependencyNode[] {
  const out: DependencyNode[] = [];
  const walk = (list: DependencyNode[]): void => {
    for (const node of list) {
      const key = formatCoordinate(node.coordinate);
      if (include.has(key)) {
        out.push(node);
        continue;
      }
      include.add(key);
      out.push(node);
      walk(node.children);
    }
  };
  walk(nodes);
  return out;
}