import { emptyEntryCounts, type MappingDescriptor, type MappingFormat, type MappingProvider } from './types.js';
import {
  MojangMappingProvider,
  ParchmentMappingProvider,
  ProguardMappingProvider,
  TinyMappingProvider,
  TsrgMappingProvider,
  detectFormatFromExtension,
} from './providers.js';

export interface MappingsProbeResult {
  descriptor: MappingDescriptor;
  candidates: Array<{ providerId: string; format: MappingFormat; confidence: number; classes: number }>;
  rejected: Array<{ providerId: string; format: MappingFormat; reason: string }>;
}

export class MappingRegistry {
  private readonly providers: MappingProvider[];

  constructor(providers?: MappingProvider[]) {
    this.providers = providers ?? [
      new TinyMappingProvider(),
      new TsrgMappingProvider(),
      new ProguardMappingProvider(),
      new MojangMappingProvider(),
      new ParchmentMappingProvider(),
    ];
  }

  register(provider: MappingProvider): void {
    this.providers.unshift(provider);
  }

  listProviders(): MappingProvider[] {
    return this.providers.slice();
  }

  async probeDirectory(directory: string): Promise<MappingsProbeResult | undefined> {
    const candidates: MappingsProbeResult['candidates'] = [];
    const rejected: MappingsProbeResult['rejected'] = [];
    let best: MappingDescriptor | undefined;
    for (const provider of this.providers) {
      let descriptor: MappingDescriptor | undefined;
      try {
        descriptor = await provider.probe(directory);
      } catch (error) {
        rejected.push({
          providerId: provider.descriptor.id,
          format: 'unknown',
          reason: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      if (descriptor === undefined) continue;
      candidates.push({
        providerId: provider.descriptor.id,
        format: descriptor.format,
        confidence: scoreDescriptor(descriptor),
        classes: descriptor.entryCounts.classes,
      });
      if (best === undefined || scoreDescriptor(descriptor) > scoreDescriptor(best)) best = descriptor;
    }
    if (best === undefined) return undefined;
    if (best.entryCounts.classes === 0) {
      rejected.push({ providerId: best.providerId, format: best.format, reason: 'mapping file parsed but contained no class entries' });
    }
    candidates.sort((a, b) => b.confidence - a.confidence);
    return { descriptor: best, candidates, rejected };
  }
}

export function scoreDescriptor(descriptor: MappingDescriptor): number {
  let score = descriptor.formatConfidence;
  score += Math.min(30, Math.floor(Math.log10(Math.max(1, descriptor.entryCounts.classes)) * 8));
  if (descriptor.minecraft.confidence === 'high') score += 15;
  if (descriptor.minecraft.confidence === 'medium') score += 7;
  if (descriptor.parchment !== undefined) score += 5;
  if (descriptor.format === 'tiny-v2' || descriptor.format === 'tiny-v1') score += 8;
  if (descriptor.format === 'parchment') score -= 40;
  if (descriptor.format === 'proguard') score -= 10;
  return score;
}

export function isParchmentOnly(descriptor: MappingDescriptor): boolean {
  return descriptor.format === 'parchment' && descriptor.entryCounts.classes === 0;
}

export function normalizedCounts(descriptor: MappingDescriptor): ReturnType<typeof emptyEntryCounts> {
  return descriptor.entryCounts;
}

export function declaredFormatOf(path: string): MappingFormat | undefined {
  return detectFormatFromExtension(path);
}