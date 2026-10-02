import path from 'node:path';
import type { MavenModel } from './gradle-model.js';
import { defaultFileSystem } from '../platform/fs.js';

export function parseMavenModel(pomPath: string): MavenModel | undefined {
  const fs = defaultFileSystem;
  if (!fs.isFile(pomPath)) return undefined;
  const content = fs.readText(pomPath);
  const model: MavenModel = { properties: {}, dependencies: [], repositories: [], profiles: [] };

  const propertiesBlock = extractBlock(content, 'properties');
  if (propertiesBlock !== undefined) {
    for (const entry of extractPropertyEntries(propertiesBlock)) {
      model.properties[entry.key] = entry.value;
    }
  }

  const parentBlock = extractBlock(content, 'parent');
  if (parentBlock !== undefined) {
    const group = extractFirstTag(parentBlock, 'groupId');
    const artifact = extractFirstTag(parentBlock, 'artifactId');
    const version = extractFirstTag(parentBlock, 'version');
    if (group !== undefined && artifact !== undefined) {
      model.parent = { groupId: group, artifactId: artifact, version };
    }
  }

  model.groupId = extractFirstTag(content, 'groupId') ?? model.parent?.groupId;
  model.artifactId = extractFirstTag(content, 'artifactId');
  model.version = extractFirstTag(content, 'version') ?? model.parent?.version;
  model.packaging = extractFirstTag(content, 'packaging');

  const dependenciesBlock = extractBlock(content, 'dependencies');
  if (dependenciesBlock !== undefined) {
    for (const block of extractRepeatedBlocks(dependenciesBlock, 'dependency')) {
      const groupId = extractFirstTag(block, 'groupId');
      const artifactId = extractFirstTag(block, 'artifactId');
      if (groupId === undefined || artifactId === undefined) continue;
      model.dependencies.push({
        groupId,
        artifactId,
        version: extractFirstTag(block, 'version'),
        scope: extractFirstTag(block, 'scope'),
        optional: extractFirstTag(block, 'optional') === 'true',
      });
    }
  }

  for (const block of extractRepeatedBlocks(content, 'repository')) {
    const id = extractFirstTag(block, 'id');
    const url = extractFirstTag(block, 'url');
    if (url !== undefined) model.repositories.push({ id: id ?? url, url });
  }

  const buildBlock = extractBlock(content, 'build');
  if (buildBlock !== undefined) {
    model.buildSourceDirectory = extractFirstTag(buildBlock, 'sourceDirectory');
    const pluginsBlock = extractBlock(buildBlock, 'plugins');
    if (pluginsBlock !== undefined) {
      const source = extractFirstTag(pluginsBlock, 'maven.compiler.source');
      const target = extractFirstTag(pluginsBlock, 'maven.compiler.target');
      model.mavenCompilerSource = source;
      model.mavenCompilerTarget = target;
    }
  }
  model.mavenCompilerSource = model.mavenCompilerSource ?? model.properties['maven.compiler.source'];
  model.mavenCompilerTarget = model.mavenCompilerTarget ?? model.properties['maven.compiler.target'];

  for (const block of extractRepeatedBlocks(content, 'profile')) {
    const id = extractFirstTag(block, 'id');
    if (id === undefined) continue;
    const activation = extractBlock(block, 'activation');
    model.profiles.push({ id, activation: activation === undefined ? undefined : collapseWhitespace(activation) });
  }

  void path;
  return model;
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function stripComments(content: string): string {
  return content.replace(/<!--[\s\S]*?-->/g, '').replace(/^\s*<!--[\s\S]*$/gm, '');
}

export function extractBlock(content: string, tag: string): string | undefined {
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i');
  return pattern.exec(stripComments(content))?.[1];
}

export function extractRepeatedBlocks(content: string, tag: string): string[] {
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'gi');
  const blocks: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(stripComments(content))) !== null) {
    if (match[1] !== undefined) blocks.push(match[1]);
  }
  return blocks;
}

export function extractFirstTag(content: string, tag: string): string | undefined {
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i');
  const value = pattern.exec(stripComments(content))?.[1];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

export function extractPropertyEntries(content: string): Array<{ key: string; value: string }> {
  const cleaned = stripComments(content);
  const entries: Array<{ key: string; value: string }> = [];
  const pattern = /<([A-Za-z0-9_.\-]+)>([\s\S]*?)<\/\1>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(cleaned)) !== null) {
    const key = match[1];
    const value = (match[2] ?? '').trim();
    if (key === undefined || value.length === 0) continue;
    entries.push({ key, value });
  }
  return entries;
}

export function extractTagValues(content: string, tag: string): Array<{ key: string; value: string }> {
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'gi');
  const values: Array<{ key: string; value: string }> = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(stripComments(content))) !== null) {
    if (match[1] === undefined) continue;
    const value = match[1].trim();
    if (value.length > 0) values.push({ key: tag, value });
  }
  return values;
}