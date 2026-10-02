export type MappingFormat =
  | 'tiny-v1'
  | 'tiny-v2'
  | 'tsrg'
  | 'tsrg2'
  | 'srg'
  | 'proguard'
  | 'mojang'
  | 'yarn'
  | 'intermediary'
  | 'parchment'
  | 'unknown';

export type NamespaceSide = 'primary' | 'intermediary' | 'target' | 'unknown';

export interface MappingNamespace {
  name: string;
  side: NamespaceSide;
}

export interface MappingEntryCounts {
  classes: number;
  fields: number;
  methods: number;
  parameters: number;
}

export interface MinecraftVersionHint {
  version?: string;
  release?: string;
  build?: number;
  confidence: 'high' | 'medium' | 'low' | 'none';
  source?: string;
}

export interface MappingDescriptor {
  format: MappingFormat;
  formatConfidence: number;
  providerId: string;
  namespaces: MappingNamespace[];
  primaryNamespace: string;
  targetNamespace: string;
  mappingVersion?: string;
  minecraft: MinecraftVersionHint;
  entryCounts: MappingEntryCounts;
  fileCount: number;
  totalBytes: number;
  files: MappingFileDescriptor[];
  parchment?: ParchmentMetadata;
  provenance: string[];
  notes: string[];
  directory: string;
}

export interface ParchmentMetadata {
  name?: string;
  version?: string;
  targetNamespace?: string;
  minecraftVersion?: string;
  description?: string;
}

export interface MappingFileDescriptor {
  path: string;
  sizeBytes: number;
  declaredFormat?: MappingFormat;
}

export interface MappingCompatibilityReport {
  compatible: boolean;
  severity: 'error' | 'warning' | 'info';
  findings: CompatibilityFinding[];
}

export interface CompatibilityFinding {
  id: string;
  severity: 'error' | 'warning' | 'info';
  subject: string;
  message: string;
  expected?: string;
  actual?: string;
  evidence?: string[];
}

export interface MappingRecord {
  officialName: string;
  mappings: Map<string, string>;
}

export interface RemapContext {
  fromNamespace: string;
  toNamespace: string;
  inverse: boolean;
}

export interface MappingProviderDescriptor {
  id: string;
  name: string;
  formats: MappingFormat[];
  extensions: string[];
  namespaces: string[];
  detectConfidence(directoryEntries: string[]): number;
}

export interface MappingProvider {
  readonly descriptor: MappingProviderDescriptor;
  probe(directory: string): Promise<MappingDescriptor | undefined>;
}

export interface ClassMapping {
  officialName: string;
  names: Map<string, string>;
  superName?: string;
  interfaces?: string[];
}

export interface MappingTree {
  format: MappingFormat;
  namespaces: string[];
  primaryNamespace: string;
  targetNamespace: string;
  classes: Map<string, ClassMapping>;
  parameters: Map<string, string>;
}

export function emptyEntryCounts(): MappingEntryCounts {
  return { classes: 0, fields: 0, methods: 0, parameters: 0 };
}