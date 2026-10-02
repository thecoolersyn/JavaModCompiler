import path from 'node:path';
import type { BuildContext, Stage, StageResult } from '../core/types.js';
import { defaultFileSystem } from '../platform/fs.js';
import { javaRequiredForGradleVersion } from '../gradle/manager.js';
import { javaBaselineForVersion } from '../minecraft/version.js';
import { extractArchive } from '../net/archive.js';
import { detectFormatFromExtension } from '../mappings/providers.js';

export const prepareStage: Stage = {
  id: 'PREPARE',
  label: 'Toolchain and Mappings',
  async run(context: BuildContext): Promise<StageResult> {
    const project = context.project;
    if (project === undefined) return { diagnostics: fatal('project-missing', 'Project detection did not run') };
    const fs = defaultFileSystem;
    const artifacts: string[] = [];
    const diagnostics: NonNullable<StageResult['diagnostics']> = [];
    const warnings: string[] = [];

    const javaMajor = context.options.javaOverride ?? project.javaTarget ?? javaBaselineForVersion(context.toolchain.minecraftVersion ?? '1.20.1');
    context.toolchain.javaMajor = javaMajor;
    const installation = await context.services.java.resolve({ minMajor: javaMajor });
    context.toolchain.javaHome = installation.javaHome;
    context.toolchain.javaVersionText = installation.versionText;
    context.toolchain.javaVendor = installation.vendor;
    context.toolchain.notes.push(`Java ${installation.versionText} (${installation.origin})`);

    if (project.gradle !== undefined) {
      const selection = context.services.gradle.selectVersion(project.gradle);
      const gradleVersion = selection.version;
      context.toolchain.notes.push(`Gradle ${gradleVersion} selected because ${selection.reason}`);
      const requiredJava = javaRequiredForGradleVersion(gradleVersion);
      if (installation.version < requiredJava) {
        const upgrade = await context.services.java.resolve({ minMajor: requiredJava });
        context.toolchain.javaHome = upgrade.javaHome;
        context.toolchain.javaVersionText = upgrade.versionText;
        context.toolchain.javaVendor = upgrade.vendor;
        context.toolchain.javaMajor = upgrade.version;
        context.toolchain.notes.push(`Upgraded to Java ${upgrade.versionText} because Gradle ${gradleVersion} requires Java ${requiredJava}`);
      }
      const install = await context.services.gradle.ensureDistribution(gradleVersion);
      context.toolchain.gradleVersion = install.version;
      context.toolchain.gradleHome = install.gradleHome;
      context.toolchain.gradleBinary = install.binScript;
      context.toolchain.notes.push(`Gradle ${install.version} (${install.managed ? 'managed by JMC' : 'project wrapper'})`);
    }

    const mappingsPath = context.toolchain.mappingsPath;
    if (mappingsPath !== undefined) {
      const stagingDirectory = context.workspace.mappings.mkdir('staged');
      if (fs.isDirectory(mappingsPath)) {
        fs.copy(mappingsPath, stagingDirectory);
        const stagedFiles = fs.findFiles(stagingDirectory, () => true, 8);
        artifacts.push(...stagedFiles.map((file) => path.join(stagingDirectory, file)));
        context.logger.debug(`Staged ${stagedFiles.length} mapping files`, 'PREPARE');
      } else {
        const kind = detectFormatFromExtension(mappingsPath);
        if (kind === undefined) {
          warnings.push(`Mappings file ${path.basename(mappingsPath)} has an unrecognized extension; the format was detected from its header instead`);
        }
        const destination = path.join(stagingDirectory, path.basename(mappingsPath));
        fs.copy(mappingsPath, destination);
        artifacts.push(destination);
        const registry = context.mappingsDescriptor;
        void registry;
        if (/^(mappings|minecraft|mapped|yarn|parchment)/i.test(path.basename(mappingsPath)) && /\.(jar|zip)$/i.test(mappingsPath)) {
          const unpacked = context.workspace.mappings.mkdir('unpacked');
          try {
            await extractArchive(mappingsPath, unpacked);
            const unpackedFiles = fs.findFiles(unpacked, () => true, 8);
            artifacts.push(...unpackedFiles.map((file) => path.join(unpacked, file)));
          } catch (error) {
            diagnostics.push({
              id: 'mappings-archive-unreadable',
              severity: 'error',
              title: 'Mappings',
              summary: 'The mappings archive could not be extracted',
              stage: 'PREPARE',
              detected: [(error as Error).message],
              cause: 'JMC supports ZIP and TAR archives; this file could not be opened as either.',
              suggestions: ['Provide a ZIP or TAR.GZ mapping archive, or pass a plain mapping file.'],
              evidence: [`file: ${mappingsPath}`],
              rawMessages: [(error as Error).message],
            });
          }
        }
      }
    }

    const minecraftVersion = context.toolchain.minecraftVersion;
    if (minecraftVersion !== undefined) {
      const artifactsAvailable = await context.services.minecraft.versionExists(minecraftVersion);
      if (!artifactsAvailable) {
        if (context.options.offline) {
          warnings.push(
            `Minecraft ${minecraftVersion} version metadata is not present in the cache; offline mode prevents fetching it. The delegated build will use its own configured sources.`,
          );
        } else {
          warnings.push(
            `Minecraft ${minecraftVersion} was not found in the Mojang version manifest. The delegated build system will resolve its own Minecraft artifact.`,
          );
        }
      }
    }

    return { artifacts, diagnostics, warnings };
  },
};

function fatal(id: string, summary: string): NonNullable<StageResult['diagnostics']> {
  return [
    {
      id,
      severity: 'error',
      title: 'Pipeline',
      summary,
      stage: 'PREPARE',
      suggestions: [],
      evidence: [],
      rawMessages: [],
    },
  ];
}

export function gradleArgumentsFor(context: BuildContext, extra: string[] = []): string[] {
  return [...(context.loaderPlan?.gradleArguments ?? []), ...extra];
}