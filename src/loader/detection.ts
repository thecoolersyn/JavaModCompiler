export type LoaderKind = 'fabric' | 'forge' | 'neoforge' | 'quilt' | 'liteloader' | 'unknown' | 'none';

export interface LoaderDetectionEvidence {
  kind: LoaderKind;
  signal: string;
  weight: number;
  detail?: string;
}

export interface LoaderDetectionResult {
  kind: LoaderKind;
  confidence: number;
  evidence: LoaderDetectionEvidence[];
  version?: string;
  metadataPath?: string;
  namespace?: string;
}

interface LoaderSignature {
  kind: LoaderKind;
  markers: Array<{ pattern: RegExp; weight: number; signal: string }>;
}

const SIGNATURES: LoaderSignature[] = [
  {
    kind: 'quilt',
    markers: [
      { pattern: /org\.quiltmc\.loom/gi, weight: 45, signal: 'Quilt Loom plugin' },
      { pattern: /quilt_loom\.gradle|quilt\.gradle/gi, weight: 40, signal: 'Quilt Gradle plugin' },
      { pattern: /quilted_fabric\.json/gi, weight: 55, signal: 'quilted_fabric.json manifest' },
      { pattern: /quiltmc/gi, weight: 12, signal: 'Quilt reference' },
    ],
  },
  {
    kind: 'neoforge',
    markers: [
      { pattern: /net\.neoforged\.(?:moddev|gradle|userdev|neoforge)/gi, weight: 45, signal: 'NeoForge Gradle plugin' },
      { pattern: /neoforge\.gradle/gi, weight: 40, signal: 'NeoForge Gradle plugin declaration' },
      { pattern: /neoforge\.mods\.toml/gi, weight: 55, signal: 'neoforge.mods.toml manifest' },
      { pattern: /\bneoforge\b/gi, weight: 18, signal: 'NeoForge reference' },
    ],
  },
  {
    kind: 'forge',
    markers: [
      { pattern: /net\.minecraftforge\.gradle|ForgeGradle/gi, weight: 45, signal: 'ForgeGradle plugin' },
      { pattern: /minecraftforge\.gradle/gi, weight: 40, signal: 'ForgeGradle plugin declaration' },
      { pattern: /META-INF\/forge\.toml|META-INF\\forge\.toml/gi, weight: 55, signal: 'META-INF/forge.toml manifest' },
      { pattern: /net\.minecraftforge:/gi, weight: 20, signal: 'Forge artifact dependency' },
      { pattern: /\bforge\b/gi, weight: 8, signal: 'Forge reference' },
    ],
  },
  {
    kind: 'fabric',
    markers: [
      { pattern: /fabric-loom|net\.fabricmc\.loom|fabric\.gradle/gi, weight: 45, signal: 'Fabric Loom plugin' },
      { pattern: /fabric\.mod\.json/gi, weight: 55, signal: 'fabric.mod.json manifest' },
      { pattern: /net\.fabricmc:/gi, weight: 22, signal: 'Fabric artifact dependency' },
      { pattern: /minecraft_version\s*=/gi, weight: 12, signal: 'Fabric gradle.properties convention' },
      { pattern: /\bfabric\b/gi, weight: 10, signal: 'Fabric reference' },
    ],
  },
  {
    kind: 'liteloader',
    markers: [
      { pattern: /liteloader|liteloadergradle/gi, weight: 45, signal: 'LiteLoader reference' },
      { pattern: /com\.mojang\.liteloader/gi, weight: 40, signal: 'LiteLoader artifact' },
    ],
  },
];

const BUILTIN_MOD_LOADERS: Record<string, LoaderKind> = {
  'net.fabricmc:fabric-loader': 'fabric',
  'net.fabricmc:fabric-api': 'fabric',
  'net.neoforged:neoforge': 'neoforge',
  'net.neoforged.fancymodloader:loader': 'neoforge',
  'net.minecraftforge:forge': 'forge',
  'net.minecraftforge:forge-userdev': 'forge',
  'org.quiltmc:quilt-loader': 'quilt',
  'org.quiltmc:quilted-fabric': 'quilt',
  'com.mojang:launchwrapper': 'unknown',
};

export function detectLoaderFromSignals(signals: Array<{ text: string; origin: string }>): LoaderDetectionResult {
  const evidence = new Map<LoaderKind, LoaderDetectionEvidence[]>();
  for (const signature of SIGNATURES) {
    for (const marker of signature.markers) {
      for (const signal of signals) {
        marker.pattern.lastIndex = 0;
        const match = marker.pattern.exec(signal.text);
        if (match === null) continue;
        const list = evidence.get(signature.kind) ?? [];
        list.push({ kind: signature.kind, signal: marker.signal, weight: marker.weight, detail: `${match[0]} in ${signal.origin}` });
        evidence.set(signature.kind, list);
        break;
      }
    }
  }

  const scored = [...evidence.entries()]
    .map(([kind, list]): LoaderDetectionResult => {
      const strongest = Math.max(...list.map((entry) => entry.weight));
      const total = list.reduce((sum, entry) => sum + entry.weight, 0);
      const confidence = Math.min(100, Math.round(strongest + Math.min(30, total / 4)));
      return { kind, confidence, evidence: list };
    })
    .sort((a, b) => b.confidence - a.confidence);

  if (scored.length === 0) return { kind: 'none', confidence: 0, evidence: [] };
  return scored[0] as LoaderDetectionResult;
}

export function loaderFromCoordinate(coordinate: string): LoaderKind | undefined {
  const withoutVersion = coordinate.split(':').slice(0, 2).join(':');
  return BUILTIN_MOD_LOADERS[withoutVersion];
}

export function loaderDisplayName(kind: LoaderKind): string {
  switch (kind) {
    case 'fabric':
      return 'Fabric';
    case 'forge':
      return 'Forge';
    case 'neoforge':
      return 'NeoForge';
    case 'quilt':
      return 'Quilt';
    case 'liteloader':
      return 'LiteLoader';
    case 'none':
      return 'None';
    default:
      return 'Unknown';
  }
}

export function loaderCoordinatePrefix(kind: LoaderKind): string | undefined {
  switch (kind) {
    case 'fabric':
      return 'net.fabricmc';
    case 'forge':
      return 'net.minecraftforge';
    case 'neoforge':
      return 'net.neoforged';
    case 'quilt':
      return 'org.quiltmc';
    default:
      return undefined;
  }
}