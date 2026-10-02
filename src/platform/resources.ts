export interface DiskSpace {
  totalBytes: number;
  freeBytes: number;
}

export interface ResourceBudget {
  cpuCount: number;
  totalMemoryBytes: number;
  freeMemoryBytes: number;
  gradleMaxHeapBytes: number;
  compilerMaxHeapBytes: number;
  downloadConcurrency: number;
  maxParallelOperations: number;
}

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function computeResourceBudget(
  cpuCount: number,
  totalMemoryBytes: number,
  freeMemoryBytes: number,
  env: NodeJS.ProcessEnv = process.env,
): ResourceBudget {
  const overrideHeap = env.JMC_GRADLE_MAX_HEAP ? parseSize(env.JMC_GRADLE_MAX_HEAP) : undefined;
  const gradleMaxHeap =
    overrideHeap ?? clamp(Math.floor(totalMemoryBytes * 0.35), 512 * MIB, 4 * GIB);
  const compilerMaxHeap = clamp(Math.floor(totalMemoryBytes * 0.25), 256 * MIB, 2 * GIB);
  const concurrencyBase = clamp(Math.floor(cpuCount / 2), 2, 8);
  const freeLimited = clamp(Math.floor(freeMemoryBytes / (512 * MIB)), 1, 8);
  return {
    cpuCount,
    totalMemoryBytes,
    freeMemoryBytes,
    gradleMaxHeapBytes: gradleMaxHeap,
    compilerMaxHeapBytes: compilerMaxHeap,
    downloadConcurrency: freeLimited < 2 ? 2 : concurrencyBase,
    maxParallelOperations: clamp(Math.floor(cpuCount / 2), 1, 4),
  };
}

export function parseSize(input: string): number {
  const match = /^\s*(\d+(?:\.\d+)?)\s*([kmgt]?i?b?)\s*$/i.exec(input);
  if (match === null) throw new Error(`Unparsable size value: ${input}`);
  const amount = Number.parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  const multipliers: Record<string, number> = {
    '': 1,
    b: 1,
    k: 1000,
    kb: 1000,
    kib: 1024,
    m: 1000 ** 2,
    mb: 1000 ** 2,
    mib: MIB,
    g: 1000 ** 3,
    gb: 1000 ** 3,
    gib: GIB,
    t: 1000 ** 4,
    tb: 1000 ** 4,
    tib: 1024 * GIB,
  };
  const multiplier = multipliers[unit];
  if (multiplier === undefined) throw new Error(`Unparsable size unit: ${unit}`);
  return Math.floor(amount * multiplier);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[index]}`;
}