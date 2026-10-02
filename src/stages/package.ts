import crypto from 'node:crypto';
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
      const devOnly = all.filter((candidate) => isDevelopmentArtifact(candidate));
      const docOnly = all.filter((candidate) => isDocumentationArtifact(candidate));
      const unusable = devOnly.length > 0 ? devOnly : docOnly;
      return {
        diagnostics: [
          {
            id: unusable.length === 0 ? 'no-artifact-produced' : 'only-dev-artifact-produced',
            severity: 'error',
            title: 'Packaging',
            summary:
              unusable.length === 0
                ? 'The delegated build produced no JAR artifact to publish'
                : devOnly.length > 0
                  ? 'The delegated build produced only a development JAR, which is not remapped for distribution'
                  : 'The delegated build produced only sources or javadoc JARs, which cannot be published',
            stage: 'PACKAGE',
            detected: [...buildLibraryDirectories(context)],
            cause:
              unusable.length === 0
                ? 'After running the packaging task, no build output directory contained a JAR file.'
                : devOnly.length > 0
                  ? `Only development artifacts were produced: ${devOnly.map((entry) => path.basename(entry)).join(', ')}. A remapping loader must run its remap task before packaging.`
                  : `Only documentation artifacts were produced: ${docOnly.map((entry) => path.basename(entry)).join(', ')}. Neither contains the mappings the loader applies.`,
            suggestions:
              unusable.length === 0
                ? [
                    'Check the build log for the packaging task output path.',
                    'Confirm the project declares an artifact-producing task such as jar, shadowJar or remapJar.',
                  ]
                : devOnly.length > 0
                  ? [
                      'Run the remap task (remapJar, buildAndRemapJar, reobfJar) so the loader produces a production JAR.',
                      'Check the build log for the remap task: it may have been skipped or failed while the dev JAR was still written.',
                    ]
                  : ['Run the production packaging task so the loader writes the remapped JAR alongside the sources JAR.'],
            evidence: unusable.map((entry) => path.basename(entry)),
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

const DEV_TOKEN = '(?:dev|dev-jar|unmapped|nonremapped|unremapped)';
const DEV_CLASSIFIER = new RegExp(`-${DEV_TOKEN}\\.jar$`, 'i');
const DEV_DOC_CLASSIFIER = new RegExp(`-${DEV_TOKEN}-(?:sources|javadoc)\\.jar$`, 'i');
const DOC_CLASSIFIER = /-(?:sources|javadoc)\.jar$/i;

export function isDevelopmentArtifact(candidate: string): boolean {
  return DEV_CLASSIFIER.test(candidate) || DEV_DOC_CLASSIFIER.test(candidate);
}

export function isDocumentationArtifact(candidate: string): boolean {
  return DOC_CLASSIFIER.test(candidate);
}

export function isDevArtifact(candidate: string): boolean {
  return isDevelopmentArtifact(candidate) || isDocumentationArtifact(candidate);
}

export function isPublishableCandidate(candidate: string): boolean {
  return isDevArtifact(candidate) === false;
}

export function gatherCandidates(context: BuildContext): string[] {
  return gatherAllCandidates(context).filter(isPublishableCandidate);
}

function developmentSiblingFor(chosen: string, all: string[]): string | undefined {
  const base = path.basename(chosen).replace(/\.jar$/i, '');
  return all.find((entry) => {
    if (isDevelopmentArtifact(entry) === false) return false;
    const other = path.basename(entry).replace(/\.jar$/i, '');
    if (other === base) return false;
    if (other.startsWith(`${base}-`)) return true;
    return base.startsWith(`${other}-`);
  });
}

export function assertRemappedArtifact(
  chosen: string,
  all: string[],
  context: BuildContext,
): Diagnostic | undefined {
  if (isDevelopmentArtifact(chosen)) {
    return {
      id: 'unmapped-artifact-selected',
      severity: 'error',
      title: 'Packaging',
      summary: `The selected artifact ${path.basename(chosen)} is a development JAR`,
      stage: 'PACKAGE',
      cause: 'A remapping loader such as Loom produces both a development JAR and a production JAR; the development JAR is not usable outside the development environment.',
      suggestions: [
        'Select the production artifact: it is the JAR produced by the remap task rather than the dev JAR.',
        'Check whether the remap task ran; the dev JAR is written even when remapping is skipped.',
      ],
      evidence: [path.basename(chosen), ...all.map((entry) => path.basename(entry))],
      rawMessages: [],
    };
  }
  if (isDocumentationArtifact(chosen)) {
    return {
      id: 'documentation-artifact-selected',
      severity: 'error',
      title: 'Packaging',
      summary: `The selected artifact ${path.basename(chosen)} is a sources or javadoc JAR`,
      stage: 'PACKAGE',
      cause: 'Sources and javadoc JARs document the code but do not contain the mappings applied by the loader, so they cannot be published as the mod artifact.',
      suggestions: ['Select the production JAR that the remap task produced.'],
      evidence: [path.basename(chosen), ...all.map((entry) => path.basename(entry))],
      rawMessages: [],
    };
  }
  const plan = context.loaderPlan;
  if (plan === undefined) return undefined;
  const remapTask = plan.remapTask;
  if (remapTask === undefined) return undefined;
  const sibling = developmentSiblingFor(chosen, all);
  if (sibling === undefined) return undefined;
  if (isIdenticalArtifact(chosen, sibling)) {
    return {
      id: 'remapped-artifact-expected',
      severity: 'error',
      title: 'Packaging',
      summary: `The loader wrote ${path.basename(chosen)} and ${path.basename(sibling)} with identical contents, so remapping did not run`,
      stage: 'PACKAGE',
      cause: `A remapping loader ran its remap task (${remapTask}) and produced a development JAR whose contents are identical to the selected artifact. The remap task wrote the same classes again instead of applying production mappings.`,
      suggestions: [
        'Check the build log for the remap task: it may have been skipped, up-to-date, or failed silently.',
        'Run a clean build so the remap task cannot be skipped as up-to-date.',
      ],
      evidence: [`remap task: ${remapTask}`, `selected: ${path.basename(chosen)}`, `development: ${path.basename(sibling)}`],
      rawMessages: [],
    };
  }
  return undefined;
}

function isIdenticalArtifact(left: string, right: string): boolean {
  const fs = defaultFileSystem;
  if (fs.isFile(left) === false || fs.isFile(right) === false) return false;
  if (fs.stat(left).size !== fs.stat(right).size) return false;
  return sha256(fs.readBytes(left)) === sha256(fs.readBytes(right));
}

function sha256(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

const PREFERRED_PATTERNS = [
  /-shaded\.jar$/i,
  /-all\.jar$/i,
  /-mapped[^/]*\.jar$/i,
  /-reobf[^/]*\.jar$/i,
  /-remapped\.jar$/i,
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
      if (pattern.test(base)) score += 10;
    }
    if (isDocumentationArtifact(candidate)) score -= 100;
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