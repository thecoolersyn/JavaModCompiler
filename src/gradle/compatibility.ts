import type { GradlePluginDescriptor, GradleProjectModel } from '../project/gradle-model.js';

export interface GradleCompatibilityRule {
  id: string;
  pluginPattern: RegExp;
  pluginVersionRange?: { min?: number; max?: number };
  minGradleMajor: number;
  maxGradleMajor: number;
  preferredGradle: string;
  javaMajor: number;
  reason: string;
  source: string;
  conservative?: boolean;
}

export interface GradleSelection {
  version: string;
  reason: string;
  rules: Array<{ plugin: string; version?: string; rule: string }>;
  javaMajor?: number;
  conflict?: { plugins: string[]; detail: string };
}

export const CURRENT_GRADLE_VERSION = '8.10.2';

export const GRADLE_VERSIONS_BY_MAJOR: Record<number, string> = {
  2: '2.14.1',
  3: '3.5',
  4: '4.10.3',
  5: '5.6.4',
  6: '6.9.4',
  7: '7.6.4',
  8: '8.10.2',
  9: '9.0.0',
};

export const GRADLE_COMPATIBILITY_RULES: GradleCompatibilityRule[] = [
  {
    id: 'fabric-loom',
    pluginPattern: /^fabric-loom$|^net\.fabricmc\.loom$/i,
    minGradleMajor: 7,
    maxGradleMajor: 8,
    preferredGradle: '8.10.2',
    javaMajor: 17,
    reason: 'Fabric Loom requires Gradle 7 or 8 and a Java 17 toolchain',
    source: 'Fabric Loom documentation',
  },
  {
    id: 'quilt-loom',
    pluginPattern: /^org\.quiltmc\.loom$|^quilt_loom$/i,
    minGradleMajor: 7,
    maxGradleMajor: 8,
    preferredGradle: '8.10.2',
    javaMajor: 17,
    reason: 'Quilt Loom requires Gradle 7 or 8 and a Java 17 toolchain',
    source: 'Quilt Loom documentation',
  },
  {
    id: 'forgegradle-2',
    pluginPattern: /^net\.minecraftforge\.gradle(\.|$)|^ForgeGradle$/i,
    pluginVersionRange: { max: 2 },
    minGradleMajor: 2,
    maxGradleMajor: 4,
    preferredGradle: '4.10.3',
    javaMajor: 8,
    reason: 'ForgeGradle 2.x is the 1.12.2 toolchain: it runs on Gradle 2.14 to 4.10.3 under Java 8',
    source: 'ForgeGradle 2.x releases and the Forge 1.12.2 MDK wrapper',
  },
  {
    id: 'forgegradle-3',
    pluginPattern: /^net\.minecraftforge\.gradle(\.|$)|^ForgeGradle$/i,
    pluginVersionRange: { min: 3, max: 3 },
    minGradleMajor: 4,
    maxGradleMajor: 5,
    preferredGradle: '5.6.4',
    javaMajor: 8,
    reason: 'ForgeGradle 3.x supports Gradle 4 and 5 only; Gradle 6.0 and newer are rejected by the plugin',
    source: 'ForgeGradle 3.x runtime version check',
  },
  {
    id: 'forgegradle-4',
    pluginPattern: /^net\.minecraftforge\.gradle(\.|$)|^ForgeGradle$/i,
    pluginVersionRange: { min: 4, max: 4 },
    minGradleMajor: 6,
    maxGradleMajor: 7,
    preferredGradle: '7.6.4',
    javaMajor: 8,
    reason: 'ForgeGradle 4.x supports Gradle 6.8.1 and newer through Gradle 7',
    source: 'ForgeGradle 4.x runtime version check',
  },
  {
    id: 'forgegradle-5',
    pluginPattern: /^net\.minecraftforge\.gradle(\.|$)|^ForgeGradle$/i,
    pluginVersionRange: { min: 5, max: 5 },
    minGradleMajor: 7,
    maxGradleMajor: 7,
    preferredGradle: '7.6.4',
    javaMajor: 17,
    reason: 'ForgeGradle 5.x targets Gradle 7 and a Java 17 toolchain',
    source: 'ForgeGradle 5.x release notes and Forge Java requirements table',
  },
  {
    id: 'forgegradle-6',
    pluginPattern: /^net\.minecraftforge\.gradle(\.|$)|^ForgeGradle$/i,
    pluginVersionRange: { min: 6, max: 6 },
    minGradleMajor: 8,
    maxGradleMajor: 8,
    preferredGradle: '8.10.2',
    javaMajor: 17,
    reason: 'ForgeGradle 6.x targets Gradle 8.1.1 or newer within the Gradle 8 line',
    source: 'ForgeGradle 5 to 6 migration guide',
  },
  {
    id: 'forgegradle-7',
    pluginPattern: /^net\.minecraftforge\.gradle(\.|$)|^ForgeGradle$/i,
    pluginVersionRange: { min: 7 },
    minGradleMajor: 8,
    maxGradleMajor: 9,
    preferredGradle: '8.10.2',
    javaMajor: 21,
    reason: 'ForgeGradle 7.x targets Gradle 8 or 9 and a Java 21 toolchain',
    source: 'ForgeGradle 7.x plugin releases',
  },
  {
    id: 'neoforge-moddev-1',
    pluginPattern: /^net\.neoforged\.moddev(\.|$)|^net\.neoforged\.gradle(\.|$)|^net\.neoforged\.userdev(\.|$)|^net\.neoforged\.fancymodloader(\.|$)/i,
    pluginVersionRange: { max: 1 },
    minGradleMajor: 7,
    maxGradleMajor: 8,
    preferredGradle: '8.10.2',
    javaMajor: 17,
    reason: 'NeoForge ModDevGradle 1.x supports Gradle 7 and 8 under Java 17',
    source: 'NeoForged ModDevGradle 1.x documentation',
  },
  {
    id: 'neoforge-moddev-2',
    pluginPattern: /^net\.neoforged\.moddev(\.|$)|^net\.neoforged\.gradle(\.|$)|^net\.neoforged\.userdev(\.|$)|^net\.neoforged\.fancymodloader(\.|$)/i,
    pluginVersionRange: { min: 2 },
    minGradleMajor: 8,
    maxGradleMajor: 9,
    preferredGradle: '9.0.0',
    javaMajor: 21,
    reason: 'NeoForge ModDevGradle 2.x supports Gradle 8 and 9 under Java 21',
    source: 'NeoForged ModDevGradle 2.x documentation',
  },
  {
    id: 'kotlin-1',
    pluginPattern: /^org\.jetbrains\.kotlin\.jvm$/i,
    pluginVersionRange: { max: 1 },
    minGradleMajor: 7,
    maxGradleMajor: 8,
    preferredGradle: '8.10.2',
    javaMajor: 17,
    reason: 'Kotlin Gradle plugin 1.9 and older support Gradle 7 and 8',
    source: 'Kotlin Gradle plugin compatibility matrix',
  },
  {
    id: 'kotlin-2',
    pluginPattern: /^org\.jetbrains\.kotlin\.jvm$/i,
    pluginVersionRange: { min: 2 },
    minGradleMajor: 7,
    maxGradleMajor: 9,
    preferredGradle: '8.10.2',
    javaMajor: 17,
    reason: 'Kotlin Gradle plugin 2.x supports Gradle 7.6.3 through Gradle 9',
    source: 'Kotlin Gradle plugin compatibility matrix',
  },
];

function majorOf(version: string): number {
  const parsed = Number.parseInt(version.replace(/^[^0-9]*/, '').split('.')[0] ?? '0', 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function minorOf(version: string): number {
  const parts = version.replace(/^[^0-9]*/, '').split(/[.+-]/);
  const minor = Number.parseInt(parts[1] ?? '0', 10);
  return Number.isNaN(minor) ? 0 : minor;
}

export function gradleVersionForMajor(major: number): string {
  return GRADLE_VERSIONS_BY_MAJOR[major] ?? CURRENT_GRADLE_VERSION;
}

function versionInRange(version: string, range: { min?: number; max?: number }): boolean {
  if (/^v?\d+\.\d+(\.\d+)?$/.test(version) === false && /^\d+(\.\d+)*(\.[\w.+-]+)?$/.test(version) === false) return false;
  const major = majorOf(version);
  if (major === 0) return false;
  if (range.min !== undefined && major < range.min) return false;
  if (range.max !== undefined && major > range.max) return false;
  return true;
}

export function resolvePluginVersion(plugin: GradlePluginDescriptor, properties: Record<string, string>): string | undefined {
  const direct = versionFromText(plugin.version, properties);
  if (direct !== undefined) return direct;
  if (plugin.id.length === 0) {
    return versionFromCatalogReference(plugin.versionRef, properties);
  }
  const reference = versionFromCatalogReference(plugin.versionRef, properties);
  if (reference !== undefined) return reference;
  for (const [key, value] of Object.entries(properties)) {
    if (key.startsWith('plugin.') === false) continue;
    if (value === plugin.id) continue;
    if (value.startsWith(`${plugin.id}:`) === false) continue;
    const candidate = versionFromText(value.slice(plugin.id.length + 1), properties);
    if (candidate !== undefined) return candidate;
  }
  return undefined;
}

function versionFromText(value: string | undefined, properties: Record<string, string>): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (/^\$\{[^}]+\}$/.test(trimmed)) {
    const key = trimmed.slice(2, -1).trim();
    return versionFromText(properties[key], properties);
  }
  const interpolated = trimmed.replace(/\$\{([^}]+)\}/g, (match, key: string) => properties[key.trim()] ?? match);
  if (interpolated !== trimmed) return versionFromText(interpolated, properties);
  if (/^\d[\w.+-]*$/.test(interpolated)) return interpolated;
  return undefined;
}

function versionFromCatalogReference(reference: string | undefined, properties: Record<string, string>): string | undefined {
  if (reference === undefined) return undefined;
  const trimmed = reference.trim();
  if (trimmed.length === 0) return undefined;
  if (/^\$\{[^}]+\}$/.test(trimmed)) {
    const key = trimmed.slice(2, -1).trim();
    return versionFromCatalogReference(properties[key], properties) ?? versionFromText(properties[key], properties);
  }
  if (trimmed.startsWith('libs.')) {
    const tail = trimmed.slice('libs.'.length);
    if (tail.startsWith('plugins.') || tail.startsWith('versions.')) {
      const alias = tail.split('.').slice(1).join('.');
      const catalogKey = tail.startsWith('plugins.') ? `plugin.${alias}` : `version.${alias}`;
      const value = properties[catalogKey];
      if (value === undefined) return undefined;
      const parts = value.split(':');
      return versionFromText(parts[parts.length - 1], properties);
    }
    const value = properties[`libs.${tail}`];
    if (value === undefined) return undefined;
    const parts = value.split(':');
    return versionFromText(parts[parts.length - 1], properties);
  }
  return versionFromText(properties[trimmed], properties);
}

export interface PluginMatch {
  plugin: string;
  version?: string;
  rule: GradleCompatibilityRule;
  conservative: boolean;
}

export function matchPlugin(plugin: GradlePluginDescriptor, properties: Record<string, string>): PluginMatch | undefined {
  const version = resolvePluginVersion(plugin, properties);
  const candidates = GRADLE_COMPATIBILITY_RULES.filter((rule) => rule.pluginPattern.test(plugin.id));
  if (candidates.length === 0) return undefined;
  if (version === undefined) {
    const conservative = [...candidates].sort(
      (left, right) => left.maxGradleMajor - right.maxGradleMajor || left.javaMajor - right.javaMajor,
    )[0] as GradleCompatibilityRule;
    return { plugin: plugin.id, version: undefined, rule: conservative, conservative: true };
  }
  const matched = candidates.find((rule) => (rule.pluginVersionRange === undefined ? true : versionInRange(version, rule.pluginVersionRange)));
  if (matched === undefined) return undefined;
  return { plugin: plugin.id, version, rule: matched, conservative: false };
}

function pluginsFromBuildscriptClasspath(model: GradleProjectModel): GradlePluginDescriptor[] {
  const descriptors: GradlePluginDescriptor[] = [];
  for (const coordinate of model.buildscriptClasspath) {
    const parts = coordinate.split(':');
    const group = parts[0];
    const artifact = parts[1];
    const version = parts[2];
    if (group === undefined || artifact === undefined) continue;
    if (group !== 'net.minecraftforge.gradle' && group !== 'net.neoforged' && group !== 'net.neoforged.gradle') continue;
    if (/^forgegradle$/i.test(artifact) === false && /^moddevgradle$/i.test(artifact) === false) continue;
    descriptors.push({ id: group, version, applyDeclaration: 'buildscript-classpath' });
  }
  return descriptors;
}

export function resolveCatalogAlias(reference: string | undefined, properties: Record<string, string>): GradlePluginDescriptor | undefined {
  if (reference === undefined) return undefined;
  const tail = reference.startsWith('libs.') ? reference.slice('libs.'.length) : reference;
  const key = tail.startsWith('plugins.') ? `plugin.${tail.slice('plugins.'.length)}` : undefined;
  if (key === undefined) return undefined;
  const value = properties[key];
  if (value === undefined) return undefined;
  const separator = value.lastIndexOf(':');
  if (separator === -1) return { id: value, applyDeclaration: 'version-catalog-alias' };
  return { id: value.slice(0, separator), version: value.slice(separator + 1), applyDeclaration: 'version-catalog-alias' };
}

export function effectivePluginList(model: GradleProjectModel | undefined): GradlePluginDescriptor[] {
  if (model === undefined) return [];
  const list: GradlePluginDescriptor[] = [];
  for (const plugin of model.plugins) {
    if (plugin.id.length > 0) {
      list.push(plugin);
      continue;
    }
    const resolved = resolveCatalogAlias(plugin.versionRef, model.properties);
    if (resolved !== undefined) list.push(resolved);
  }
  for (const plugin of pluginsFromBuildscriptClasspath(model)) {
    const existing = list.find((entry) => entry.id === plugin.id);
    if (existing === undefined) {
      list.push(plugin);
      continue;
    }
    if (existing.version === undefined && plugin.version !== undefined) existing.version = plugin.version;
  }
  return list;
}

export function selectGradleVersion(model: GradleProjectModel | undefined): GradleSelection {
  if (model === undefined) {
    return { version: CURRENT_GRADLE_VERSION, reason: 'No project build configuration was available', rules: [] };
  }
  if (model.wrapperVersion !== undefined && model.wrapperVersion.length > 0) {
    return {
      version: model.wrapperVersion,
      reason: 'The project declares a Gradle wrapper version',
      rules: [],
      javaMajor: javaRequiredForGradleVersionString(model.wrapperVersion),
    };
  }
  const properties = model.properties;
  const matches: PluginMatch[] = [];
  for (const plugin of effectivePluginList(model)) {
    const match = matchPlugin(plugin, properties);
    if (match !== undefined) matches.push(match);
  }
  if (matches.length === 0) {
    return {
      version: CURRENT_GRADLE_VERSION,
      reason: 'No declared plugin constrains the Gradle version',
      rules: [],
    };
  }

  const maxMajor = Math.min(...matches.map((entry) => entry.rule.maxGradleMajor));
  const minMajor = Math.max(...matches.map((entry) => entry.rule.minGradleMajor));
  const javaMajor = Math.max(...matches.map((entry) => entry.rule.javaMajor));
  const notes = matches.map((entry) => {
    const basis = entry.conservative ? 'version unresolved' : `version ${entry.version as string}`;
    return `${entry.plugin} (${basis}): ${entry.rule.reason} [${entry.rule.source}]`;
  });

  if (minMajor > maxMajor) {
    const conflicting = matches
      .filter((entry) => entry.rule.minGradleMajor > maxMajor || entry.rule.maxGradleMajor < minMajor)
      .map((entry) => `${entry.plugin}${entry.version === undefined ? '' : `:${entry.version}`} (Gradle ${entry.rule.minGradleMajor}-${entry.rule.maxGradleMajor})`);
    return {
      version: gradleVersionForMajor(maxMajor),
      reason: `No Gradle version satisfies every declared plugin: ${notes.join('; ')}`,
      rules: matches.map((entry) => ({ plugin: entry.plugin, version: entry.version, rule: entry.rule.reason })),
      javaMajor,
      conflict: {
        plugins: conflicting,
        detail: `The intersection of the applicable Gradle ranges is empty: the lowest maximum is ${maxMajor} and the highest minimum is ${minMajor}.`,
      },
    };
  }

  const conservativeOnly = matches.every((entry) => entry.conservative);
  const chosenMajor = Math.min(maxMajor, 9);
  const chosenRule = matches.find((entry) => entry.rule.preferredGradle.length > 0);
  const version =
    chosenRule !== undefined && chosenRule.rule.maxGradleMajor === maxMajor && majorOf(chosenRule.rule.preferredGradle) === chosenMajor
      ? chosenRule.rule.preferredGradle
      : gradleVersionForMajor(chosenMajor);
  const reason = conservativeOnly
    ? `${notes.join('; ')}; no plugin version could be resolved, so the most conservative rule was applied`
    : notes.join('; ');
  return {
    version,
    reason,
    rules: matches.map((entry) => ({ plugin: entry.plugin, version: entry.version, rule: entry.rule.reason })),
    javaMajor,
  };
}

export function assertGradleCompatibility(version: string, maxMajor: number): boolean {
  return majorOf(version) <= maxMajor;
}

export function describeGradleCompatibility(version: string): string {
  return `Gradle ${version} (major ${majorOf(version)}, minor ${minorOf(version)})`;
}

export function javaRequiredForGradleVersionString(gradleVersion: string): number {
  const major = majorOf(gradleVersion);
  if (major <= 4) return 8;
  if (major === 5) return 11;
  if (major === 6) return 15;
  if (major === 7) return 17;
  if (major === 8) return 17;
  return 21;
}

export function javaRequiredForProjectForModel(model: GradleProjectModel | undefined): number {
  const selection = selectGradleVersion(model);
  return selection.javaMajor ?? javaRequiredForGradleVersionString(selection.version);
}
