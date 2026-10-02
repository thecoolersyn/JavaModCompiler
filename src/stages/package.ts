import path from 'node:path';
import type { BuildContext, Diagnostic, Stage, StageResult } from '../core/types.js';
import { executeGradleTasks } from './delegate.js';
import { defaultFileSystem } from '../platform/fs.js';
import { buildLibraryDirectories } from './remap.js';

export const packageStage: Stage = {
  id: 'PACKAGE',
  label: 'Packaging',
  async run(context: BuildContext): Promise<StageResult> {
    const plan = context.loaderPlan;
    const project = context.project;
    if (plan === undefined || project === undefined) return { skipped: true, warnings: ['No loader plan is available'] };

    if (project.buildSystem === 'gradle') {
      const jarTask = plan.jarTask ?? plan.buildTasks[0];
      if (jarTask === undefined) return { skipped: true, warnings: ['No packaging task was selected'] };
      const execution = await executeGradleTasks({ context, plan, tasks: [jarTask], stage: 'PACKAGE' });
      if (!execution.succeeded) return { diagnostics: execution.diagnostics };
    }

    const all = gatherAllCandidates(context);
    const candidates = all.filter((candidate) => isPublishableCandidate(candidate));
    if (candidates.length === 0) {
      const devOnly = all.filter((candidate) => isDevArtifact(candidate));
      return {
        diagnostics: [
          {
            id: devOnly.length > 0 ? 'only-dev-artifact-produced' : 'no-artifact-produced',
            severity: 'error',
            title: 'Packaging',
            summary:
              devOnly.length > 0
                ? 'The delegated build produced only a development JAR, which is not remapped for distribution'
                : 'The delegated build produced no JAR artifact to publish',
            stage: 'PACKAGE',
            detected: [...buildLibraryDirectories(context)],
            cause:
              devOnly.length > 0
                ? `Only unmapped development artifacts were produced: ${devOnly.map((entry) => path.basename(entry)).join(', ')}. A remapping loader must run its remap task before packaging.`
                : 'After running the packaging task, no build output directory contained a JAR file.',
            suggestions:
              devOnly.length > 0
                ? [
                    'Run the remap task (remapJar, buildAndRemapJar, reobfJar) so the loader produces a production-mapped JAR.',
                    'Check the build log for the remap task: it may have been skipped or failed while the dev JAR was still written.',
                  ]
                : [
                    'Check the build log for the packaging task output path.',
                    'Confirm the project declares an artifact-producing task such as jar, shadowJar or remapJar.',
                  ],
            evidence: devOnly.map((entry) => path.basename(entry)),
            rawMessages: [],
          },
        ],
      };
    }

    const selected = context.loaderAdapter instanceof Object && 'selectArtifact' in context.loaderAdapter
      ? (context.loaderAdapter as { selectArtifact(candidates: string[], project: unknown): string | undefined }).selectArtifact(
          candidates,
          project,
        )
      : undefined;
    const chosen = selected ?? pickBestCandidate(candidates, context);
    const remapCheck = assertRemappedArtifact(chosen, all, context);
    if (remapCheck !== undefined) return { diagnostics: [remapCheck] };

    const destination = path.resolve(context.options.projectRoot, context.options.outputPath);
    defaultFileSystem.ensureDir(path.dirname(destination));
    defaultFileSystem.copy(chosen, destination);
    context.finalArtifact = destination;
    context.artifacts.final = destination;
    context.artifacts.packaged.push(destination);

    const size = defaultFileSystem.stat(destination).size;
    context.logger.debug(`Packaged ${path.basename(destination)} (${size} bytes) from ${path.basename(chosen)}`, 'PACKAGE');
    return { artifacts: [destination] };
  },
};

export function gatherAllCandidates(context: BuildContext): string[] {
  const fs = defaultFileSystem;
  const seen = new Set<string>();
  for (const root of buildLibraryDirectories(context)) {
    for (const jar of fs.listJars(root, 4)) seen.add(jar);
  }
  return [...seen].sort();
}

export function isDevArtifact(candidate: string): boolean {
  return /-(?:dev|dev-jar|unmapped|nonremapped|unremapped)\.jar$/i.test(candidate) || /-sources\.jar$|-javadoc\.jar$/i.test(candidate);
}

export function isPublishableCandidate(candidate: string): boolean {
  return /-(?:dev|dev-jar|unmapped|nonremapped|unremapped)\.jar$/i.test(candidate) === false;
}

export function gatherCandidates(context: BuildContext): string[] {
  return gatherAllCandidates(context).filter(isPublishableCandidate);
}

export function assertRemappedArtifact(
  chosen: string,
  all: string[],
  context: BuildContext,
): Diagnostic | undefined {
  if (isDevArtifact(chosen)) {
    return {
      id: 'unmapped-artifact-selected',
      severity: 'error',
      title: 'Packaging',
      summary: `The selected artifact ${path.basename(chosen)} is an unmapped development JAR`,
      stage: 'PACKAGE',
      cause: 'A remapping loader such as Loom produces both a development JAR and a remapped JAR; the development JAR is not usable outside the development environment.',
      suggestions: [
        'Select the remapped artifact: it is the JAR produced by the remap task rather than the dev JAR.',
        'Check whether the remap task ran; the dev JAR is written even when remapping is skipped.',
      ],
      evidence: [path.basename(chosen), ...all.map((entry) => path.basename(entry))],
      rawMessages: [],
    };
  }
  const plan = context.loaderPlan;
  if (plan === undefined) return undefined;
  const remapTask = plan.remapTask;
  if (remapTask === undefined) return undefined;
  const devJars = all.filter(isDevArtifact).filter((entry) => !/-sources\.jar$|-javadoc\.jar$/i.test(entry));
  if (devJars.length === 0) return undefined;
  if (looksRemapped(chosen)) return undefined;
  return {
    id: 'remapped-artifact-expected',
    severity: 'error',
    title: 'Packaging',
    summary: `The loader produced a development JAR alongside the selected artifact, but ${path.basename(chosen)} is not the remapped output`,
    stage: 'PACKAGE',
    cause: `A remapping loader ran its remap task (${remapTask}) and wrote a dev JAR; the artifact JMC selected does not look like a remapped output, so the production mappings may not be applied.`,
    suggestions: [
      'Confirm the packaging task ran after the remap task so the remapped JAR overwrites or accompanies the dev JAR.',
      'Inspect the build log to see which artifact the remap task wrote.',
    ],
    evidence: [`remap task: ${remapTask}`, `selected: ${path.basename(chosen)}`, ...all.map((entry) => path.basename(entry))],
    rawMessages: [],
  };
}

export function looksRemapped(candidate: string): boolean {
  const base = path.basename(candidate).replace(/\.jar$/, '');
  return REMAPPED_PATTERN.test(base);
}

const REMAPPED_PATTERN = /-remapped$|-mapped[^/]*$|-deobf[^/]*$|-reobf[^/]*$|-production$|-release$/i;

const PREFERRED_PATTERNS = [
  /-remapped\.jar$/i,
  /-mapped[^/]*\.jar$/i,
  /-deobf[^/]*\.jar$/i,
  /-shaded\.jar$/i,
  /-all\.jar$/i,
];

export function pickBestCandidate(candidates: string[], context: BuildContext): string {
  const expectedBase = expectedBaseName(context);
  let best = candidates[0] as string;
  let bestScore = -Infinity;
  for (const candidate of candidates) {
    let score = 0;
    const base = path.basename(candidate).replace(/\.jar$/, '');
    if (base === expectedBase) score += 100;
    else if (base.includes(expectedBase)) score += 40;
    for (const pattern of PREFERRED_PATTERNS) {
      if (pattern.test(base)) score += 30;
    }
    if (/-sources$|-javadoc$|-dev$/.test(base)) score -= 100;
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}

export function expectedBaseName(context: BuildContext): string {
  const project = context.project;
  if (project === undefined) return 'artifact';
  const properties = project.gradle?.properties ?? {};
  for (const key of ['archivesBaseName', 'modId', 'rootProject.name', 'rootProject.name ']) {
    const value = properties[key];
    if (value !== undefined && value.trim().length > 0) return value.trim();
  }
  const metadata = project.modMetadata[0];
  if (metadata?.modId !== undefined) return metadata.modId;
  return project.name;
}