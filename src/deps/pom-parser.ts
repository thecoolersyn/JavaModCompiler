export interface MavenPomModel {
  parent?: { groupId: string; artifactId: string; version?: string; relativePath?: string };
  groupId?: string;
  artifactId?: string;
  version?: string;
  packaging?: string;
  name?: string;
  dependencies: MavenPomDependency[];
  repositories: Array<{ id: string; url: string; releases?: { enabled?: string }; snapshots?: { enabled?: string } }>;
  pluginRepositories: Array<{ id: string; url: string }>;
  properties: Record<string, string>;
  profiles: Array<{ id: string; dependencies: MavenPomDependency[]; repositories: Array<{ id: string; url: string }>; activeByDefault?: boolean }>;
  dependencyManagement: { dependencies: MavenPomDependency[] };
  exclusions: Array<{ groupId: string; artifactId: string }>;
  isSnapshot?: boolean;
}

export interface MavenPomDependency {
  groupId: string;
  artifactId: string;
  version?: string;
  scope?: string;
  type?: string;
  classifier?: string;
  optional?: boolean;
  exclusions: Array<{ groupId: string; artifactId: string }>;
}

export class PomParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PomParseError';
  }
}

function stripComments(content: string): string {
  return content.replace(/<!--[\s\S]*?-->/g, '');
}

function expand(content: string, properties: Record<string, string>, parentProperties: Record<string, string>, depth = 0): string {
  if (depth > 6) return content;
  const merged: Record<string, string> = { ...parentProperties, ...properties };
  const propertyTagBlock = /<properties>([\s\S]*?)<\/properties>/i.exec(content)?.[1];
  if (propertyTagBlock !== undefined) {
    for (const match of propertyTagBlock.matchAll(/<([A-Za-z0-9_.\-]+)>([\s\S]*?)<\/\1>/g)) {
      const key = match[1] as string;
      const value = (match[2] ?? '').trim();
      merged[key] = value;
    }
  }
  return content.replace(/\$\{([^}]+)\}/g, (full, key: string) => {
    const trimmed = key.trim();
    const direct = merged[trimmed];
    if (direct === undefined) return full;
    const resolved = expand(direct, properties, merged, depth + 1);
    return resolved;
  });
}

function textOf(block: string, tag: string): string | undefined {
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i');
  const value = pattern.exec(block)?.[1];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function parseDependencies(block: string | undefined): MavenPomDependency[] {
  if (block === undefined) return [];
  const dependencies: MavenPomDependency[] = [];
  const pattern = /<dependency>([\s\S]*?)<\/dependency>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(block)) !== null) {
    const body = match[1] as string;
    const groupId = textOf(body, 'groupId');
    const artifactId = textOf(body, 'artifactId');
    if (groupId === undefined || artifactId === undefined) continue;
    const exclusionsBlock = textOf(body, 'exclusions');
    const exclusions: Array<{ groupId: string; artifactId: string }> = [];
    if (exclusionsBlock !== undefined) {
      for (const exclusion of exclusionsBlock.matchAll(/<exclusion>([\s\S]*?)<\/exclusion>/gi)) {
        const exclusionGroup = textOf(exclusion[1] ?? '', 'groupId');
        const exclusionArtifact = textOf(exclusion[1] ?? '', 'artifactId');
        if (exclusionGroup !== undefined && exclusionArtifact !== undefined) {
          exclusions.push({ groupId: exclusionGroup, artifactId: exclusionArtifact });
        }
      }
    }
    dependencies.push({
      groupId,
      artifactId,
      version: textOf(body, 'version'),
      scope: textOf(body, 'scope'),
      type: textOf(body, 'type'),
      classifier: textOf(body, 'classifier'),
      optional: textOf(body, 'optional') === 'true',
      exclusions,
    });
  }
  return dependencies;
}

function parseRepositories(content: string, tag: string): Array<{ id: string; url: string }> {
  const block = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i').exec(content)?.[1];
  if (block === undefined) return [];
  const repositories: Array<{ id: string; url: string }> = [];
  const pattern = /<repository>([\s\S]*?)<\/repository>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(block)) !== null) {
    const body = match[1] as string;
    const url = textOf(body, 'url');
    if (url === undefined) continue;
    repositories.push({ id: textOf(body, 'id') ?? url, url });
  }
  return repositories;
}

export function parsePom(content: string, inheritedProperties: Record<string, string> = {}): MavenPomModel {
  const cleaned = stripComments(content);
  const ownProperties: Record<string, string> = {};
  const propertiesBlock = /<properties>([\s\S]*?)<\/properties>/i.exec(cleaned)?.[1];
  if (propertiesBlock !== undefined) {
    for (const match of propertiesBlock.matchAll(/<([A-Za-z0-9_.\-]+)>([\s\S]*?)<\/\1>/g)) {
      ownProperties[match[1] as string] = (match[2] ?? '').trim();
    }
  }
  const projectBlock = new RegExp('<project[^>]*>([\\s\\S]*)</project>', 'i').exec(cleaned)?.[1] ?? cleaned;
  const expanded = expand(projectBlock, ownProperties, inheritedProperties);
  const parentBlock = /<parent>([\s\S]*?)<\/parent>/i.exec(expanded)?.[1];
  let parent: MavenPomModel['parent'];
  if (parentBlock !== undefined) {
    parent = {
      groupId: textOf(parentBlock, 'groupId') ?? '',
      artifactId: textOf(parentBlock, 'artifactId') ?? '',
      version: textOf(parentBlock, 'version'),
      relativePath: textOf(parentBlock, 'relativePath'),
    };
  }
  const profiles: MavenPomModel['profiles'] = [];
  const profilesBlock = /<profiles>([\s\S]*?)<\/profiles>/i.exec(expanded)?.[1];
  if (profilesBlock !== undefined) {
    for (const profileMatch of profilesBlock.matchAll(/<profile>([\s\S]*?)<\/profile>/gi)) {
      const body = profileMatch[1] as string;
      const id = textOf(body, 'id') ?? `profile-${profiles.length + 1}`;
      profiles.push({
        id,
        dependencies: parseDependencies(textOf(body, 'dependencies')),
        repositories: parseRepositories(body, 'repositories'),
        activeByDefault: /<activeByDefault>\s*true\s*<\/activeByDefault>/i.test(body),
      });
    }
  }
  return {
    parent,
    groupId: textOf(expanded, 'groupId') ?? parent?.groupId,
    artifactId: textOf(expanded, 'artifactId'),
    version: textOf(expanded, 'version') ?? parent?.version,
    packaging: textOf(expanded, 'packaging') ?? 'jar',
    name: textOf(expanded, 'name'),
    dependencies: parseDependencies(textOf(expanded, 'dependencies')),
    repositories: parseRepositories(expanded, 'repositories'),
    pluginRepositories: parseRepositories(expanded, 'pluginRepositories'),
    properties: { ...inheritedProperties, ...ownProperties },
    profiles,
    dependencyManagement: { dependencies: parseDependencies(textOf(expanded, 'dependencyManagement')) },
    exclusions: [],
    isSnapshot: /<version>[^<]*SNAPSHOT<\/version>/i.test(expanded),
  };
}

export function validateCoordinateParts(groupId: string, artifactId: string): void {
  if (groupId.trim().length === 0) throw new PomParseError('groupId is empty');
  if (artifactId.trim().length === 0) throw new PomParseError('artifactId is empty');
}