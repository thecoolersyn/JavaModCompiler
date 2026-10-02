import fs from 'node:fs';
import path from 'node:path';
import type { BuildContext, Stage, StageResult } from '../core/types.js';
import { executeGradleTasks, stageProjectCopy } from './delegate.js';

export const compileStage: Stage = {
  id: 'COMPILE',
  label: 'Compilation',
  async run(context: BuildContext): Promise<StageResult> {
    const plan = context.loaderPlan;
    if (plan === undefined) return { skipped: true, warnings: ['No loader plan was created for this project'] };
    const project = context.project;
    if (project === undefined) return { skipped: true, warnings: ['Project detection did not complete'] };
    if (project.buildSystem === 'gradle') {
      await stageProjectCopy(context);
      const task = plan.compileTask ?? plan.buildTasks[0];
      if (task === undefined) return { skipped: true, warnings: ['The loader plan selected no compilation task'] };
      const execution = await executeGradleTasks({ context, plan, tasks: [task], stage: 'COMPILE' });
      return { diagnostics: execution.diagnostics };
    }
    return compileWithJavac(context);
  },
};

export async function compileWithJavac(context: BuildContext): Promise<StageResult> {
  const project = context.project;
  const workspace = context.workspace.toolchain;
  if (project === undefined) return { skipped: true, warnings: ['Project detection did not complete'] };
  const javaHome = context.toolchain.javaHome;
  if (javaHome === undefined) return { skipped: true, warnings: ['No managed Java runtime is available'] };
  const javac = javaHome.split(path.sep).concat('bin', process.platform === 'win32' ? 'javac.exe' : 'javac').join(path.sep);
  if (!fs.existsSync(javac)) {
    return { skipped: true, warnings: [`javac was not found in the selected runtime at ${javac}`] };
  }
  const release = project.javaTarget ?? context.toolchain.javaMajor ?? 17;
  const sources = sourcesOf(project);
  if (sources.length === 0) return { skipped: true, warnings: ['No Java source files were found to compile'] };
  const outputDirectory = workspace.mkdir('classes');
  const sourceList = workspace.file('sources.txt');
  const classpathList = workspace.file('classpath.txt');
  fs.mkdirSync(workspace.path, { recursive: true });
  fs.writeFileSync(sourceList, sources.join('\n'), 'utf8');
  fs.writeFileSync(classpathList, context.artifacts.dependencies.join(path.delimiter), 'utf8');
  const run = await context.services.process.run(
    javac,
    [`@${sourceList}`, '-classpath', classpathList, '-d', outputDirectory, '--release', String(release), '-encoding', 'UTF-8'],
    {
      timeoutMs: 20 * 60 * 1000,
      onStdout: (chunk) => context.logger.raw(chunk),
      onStderr: (chunk) => context.logger.raw(chunk),
    },
  );
  if (run.exitCode !== 0) {
    return {
      diagnostics: context.services.diagnostics.classify({
        stage: 'COMPILE',
        rawOutput: `${run.stdout}\n${run.stderr}`,
        detectedJavaTarget: release,
        activeJavaMajor: context.toolchain.javaMajor,
        detectedMinecraft: project.minecraftVersion,
        detectedBuildSystem: 'javac',
        evidence: ['compiler: javac', `release: ${release}`],
      }),
    };
  }
  return { artifacts: [outputDirectory] };
}

function sourcesOf(project: NonNullable<BuildContext['project']>): string[] {
  const found: string[] = [];
  for (const sourceSet of project.sourceSets) {
    const stack = [sourceSet.root];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      let entries: import('node:fs').Dirent[];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.isFile() && entry.name.endsWith('.java')) found.push(full);
      }
    }
  }
  return found.sort();
}