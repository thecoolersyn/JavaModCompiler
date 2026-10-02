import path from 'node:path';
import type { BuildContext, Diagnostic, Stage, StageResult, ValidationReport } from '../core/types.js';
import { analyzeBytecode, checkJarIntegrity, checkMetadata } from '../validate/bytecode.js';
import { validateMixins } from '../validate/mixin.js';
import { validateClientServerSides } from '../validate/sides.js';
import { classFileMajorToJavaMajor, javaVersionToClassFileMajor } from '../bytecode/class-file.js';

export const validateStage: Stage = {
  id: 'VALIDATE',
  label: 'Static Validation',
  async run(context: BuildContext): Promise<StageResult> {
    const artifactPath = context.finalArtifact;
    const report = await runStaticValidation(context, artifactPath);
    const errors = report.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
    const warnings = report.diagnostics.filter((diagnostic) => diagnostic.severity === 'warning');
    for (const diagnostic of warnings) {
      context.logger.debug(`${diagnostic.title}: ${diagnostic.summary}`, 'VALIDATE');
    }
    return {
      diagnostics: report.diagnostics,
      warnings: warnings.map((diagnostic) => `${diagnostic.title}: ${diagnostic.summary}`),
      artifacts: [],
      ...(errors.length > 0 ? {} : {}),
    };
  },
};

export interface ValidationOutcome {
  report: ValidationReport;
  ok: boolean;
}

export async function runStaticValidation(context: BuildContext, artifactPath: string | undefined): Promise<ValidationReport> {
  const checks: ValidationReport['checks'] = [];
  const diagnostics: Diagnostic[] = [];
  if (artifactPath === undefined) {
    return {
      checks: [{ id: 'artifact', label: 'Artifact', status: 'failed', detail: ['No artifact was produced'] }],
      diagnostics: [
        {
          id: 'validation-no-artifact',
          severity: 'error',
          title: 'Validation',
          summary: 'Static validation could not run because no artifact was produced',
          stage: 'VALIDATE',
          suggestions: ['Inspect the packaging stage output.'],
          evidence: [],
          rawMessages: [],
        },
      ],
    };
  }

  const runtimeMajor = context.toolchain.javaMajor;
  const bytecode = analyzeBytecode({
    jarPath: artifactPath,
    maxSupportedMajor: runtimeMajor === undefined ? undefined : javaVersionToClassFileMajor(runtimeMajor),
  });
  diagnostics.push(...bytecode.diagnostics);
  checks.push({
    id: 'bytecode',
    label: 'Bytecode',
    status: bytecode.parseFailures.length > 0 ? 'failed' : bytecode.tooNew.length > 0 ? 'failed' : 'pass',
    detail: [
      `classes: ${bytecode.classes}`,
      `class file versions: ${bytecode.minMajor}..${bytecode.maxMajor}`,
      `parse failures: ${bytecode.parseFailures.length}`,
      `classes newer than the selected runtime allows: ${bytecode.tooNew.length}`,
    ],
  });

  const integrity = checkJarIntegrity(artifactPath);
  diagnostics.push(...integrity.diagnostics);
  checks.push({
    id: 'jar-integrity',
    label: 'JAR Integrity',
    status: integrity.ok ? 'pass' : 'failed',
    detail: [
      `entries: ${integrity.entryCount}`,
      `manifest present: ${integrity.hasManifest}`,
      `crc failures: ${integrity.crcFailures.length}`,
      `unsafe entries: ${integrity.suspiciousEntries.length}`,
    ],
  });

  const metadata = checkMetadata(artifactPath);
  diagnostics.push(...metadata.diagnostics);
  checks.push({
    id: 'metadata',
    label: 'Metadata',
    status: metadata.diagnostics.some((diagnostic) => diagnostic.severity === 'error') ? 'failed' : 'pass',
    detail: [
      `loader metadata: ${metadata.loaderDetected ?? 'none detected'}`,
      `fabric.mod.json: ${metadata.fabricModJson === undefined ? 'absent' : 'present'}`,
      `mods.toml: ${metadata.modsToml === undefined ? 'absent' : 'present'}`,
      `manifest attributes: ${metadata.manifest === undefined ? 'none' : Object.keys(metadata.manifest).length}`,
    ],
  });

  const mixin = validateMixins({
    jarPath: artifactPath,
    mappingNamespace: context.mappingsDescriptor?.targetNamespace,
    expectedEnvironment: 'both',
  });
  diagnostics.push(...mixin.diagnostics);
  checks.push({
    id: 'mixins',
    label: 'Static Mixin Validation',
    status: mixin.passed ? 'pass' : 'failed',
    detail: [
      `configurations: ${mixin.configs.length}`,
      `declared targets: ${mixin.targets.length}`,
      `missing mixin classes: ${mixin.missingMixinClasses.length}`,
      `refmaps declared: ${mixin.refmapPresence.length}`,
      'runtime mixin behavior was not executed',
    ],
  });

  const sides = validateClientServerSides({
    jarPath: artifactPath,
    clientSourcePrefixes: ['net/minecraft/client/'],
    serverSourcePrefixes: ['net/minecraftforge/server/'],
    expectDedicatedServer: true,
  });
  diagnostics.push(...sides.diagnostics);
  checks.push({
    id: 'client-server',
    label: 'Client/Server Validation',
    status: sides.clientOnlyReferencedByServer.length > 0 ? 'failed' : 'pass',
    detail: [
      `classes classified: ${sides.classifications.size}`,
      `client-only references from server code: ${sides.clientOnlyReferencedByServer.length}`,
      `client entry points: ${sides.detectedEntryPoints.client.length}`,
      `server entry points: ${sides.detectedEntryPoints.server.length}`,
    ],
  });

  const dependencyConflicts = detectDependencyConflicts(context);
  checks.push({
    id: 'dependencies',
    label: 'Dependencies',
    status: dependencyConflicts.length > 0 ? 'warning' : 'pass',
    detail: dependencyConflicts.length === 0 ? ['No version conflicts detected'] : dependencyConflicts,
  });

  const loaderDiagnostics = context.loaderAdapter === undefined ? [] : await context.loaderAdapter.validate(artifactPath, context);
  diagnostics.push(...loaderDiagnostics);
  checks.push({
    id: 'loader',
    label: 'Loader Validation',
    status: loaderDiagnostics.some((diagnostic) => diagnostic.severity === 'error') ? 'failed' : 'pass',
    detail:
      context.loaderAdapter === undefined
        ? ['No loader adapter was selected']
        : [`adapter: ${context.loaderAdapter.displayName}`, ...loaderDiagnostics.map((diagnostic) => diagnostic.summary)],
  });

  const pluginDiagnostics = await context.services.loaderRegistry.validatorsFor({ artifactPath, buildContext: context });
  diagnostics.push(...pluginDiagnostics);
  if (context.services.loaderRegistry.listPlugins().length > 0) {
    checks.push({
      id: 'plugins',
      label: 'Plugin Validators',
      status: pluginDiagnostics.some((diagnostic) => diagnostic.severity === 'error') ? 'failed' : 'pass',
      detail: context.services.loaderRegistry.listPlugins().map((plugin) => `${plugin.id}@${plugin.version}`),
    });
  }

  const remappingDiagnostics = checkRemapping(context, artifactPath);
  diagnostics.push(...remappingDiagnostics);
  checks.push({
    id: 'remapping',
    label: 'Remapping',
    status: remappingDiagnostics.some((diagnostic) => diagnostic.severity === 'error') ? 'failed' : 'pass',
    detail:
      context.mappingsDescriptor === undefined
        ? ['No mappings were supplied; the project toolchain performed its own remapping']
        : [
            `format: ${context.mappingsDescriptor.format}`,
            `namespaces: ${context.mappingsDescriptor.namespaces.map((namespace) => namespace.name).join(', ')}`,
            ...(context.mappingCompatibility === undefined ? [] : context.mappingCompatibility.findings.filter((finding) => finding.severity !== 'info').map((finding) => finding.message)),
          ],
  });

  return { checks, diagnostics };
}

function detectDependencyConflicts(context: BuildContext): string[] {
  const resolution = context.dependencies;
  if (resolution === undefined) return [];
  const conflicts: string[] = [];
  const seen = new Map<string, Set<string>>();
  const walk = (nodes: typeof resolution.roots): void => {
    for (const node of nodes) {
      const key = `${node.coordinate.groupId}:${node.coordinate.artifactId}`;
      const versions = seen.get(key) ?? new Set<string>();
      versions.add(node.coordinate.version);
      seen.set(key, versions);
      walk(node.children);
    }
  };
  walk(resolution.roots);
  for (const [key, versions] of seen) {
    if (versions.size > 1) conflicts.push(`${key} resolved to multiple versions: ${[...versions].join(', ')}`);
  }
  return conflicts;
}

function checkRemapping(context: BuildContext, artifactPath: string): Diagnostic[] {
  const descriptor = context.mappingsDescriptor;
  if (descriptor === undefined) return [];
  const compatibility = context.mappingCompatibility;
  if (compatibility === undefined) return [];
  const errors = compatibility.findings.filter((finding) => finding.severity === 'error' && finding.id.includes('minecraft'));
  return errors.map((finding) => ({
    id: `remap-${finding.id}`,
    severity: 'error' as const,
    title: 'Remapping Integrity',
    summary: finding.message,
    stage: 'REMAP' as const,
    expected: finding.expected,
    suggestions: ['Rebuild with mappings that correspond to the resolved Minecraft version.'],
    evidence: finding.evidence ?? [`artifact: ${path.basename(artifactPath)}`],
    rawMessages: [],
  }));
}