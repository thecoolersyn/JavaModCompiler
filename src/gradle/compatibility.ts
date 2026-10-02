import type { GradleProjectModel } from '../project/gradle-model.js';

export interface GradleCompatibilityRule {
  pluginPattern: RegExp;
  pluginVersionPredicate?: (version: string) => boolean;
  maxGradleMajor: number;
  minGradleMajor: number;
  reason: string;
}

export interface GradleSelection {
  version: string;
  reason: string;
  rules: Array<{ plugin: string; version?: string; rule: string }>;
}

export const CURRENT_GRADLE_VERSION = '8.10.2';

const RULES: GradleCompatibilityRule[] = [
  {
    pluginPattern: /^fabric-loom$|^net\.fabricmc\.loom$/i,
    maxGradleMajor: 8,
    minGradleMajor: 7,
    reason: 'Fabric Loom supports Gradle 7 and 8',
  },
  {
    pluginPattern: /^org\.quiltmc\.loom$|^quilt_loom$/i,
    maxGradleMajor: 8,
    minGradleMajor: 7,
    reason: 'Quilt Loom supports Gradle 7 and 8',
  },
  {
    pluginPattern: /ForgeGradle|net\.minecraftforge\.gradle/i,
    maxGradleMajor: 8,
    minGradleMajor: 6,
    reason: 'ForgeGradle supports Gradle 6 through 8',
  },
  {
    pluginPattern: /net\.neoforged\.moddev|net\.neoforged\.gradle|neoforge/i,
    pluginVersionPredicate: (version) => majorOf(version) <= 1,
    maxGradleMajor: 8,
    minGradleMajor: 7,
    reason: 'NeoForge ModDevGradle 1.x supports Gradle 7 and 8',
  },
  {
    pluginPattern: /net\.neoforged\.moddev/i,
    maxGradleMajor: 9,
    minGradleMajor: 8,
    reason: 'NeoForge ModDevGradle 2.x supports Gradle 8 and 9',
  },
  {
    pluginPattern: /org\.jetbrains\.kotlin\.jvm/i,
    pluginVersionPredicate: (version) => majorOf(version) <= 1,
    maxGradleMajor: 8,
    minGradleMajor: 7,
    reason: 'Kotlin Gradle plugin 1.x supports Gradle 7 and 8',
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
  const versionsByMajor: Record<number, string> = { 6: '6.9.4', 7: '7.6.4', 8: '8.10.2', 9: '9.0.0' };
  return versionsByMajor[major] ?? CURRENT_GRADLE_VERSION;
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
    };
  }
  const applicable: Array<{ plugin: string; version?: string; rule: GradleCompatibilityRule }> = [];
  for (const plugin of model.plugins) {
    for (const rule of RULES) {
      if (!rule.pluginPattern.test(plugin.id)) continue;
      if (rule.pluginVersionPredicate !== undefined) {
        if (plugin.version === undefined || !rule.pluginVersionPredicate(plugin.version)) continue;
      }
      applicable.push({ plugin: plugin.id, version: plugin.version, rule });
      break;
    }
  }
  if (applicable.length === 0) {
    return {
      version: CURRENT_GRADLE_VERSION,
      reason: 'No declared plugin constrains the Gradle version',
      rules: [],
    };
  }
  const maxMajor = Math.min(...applicable.map((entry) => entry.rule.maxGradleMajor));
  const minMajor = Math.max(...applicable.map((entry) => entry.rule.minGradleMajor));
  const chosenMajor = Math.min(maxMajor, 9);
  const version = gradleVersionForMajor(chosenMajor);
  return {
    version,
    reason: applicable.map((entry) => `${entry.plugin}${entry.version === undefined ? '' : `:${entry.version}`}: ${entry.rule.reason}`).join('; '),
    rules: applicable.map((entry) => ({ plugin: entry.plugin, version: entry.version, rule: entry.rule.reason })),
  };
}

export function assertGradleCompatibility(version: string, maxMajor: number): boolean {
  return majorOf(version) <= maxMajor;
}

export function describeGradleCompatibility(version: string): string {
  return `Gradle ${version} (major ${majorOf(version)}, minor ${minorOf(version)})`;
}

export function javaRequiredForMajor(maxGradleMajor: number): number {
  if (maxGradleMajor <= 7) return 17;
  if (maxGradleMajor <= 8) return 17;
  return 21;
}