import path from 'node:path';
import type { BuildContext, Diagnostic, Stage, StageResult } from '../core/types.js';
import { defaultFileSystem } from '../platform/fs.js';
import { GradleDistributionVerificationError, javaRequiredForGradleVersion } from '../gradle/manager.js';
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

    const ruleJava = project.gradle === undefined ? undefined : context.services.gradle.selectVersion(project.gradle).javaMajor;
    const requestedJava = context.options.javaOverride ?? ruleJava ?? project.javaTarget ?? javaBaselineForVersion(context.toolchain.minecraftVersion ?? '1.20.1');
    const javaRequirement: { minMajor: number; maxMajor?: number } = { minMajor: requestedJava };
    if (context.options.javaOverride === undefined) {
      const cap = javaCapForProject(project, ruleJava);
      if (cap !== undefined) javaRequirement.maxMajor = cap;
    }
    context.toolchain.javaMajor = javaRequirement.minMajor;
    let installation;
    try {
      installation = await context.services.java.resolve(javaRequirement);
    } catch (error) {
      diagnostics.push({
        id: 'java-unavailable',
        severity: 'error',
        title: 'JDK Provisioning',
        summary: `No Java ${javaRequirement.minMajor} runtime is available for this build`,
        stage: 'PREPARE',
        expected: `Java ${javaRequirement.minMajor}${javaRequirement.maxMajor === undefined ? ' or newer' : ` (capped at Java ${javaRequirement.maxMajor})`}`,
        cause: error instanceof Error ? error.message : String(error),
        suggestions: [
          `Run with --java ${javaRequirement.minMajor} so JMC provisions a managed JDK.`,
          'Check whether the requested Java version is published for this platform and architecture.',
          'Remove --java to let JMC derive the required Java version from the project build configuration.',
        ],
        evidence: [error instanceof Error ? error.message : String(error)],
        rawMessages: [error instanceof Error ? error.message : String(error)],
      });
      return { artifacts, diagnostics, warnings };
    }
    context.toolchain.javaHome = installation.javaHome;
    context.toolchain.javaVersionText = installation.versionText;
    context.toolchain.javaVendor = installation.vendor;
    context.toolchain.notes.push(`Java ${installation.versionText} (${installation.origin})`);

    if (project.gradle !== undefined) {
      const selection = context.services.gradle.selectVersion(project.gradle);
      const gradleVersion = selection.version;
      if (selection.conflict !== undefined) {
        diagnostics.push({
          id: 'gradle-rule-conflict',
          severity: 'error',
          title: 'Gradle Version Rules',
          summary: 'No Gradle version satisfies every plugin the project applies',
          stage: 'PREPARE',
          detected: selection.conflict.plugins,
          cause: selection.conflict.detail,
          suggestions: [
            `Pin a Gradle wrapper version: run gradle wrapper --gradle-version <version> and commit ${'gradle/wrapper/gradle-wrapper.properties'}.`,
            'Align the conflicting plugins: they target different Gradle major versions.',
          ],
          evidence: [selection.reason],
          rawMessages: [selection.reason],
        });
        return { artifacts, diagnostics, warnings };
      }
      context.toolchain.notes.push(`Gradle ${gradleVersion} selected because ${selection.reason}`);
      const requiredJava = selection.javaMajor ?? javaRequiredForGradleVersion(gradleVersion);
      if (requiredJava > 0 && installation.version < requiredJava) {
        const upgrade = await context.services.java.resolve({ minMajor: requiredJava });
        context.toolchain.javaHome = upgrade.javaHome;
        context.toolchain.javaVersionText = upgrade.versionText;
        context.toolchain.javaVendor = upgrade.vendor;
        context.toolchain.javaMajor = upgrade.version;
        context.toolchain.notes.push(`Upgraded to Java ${upgrade.versionText} because Gradle ${gradleVersion} requires Java ${requiredJava}`);
      }
      let install: Awaited<ReturnType<typeof context.services.gradle.ensureDistribution>>;
      try {
        install = await context.services.gradle.ensureDistribution(gradleVersion, { projectRoot: context.options.projectRoot });
      } catch (error) {
        if (error instanceof GradleDistributionVerificationError) {
          diagnostics.push({
            id: 'gradle-checksum-mismatch',
            severity: 'error',
            title: 'Gradle Distribution Verification',
            summary: 'The Gradle distribution could not be verified against its published SHA-256 checksum',
            stage: 'PREPARE',
            detected: [error.url],
            expected: error.expected,
            actual: error.actual,
            cause: error.message,
            suggestions: [
              'Verify the distribution URL and retry once the network is available.',
              'If a proxy rewrites the download, download the archive manually and place it in the JMC Gradle cache with a matching .sha256 marker file.',
            ],
            evidence: [error.message],
            rawMessages: [error.message],
          });
          return { artifacts, diagnostics, warnings };
        }
        if (context.options.offline) {
          diagnostics.push({
            id: 'gradle-offline-missing',
            severity: 'error',
            title: 'Gradle Distribution',
            summary: `Gradle ${gradleVersion} is not in the JMC cache and offline mode prevents downloading it`,
            stage: 'PREPARE',
            detected: [context.paths.cacheGradle],
            expected: `a verified Gradle ${gradleVersion} distribution in the JMC cache`,
            cause: error instanceof Error ? error.message : String(error),
            suggestions: [
              'Re-run without --offline once so JMC can download and verify the distribution.',
              `Or point the project at an installed Gradle by adding a wrapper: run gradle wrapper --gradle-version ${gradleVersion} and commit gradle/wrapper/gradle-wrapper.properties.`,
            ],
            evidence: [error instanceof Error ? error.message : String(error)],
            rawMessages: [error instanceof Error ? error.message : String(error)],
          });
          return { artifacts, diagnostics, warnings };
        }
        throw error;
      }
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

function javaCapForProject(project: NonNullable<BuildContext['project']>, ruleJava: number | undefined): number | undefined {
  if (ruleJava !== undefined && ruleJava <= 8) return ruleJava;
  if (project.javaTarget !== undefined && ruleJava !== undefined && project.javaTarget < ruleJava) return project.javaTarget;
  return undefined;
}

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