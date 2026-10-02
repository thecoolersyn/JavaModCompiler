import path from 'node:path';
import fs from 'node:fs';
import type { BuildContext, Stage, StageResult } from '../core/types.js';
import { defaultFileSystem } from '../platform/fs.js';
import { detectProject } from '../project/detection.js';
import { MappingRegistry } from '../mappings/registry.js';
import { evaluateMappingCompatibility } from '../mappings/compatibility.js';
import { looksLikeMappingsDirectory } from '../mappings/providers.js';
import { javaBaselineForVersion, parseMinecraftVersion } from '../minecraft/version.js';
import { createBuiltinLoaders } from '../loader/builtin-adapters.js';
import { GenericGradleAdapter } from '../loader/generic-gradle.js';
import { collectBuildScripts } from '../security/approval.js';

export const discoverStage: Stage = {
  id: 'DISCOVER',
  label: 'Environment and Project',
  async run(context: BuildContext): Promise<StageResult> {
    const fs = defaultFileSystem;
    const root = context.options.projectRoot;
    const project = detectProject(root, { logger: context.logger });
    context.project = project;
    context.logger.debug(
      `Project ${project.name}: build system ${project.buildSystem}, languages ${project.languages}, loader ${project.loader.kind} (confidence ${project.loader.confidence})`,
      'DISCOVER',
    );

    const registry = context.services.loaderRegistry;
    if (registry.list().length === 0) {
      for (const adapter of createBuiltinLoaders()) registry.register(adapter);
    }

    const scripts = collectBuildScripts(root);
    if (scripts.length > 0) {
      const decision = await context.services.approvals.requireAuthorization({
        projectRoot: root,
        buildSystem: project.buildTool,
        scripts,
        warningText: ['A project build can execute build-system code on this machine.'],
      });
      context.requiresAuthorization = true;
      context.authorized = decision.allowed;
      if (!decision.allowed) {
        return {
          diagnostics: [
            {
              id: 'authorization-denied',
              severity: 'error',
              title: 'Authorization',
              summary: 'Project build script execution was not authorized',
              stage: 'DISCOVER',
              cause: decision.reason,
              suggestions: [
                'Re-run and approve when prompted, or pass --yes to authorize non-interactively.',
                'Set JMC_TRUST_PROJECT_SCRIPTS=1 to trust projects in a controlled CI environment.',
              ],
              evidence: decision.buildScripts,
              rawMessages: decision.warnings,
            },
          ],
        };
      }
      context.logger.debug(`Build script authorization granted via ${decision.source}`, 'DISCOVER');
    }

    const minecraftVersion = context.options.minecraftOverride ?? project.minecraftVersion;
    if (minecraftVersion === undefined) {
      return {
        diagnostics: [
          {
            id: 'minecraft-version-unknown',
            severity: 'error',
            title: 'Minecraft Version',
            summary: 'The Minecraft version could not be determined from the project',
            stage: 'DISCOVER',
            cause: 'No project metadata, loader metadata, dependency or mapping metadata declared a Minecraft version.',
            suggestions: ['Pass --minecraft <version> to state the target version explicitly.'],
            evidence: project.detectedIssues,
            rawMessages: [],
          },
        ],
      };
    }
    context.toolchain.minecraftVersion = minecraftVersion;
    const identity = parseMinecraftVersion(minecraftVersion);
    context.logger.debug(`Minecraft version resolved to ${minecraftVersion} (${identity.scheme}, era ${identity.era})`, 'DISCOVER');

    if (context.options.mappingsPath !== undefined) {
      const mappingsPath = resolveMappingsPath(context.options.mappingsPath, context.options.projectRoot);
      context.toolchain.mappingsPath = mappingsPath;
      if (!fs.exists(mappingsPath)) {
        return {
          diagnostics: [
            {
              id: 'mappings-path-missing',
              severity: 'error',
              title: 'Mappings',
              summary: `The mappings path does not exist: ${context.options.mappingsPath}`,
              stage: 'DISCOVER',
              cause: 'The path given as the first positional argument does not resolve to an existing file or directory.',
              suggestions: ['Check the path and re-run with the correct mappings directory or archive.'],
              evidence: [`resolved: ${mappingsPath}`],
              rawMessages: [],
            },
          ],
        };
      }
      const registryProbe = new MappingRegistry();
      const probe = await registryProbe.probeDirectory(mappingsPath);
      if (probe === undefined) {
        return {
          diagnostics: [
            {
              id: 'mappings-format-unknown',
              severity: 'error',
              title: 'Mapping Format',
              summary: 'No mapping provider could parse the supplied mappings directory',
              stage: 'DISCOVER',
              cause: 'None of the registered mapping providers recognized a mapping file in the directory.',
              suggestions: [
                'Confirm the directory contains a mapping file such as a Tiny, TSRG, SRG or ProGuard mapping.',
                'Install a MappingProvider plugin for this format under the JMC plugins directory.',
              ],
              evidence: [`path: ${mappingsPath}`],
              rawMessages: [],
            },
          ],
        };
      }
      context.mappingsDescriptor = probe.descriptor;
      context.toolchain.mappingsFormat = probe.descriptor.format;
      context.toolchain.mappingsNamespace = `${probe.descriptor.primaryNamespace} -> ${probe.descriptor.targetNamespace}`;
      for (const candidate of probe.candidates) {
        context.logger.debug(
          `Mapping candidate ${candidate.providerId}/${candidate.format}: score ${candidate.confidence}, ${candidate.classes} classes`,
          'DISCOVER',
        );
      }
    }

    if (context.mappingsDescriptor !== undefined) {
      const compatibility = evaluateMappingCompatibility({
        mappings: context.mappingsDescriptor,
        subject: {
          minecraftVersion,
          minecraftVersionSource: project.minecraftVersionSource,
          loader: project.loader.kind,
          javaMajor: context.options.javaOverride ?? project.javaTarget ?? javaBaselineForVersion(minecraftVersion),
          mappingsMinecraftVersion: context.mappingsDescriptor.minecraft.version,
        },
      });
      context.mappingCompatibility = compatibility;
    }

    const loaderResolution = registry.resolve(project, project.loader, { forced: context.options.loaderOverride });
    if (loaderResolution !== undefined) {
      context.loaderAdapter = loaderResolution.adapter;
      context.toolchain.loader = loaderResolution.profile.id;
      context.logger.debug(`Selected loader adapter ${loaderResolution.profile.displayName}`, 'DISCOVER');
    } else if (project.gradle !== undefined) {
      const generic = registry.genericFallback() ?? new GenericGradleAdapter({ preferProjectTasks: true });
      context.loaderAdapter = generic;
      context.toolchain.loader = generic.id;
      context.logger.debug(
        `No specific loader matched with sufficient confidence (best: ${project.loader.kind} at ${project.loader.confidence}); falling back to the generic Gradle adapter`,
        'DISCOVER',
      );
    }

    const javaMajor = context.options.javaOverride ?? project.javaTarget ?? javaBaselineForVersion(minecraftVersion);
    context.toolchain.javaMajor = javaMajor;

    const findings = context.mappingCompatibility?.findings.filter((finding) => finding.severity !== 'info') ?? [];

    return {
      diagnostics: findings
        .map((finding) => ({
          id: finding.id,
          severity: finding.severity === 'error' ? ('error' as const) : ('warning' as const),
          title: `Mapping ${finding.subject}`,
          summary: finding.message,
          stage: 'DISCOVER' as const,
          expected: finding.expected,
          actual: finding.actual,
          cause: finding.expected !== undefined && finding.actual !== undefined ? `expected ${finding.expected}, found ${finding.actual}` : undefined,
          suggestions:
            finding.severity === 'error'
              ? ['Point JMC at the mappings that correspond to the detected Minecraft version.']
              : ['Review the mapping metadata if this combination is not intended.'],
          evidence: finding.evidence ?? [],
          rawMessages: [],
        })),
    };
  },
};

export function resolveMappingsPath(input: string, projectRoot: string): string {
  if (path.isAbsolute(input)) return path.normalize(input);
  const candidates = [
    path.resolve(process.cwd(), input),
    path.resolve(projectRoot, input),
    path.resolve(projectRoot, 'mappings', input),
    path.resolve(projectRoot, path.basename(input)),
  ];
  for (const candidate of candidates) {
    if (defaultFileSystem.exists(candidate)) return candidate;
  }
  return candidates[0] as string;
}

export function mappingsPathLooksValid(target: string): boolean {
  if (defaultFileSystem.exists(target)) return true;
  return looksLikeMappingsDirectory(target);
}

export function readFirstLine(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf8').split('\n')[0] ?? '';
  } catch {
    return '';
  }
}