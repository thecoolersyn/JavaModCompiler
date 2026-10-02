import type { LoaderAdapterProfile, ModLoaderAdapter } from '../core/types.js';
import type { ProjectDetection } from '../project/detection.js';
import { GenericGradleAdapter } from './generic-gradle.js';

export interface LoaderAdapterOptions {
  gradleProperties?: Record<string, string>;
  extraGradleArguments?: string[];
}

function hasPlugin(project: ProjectDetection, patterns: RegExp[]): boolean {
  const plugins = project.gradle?.plugins ?? [];
  return plugins.some((plugin) => patterns.some((pattern) => pattern.test(plugin.id)));
}

function hasDependency(project: ProjectDetection, patterns: RegExp[]): boolean {
  const dependencies = project.gradle?.dependencies.dependencies ?? [];
  return dependencies.some((dependency) => patterns.some((pattern) => pattern.test(dependency)));
}

export class FabricAdapter extends GenericGradleAdapter {
  override readonly id: string = 'fabric';
  override readonly displayName: string = 'Fabric';

  constructor(options: LoaderAdapterOptions = {}) {
    super({
      preferProjectTasks: true,
      gradleProperties: { ...options.gradleProperties },
      extraGradleArguments: options.extraGradleArguments,
    });
  }

  override detect(project: ProjectDetection): LoaderAdapterProfile | undefined {
    const pluginMatch = hasPlugin(project, [/fabric.*loom/i, /net\.fabricmc/i]);
    const dependencyMatch = hasDependency(project, [/net\.fabricmc:fabric-loader/i]);
    const manifestMatch = project.modMetadata.some((metadata) => metadata.kind === 'fabric.mod.json');
    if (!pluginMatch && !dependencyMatch && !manifestMatch) return undefined;
    return {
      id: this.id,
      displayName: this.displayName,
      buildTasks: ['build'],
      mappingsCoordinates: [
        { groupId: 'net.fabricmc', artifactId: 'yarn' },
        { groupId: 'net.fabricmc', artifactId: 'intermediary' },
      ],
      manifestType: 'fabric',
      notes: [
        'Fabric Loom owns compilation, remapping and packaging; JMC supplies the JDK, Gradle distribution and isolated environment.',
        'Fabric artifacts use an intermediary namespace at runtime; the project build is responsible for the final remap.',
      ],
    };
  }

  protected override remapTasks(): string[] {
    return ['remapJar', 'remapSourcesJar', 'build'];
  }

  protected override requiredJava(project: ProjectDetection): number | undefined {
    if (project.gradle?.javaToolchain !== undefined) return project.gradle.javaToolchain;
    return undefined;
  }

  private loaderVersionOf(project: ProjectDetection): string | undefined {
    const properties = project.gradle?.properties ?? {};
    return properties['loader_version'] ?? properties['loader_version '] ?? properties.fabricLoaderVersion;
  }
}

export class QuiltAdapter extends GenericGradleAdapter {
  override readonly id: string = 'quilt';
  override readonly displayName: string = 'Quilt';

  constructor(options: LoaderAdapterOptions = {}) {
    super({
      preferProjectTasks: true,
      gradleProperties: { ...options.gradleProperties },
      extraGradleArguments: options.extraGradleArguments,
    });
  }

  override detect(project: ProjectDetection): LoaderAdapterProfile | undefined {
    const pluginMatch = hasPlugin(project, [/quilt.*loom/i, /org\.quiltmc/i]);
    const manifestMatch = project.modMetadata.some((metadata) => metadata.kind === 'quilt.mod.json' || metadata.kind === 'quilted_fabric.json');
    const dependencyMatch = hasDependency(project, [/org\.quiltmc:quilt-loader/i, /org\.quiltmc:quilted-fabric/i]);
    if (!pluginMatch && !manifestMatch && !dependencyMatch) return undefined;
    return {
      id: this.id,
      displayName: this.displayName,
      buildTasks: ['build'],
      mappingsCoordinates: [
        { groupId: 'org.quiltmc', artifactId: 'yarn' },
        { groupId: 'org.quiltmc', artifactId: 'intermediary' },
      ],
      manifestType: 'quilt',
      notes: [
        'Quilt Loom owns compilation, remapping and packaging.',
        'Quilt is Loader-API-compatible with Fabric, so Fabric-oriented conventions mostly apply.',
      ],
    };
  }

  protected override remapTasks(): string[] {
    return ['remapJar', 'build'];
  }
}

export class ForgeAdapter extends GenericGradleAdapter {
  override readonly id: string = 'forge';
  override readonly displayName: string = 'Forge';

  constructor(options: LoaderAdapterOptions = {}) {
    super({
      preferProjectTasks: true,
      buildTasks: ['build'],
      gradleProperties: { ...options.gradleProperties },
      extraGradleArguments: options.extraGradleArguments,
    });
  }

  override detect(project: ProjectDetection): LoaderAdapterProfile | undefined {
    const pluginMatch = hasPlugin(project, [/forgegradle/i, /net\.minecraftforge\.gradle/i, /net\.minecraftforge/i]);
    const manifestMatch = project.modMetadata.some((metadata) => metadata.kind === 'META-INF/mods.toml');
    const dependencyMatch = hasDependency(project, [/net\.minecraftforge:forge/i]);
    if (!pluginMatch && !manifestMatch && !dependencyMatch) return undefined;
    return {
      id: this.id,
      displayName: this.displayName,
      buildTasks: ['build'],
      mappingsCoordinates: [
        { groupId: 'net.minecraftforge', artifactId: 'official' },
        { groupId: 'net.minecraftforge', artifactId: 'mcp_config' },
        { groupId: 'net.minecraftforge', artifactId: 'installertools' },
      ],
      manifestType: 'forge',
      clientSourceSets: ['src/main/java'],
      serverSourceSets: ['src/main/java'],
      notes: [
        'ForgeGradle or ModDevGradle owns the userdev pipeline including reobfuscation.',
        'JMC does not reimplement Forge reobfuscation; the project build performs it inside the isolated workspace.',
      ],
    };
  }

  protected override remapTasks(): string[] {
    return ['reobfJar', 'build'];
  }

  protected override jarTasks(): string[] {
    return ['jar', 'reobfJar'];
  }
}

export class NeoForgeAdapter extends GenericGradleAdapter {
  override readonly id: string = 'neoforge';
  override readonly displayName: string = 'NeoForge';

  constructor(options: LoaderAdapterOptions = {}) {
    super({
      preferProjectTasks: true,
      buildTasks: ['build'],
      gradleProperties: { ...options.gradleProperties },
      extraGradleArguments: options.extraGradleArguments,
    });
  }

  override detect(project: ProjectDetection): LoaderAdapterProfile | undefined {
    const pluginMatch = hasPlugin(project, [/net\.neoforged/i, /neoforge/i, /moddev/i]);
    const manifestMatch = project.modMetadata.some((metadata) => metadata.kind === 'META-INF/neoforge.mods.toml');
    const dependencyMatch = hasDependency(project, [/net\.neoforged:neoforge/i, /net\.neoforged\.fancymodloader/i]);
    if (!pluginMatch && !manifestMatch && !dependencyMatch) return undefined;
    return {
      id: this.id,
      displayName: this.displayName,
      buildTasks: ['build'],
      mappingsCoordinates: [
        { groupId: 'net.neoforged', artifactId: 'neoform' },
        { groupId: 'net.neoforged', artifactId: 'neoforge' },
      ],
      manifestType: 'neoforge',
      notes: [
        'NeoForge ModDevGradle owns production-mode compilation, patching and reobfuscation.',
        'Modern NeoForge projects target Java 21.',
      ],
    };
  }

  protected override remapTasks(): string[] {
    return ['reobfJar', 'build'];
  }

  protected override requiredJava(project: ProjectDetection): number | undefined {
    return project.gradle?.javaToolchain ?? 21;
  }
}

export function createBuiltinLoaders(): ModLoaderAdapter[] {
  return [
    new FabricAdapter(),
    new QuiltAdapter(),
    new NeoForgeAdapter(),
    new ForgeAdapter(),
    new GenericGradleAdapter({ preferProjectTasks: true }),
  ];
}