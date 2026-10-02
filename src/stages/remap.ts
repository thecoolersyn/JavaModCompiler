import path from 'node:path';
import type { BuildContext, Stage, StageResult } from '../core/types.js';
import { executeGradleTasks } from './delegate.js';
import { defaultFileSystem } from '../platform/fs.js';
import { extractArchive } from '../net/archive.js';

export const remapStage: Stage = {
  id: 'REMAP',
  label: 'Remapping',
  async run(context: BuildContext): Promise<StageResult> {
    const plan = context.loaderPlan;
    if (plan === undefined) return { skipped: true };
    const remapTask = plan.remapTask;
    if (remapTask === undefined) {
      return {
        skipped: true,
        warnings: [
          'The delegated build system owns mapping and remapping for this toolchain, so no separate JMC remap task applies',
        ],
      };
    }
    const execution = await executeGradleTasks({ context, plan, tasks: [remapTask], stage: 'REMAP' });
    if (!execution.succeeded) return { diagnostics: execution.diagnostics };
    const artifacts = collectRemapArtifacts(context);
    return { diagnostics: execution.diagnostics, artifacts };
  },
};

export function collectRemapArtifacts(context: BuildContext): string[] {
  const fs = defaultFileSystem;
  const collected: string[] = [];
  for (const root of buildLibraryDirectories(context)) {
    for (const jar of fs.listJars(root, 4)) {
      const base = path.basename(jar).toLowerCase();
      if (/-sources|-javadoc|-dev\.jar$/.test(base)) continue;
      if (collected.includes(jar)) continue;
      collected.push(jar);
    }
  }
  return collected;
}

export function buildLibraryDirectories(context: BuildContext): string[] {
  const fs = defaultFileSystem;
  const candidates = [
    context.workspace.readonly.dir('project', 'build', 'libs'),
    context.workspace.readonly.dir('project', 'build', 'devlibs'),
    context.workspace.readonly.dir('project', 'build', 'distributions'),
  ];
  if (context.project !== undefined) {
    candidates.push(path.join(context.project.root, 'build', 'libs'));
    candidates.push(path.join(context.project.root, 'build', 'devlibs'));
  }
  candidates.push(context.workspace.output.path);
  return candidates.filter((candidate) => fs.isDirectory(candidate));
}

export async function unpackMappingsArchive(archivePath: string, destination: string): Promise<string[]> {
  const fs = defaultFileSystem;
  await extractArchive(archivePath, destination);
  return fs.findFiles(destination, () => true, 8).map((relative) => path.join(destination, relative));
}