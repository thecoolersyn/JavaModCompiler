import path from 'node:path';
import type { BuildContext, Stage, StageResult } from '../core/types.js';
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

    const candidates = gatherCandidates(context);
    if (candidates.length === 0) {
      return {
        diagnostics: [
          {
            id: 'no-artifact-produced',
            severity: 'error',
            title: 'Packaging',
            summary: 'The delegated build produced no JAR artifact to publish',
            stage: 'PACKAGE',
            detected: [...buildLibraryDirectories(context)],
            cause: 'After running the packaging task, no build output directory contained a JAR file.',
            suggestions: [
              'Check the build log for the packaging task output path.',
              'Confirm the project declares an artifact-producing task such as jar, shadowJar or remapJar.',
            ],
            evidence: [],
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

export function gatherCandidates(context: BuildContext): string[] {
  const fs = defaultFileSystem;
  const seen = new Set<string>();
  for (const root of buildLibraryDirectories(context)) {
    for (const jar of fs.listJars(root, 4)) {
      const base = path.basename(jar).toLowerCase();
      if (/-sources\.jar$|-javadoc\.jar$|-dev\.jar$/.test(base)) continue;
      seen.add(jar);
    }
  }
  return [...seen].sort();
}

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