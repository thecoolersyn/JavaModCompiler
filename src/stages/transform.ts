import type { BuildContext, Stage, StageResult } from '../core/types.js';
import { executeGradleTasks } from './delegate.js';
import { defaultFileSystem } from '../platform/fs.js';
import { buildLibraryDirectories } from './remap.js';

export const transformStage: Stage = {
  id: 'TRANSFORM',
  label: 'Transformation',
  async run(context: BuildContext): Promise<StageResult> {
    const plan = context.loaderPlan;
    if (plan === undefined) return { skipped: true };
    const adapterPlan = context.loaderAdapter;
    const declared = context.project?.gradle?.tasksOfInterest ?? [];
    const transformationTasks = loaderTransformTasks(adapterPlan?.id ?? plan.adapterId).filter((task) =>
      declared.includes(task),
    );
    if (transformationTasks.length === 0) {
      return {
        skipped: true,
        warnings: [
        'The selected toolchain performs transformation inside its own compile task; the project declares no standalone transformation task',
      ],
      };
    }
    const execution = await executeGradleTasks({ context, plan, tasks: transformationTasks, stage: 'TRANSFORM' });
    if (!execution.succeeded) return { diagnostics: execution.diagnostics };
    const outputRoots = buildLibraryDirectories(context);
    const generated: string[] = [];
    for (const root of outputRoots) {
      for (const jar of defaultFileSystem.listJars(root, 4)) generated.push(jar);
    }
    return { diagnostics: execution.diagnostics, artifacts: generated };
  },
};

export function loaderTransformTasks(adapterId: string): string[] {
  switch (adapterId) {
    case 'fabric':
      return ['genSources'];
    case 'quilt':
      return ['genSources'];
    case 'forge':
      return ['patchClasses'];
    case 'neoforge':
      return ['patchClasses'];
    default:
      return [];
  }
}