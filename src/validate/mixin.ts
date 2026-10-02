import type { Diagnostic } from '../core/types.js';
import { openZip } from '../jar/zip.js';
import { parseClass, type ClassModel } from '../remap/class-writer.js';
import { classReferences } from './bytecode.js';

export interface MixinTargetDeclaration {
  target: string;
  mixinClass: string;
  kind: 'class' | 'method' | 'field';
  selector?: string;
  descriptor?: string;
}

export interface MixinConfigDeclaration {
  configName: string;
  package: string[];
  mixins: string[];
  client: string[];
  server: string[];
  injectors: Record<string, unknown>;
  refmap?: string;
  environment?: string;
  required: boolean;
  priority: number;
  minVersion?: string;
  compatibilityLevel?: string;
  plugin?: string;
}

export interface MixinValidationInput {
  jarPath: string;
  availableClasses?: Set<string>;
  mappingNamespace?: string;
  expectedEnvironment?: 'client' | 'server' | 'both';
  includeRuntimeLookups?: boolean;
}

export interface MixinValidationResult {
  configs: MixinConfigDeclaration[];
  targets: MixinTargetDeclaration[];
  missingConfigs: string[];
  missingMixinClasses: string[];
  missingTargets: string[];
  refmapPresence: Array<{ mixin: string; refmap: string; present: boolean }>;
  environmentMismatches: string[];
  pluginDeclarations: string[];
  runtimeBehaviorExecuted: boolean;
  diagnostics: Diagnostic[];
  passed: boolean;
}

const ANNOTATION_DESCRIPTORS: Record<string, string> = {
  'Lorg/spongepowered/asm/mixin/Mixin;': 'Mixin',
  'Lorg/spongepowered/asm/mixin/Shadow;': 'Shadow',
  'Lorg/spongepowered/asm/mixin/Overwrite;': 'Overwrite',
  'Lorg/spongepowered/asm/mixin/Inject;': 'Inject',
  'Lorg/spongepowered/asm/mixin/Redirect;': 'Redirect',
  'Lorg/spongepowered/asm/mixin/ModifyArg;': 'ModifyArg',
  'Lorg/spongepowered/asm/mixin/ModifyArgs;': 'ModifyArgs',
  'Lorg/spongepowered/asm/mixin/ModifyConstant;': 'ModifyConstant',
  'Lorg/spongepowered/asm/mixin/ModifyExpressionValue;': 'ModifyExpressionValue',
  'Lorg/spongepowered/asm/mixin/ModifyVariable;': 'ModifyVariable',
  'Lorg/spongepowered/asm/mixin/ModifyReturnValue;': 'ModifyReturnValue',
  'Lorg/spongepowered/asm/mixin/Accessor;': 'Accessor',
  'Lorg/spongepowered/asm/mixin/Invoker;': 'Invoker',
  'Lorg/spongepowered/asm/mixin/implements/Implements;': 'Implements',
  'Lorg/spongepowered/asm/mixin/injector/Inject$At;': 'InjectAt',
};

function readUtf8(model: ClassModel, index: number): string {
  return model.constantPool[index]?.utf8 ?? '';
}

function annotationsOf(model: ClassModel, ownerAttributes: Array<{ name: string; data: Buffer }>): string[] {
  const found: string[] = [];
  for (const attribute of ownerAttributes) {
    if (attribute.name !== 'RuntimeVisibleAnnotations' && attribute.name !== 'RuntimeInvisibleAnnotations') continue;
    for (const descriptor of Object.values(ANNOTATION_DESCRIPTORS)) {
      if (attribute.data.toString('binary').includes(descriptor)) found.push(descriptor);
    }
  }
  return found;
}

function methodAnnotationDescriptors(model: ClassModel): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const method of model.methods) {
    const descriptors: string[] = [];
    for (const attribute of method.attributes) {
      if (attribute.name !== 'RuntimeVisibleAnnotations' && attribute.name !== 'RuntimeInvisibleAnnotations') continue;
      for (const [descriptor, label] of Object.entries(ANNOTATION_DESCRIPTORS)) {
        if (attribute.data.toString('binary').includes(descriptor.replace(/\$/g, '$'))) descriptors.push(label);
      }
    }
    if (descriptors.length > 0) map.set(`${method.name}${method.descriptor}`, descriptors);
  }
  return map;
}

export function parseMixinConfig(content: string, configName: string): MixinConfigDeclaration {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return {
      configName,
      package: [],
      mixins: [],
      client: [],
      server: [],
      injectors: {},
      required: false,
      priority: 1000,
    };
  }
  const toArray = (value: unknown): string[] => {
    if (typeof value === 'string') return [value];
    if (!Array.isArray(value)) return [];
    return value.filter((entry): entry is string => typeof entry === 'string');
  };
  return {
    configName,
    package: toArray(parsed.package),
    mixins: toArray(parsed.mixins ?? parsed.mixin),
    client: toArray(parsed.client),
    server: toArray(parsed.server),
    injectors: (parsed.injectors ?? {}) as Record<string, unknown>,
    refmap: typeof parsed.refmap === 'string' ? parsed.refmap : undefined,
    environment: typeof parsed.environment === 'string' ? parsed.environment : undefined,
    required: parsed.required === true,
    priority: typeof parsed.priority === 'number' ? parsed.priority : 1000,
    minVersion: typeof parsed.minVersion === 'string' ? parsed.minVersion : undefined,
    compatibilityLevel: typeof parsed.compatibilityLevel === 'string' ? parsed.compatibilityLevel : undefined,
    plugin: typeof parsed.plugin === 'string' ? parsed.plugin : undefined,
  };
}

export function validateMixins(input: MixinValidationInput): MixinValidationResult {
  const archive = openZip(input.jarPath);
  const entryNames = archive.entries.filter((entry) => !entry.isDirectory).map((entry) => entry.name);
  const available = new Set(entryNames.filter((name) => name.endsWith('.class')).map((name) => name.slice(0, -6)));
  const models = new Map<string, ClassModel>();
  for (const entry of archive.entries) {
    if (entry.isDirectory || !entry.name.endsWith('.class')) continue;
    try {
      models.set(entry.name.slice(0, -6), parseClass(archive.read(entry)));
    } catch {
      continue;
    }
  }

  const configEntries = entryNames.filter(
    (name) => !name.startsWith('META-INF/') && /\.json$/i.test(name) && /mixins?/i.test(name),
  );
  const configs: MixinConfigDeclaration[] = [];
  const missingConfigs: string[] = [];
  const missingMixinClasses: string[] = [];
  const targets: MixinTargetDeclaration[] = [];
  const refmapPresence: Array<{ mixin: string; refmap: string; present: boolean }> = [];
  const environmentMismatches: string[] = [];
  const pluginDeclarations: string[] = [];
  const diagnostics: Diagnostic[] = [];

  for (const configEntry of configEntries) {
    const entry = archive.entries.find((candidate) => candidate.name === configEntry);
    if (entry === undefined) continue;
    const content = archive.read(entry).toString('utf8');
    const config = parseMixinConfig(content, configEntry);
    if (config.mixins.length === 0 && config.client.length === 0 && config.server.length === 0 && config.refmap === undefined) {
      missingConfigs.push(configEntry);
      continue;
    }
    configs.push(config);
    if (config.plugin !== undefined) pluginDeclarations.push(`${configEntry}: ${config.plugin}`);

    for (const relative of [...config.mixins, ...config.client, ...config.server]) {
      const fqn = config.package.length > 0 ? `${config.package.join('.')}.${relative}` : relative;
      const internalName = fqn.replace(/\./g, '/');
      if (!available.has(internalName)) {
        missingMixinClasses.push(fqn);
        continue;
      }
      const model = models.get(internalName);
      if (model === undefined) continue;
      if (!annotationsOf(model, model.attributes).includes('Mixin')) {
        diagnostics.push({
          id: 'mixin-annotation-missing',
          severity: 'error',
          title: 'Static Mixin Validation',
          summary: `${fqn} is listed in ${configEntry} but is not annotated with @Mixin`,
          stage: 'VALIDATE',
          detected: [fqn],
          cause: 'Mixin classes must carry the @Mixin annotation to be transformed.',
          suggestions: ['Annotate the class with @Mixin or remove it from the configuration.'],
          evidence: [`config: ${configEntry}`],
          rawMessages: [],
        });
      }
      const targetValue = readClassMixinTarget(model);
      if (targetValue !== undefined) targets.push({ target: targetValue, mixinClass: fqn, kind: 'class' });
      const owner = targetValue ?? internalName;
      const ownerModel = models.get(owner);
      const methodAnnotations = methodAnnotationDescriptors(model);
      for (const [signature, labels] of methodAnnotations) {
        const separator = signature.indexOf('(');
        const methodName = signature.slice(0, separator);
        const descriptor = signature.slice(separator);
        targets.push({ target: owner, mixinClass: fqn, kind: 'method', selector: methodName, descriptor });
        if (ownerModel === undefined) continue;
        const declared = ownerModel.methods.some((method) => method.name === methodName && method.descriptor === descriptor);
        if (declared) continue;
        const isShadow = labels.includes('Shadow');
        const isInjection = labels.some((label) =>
          ['Inject', 'Redirect', 'ModifyArg', 'ModifyArgs', 'ModifyConstant', 'ModifyReturnValue'].includes(label),
        );
        if (isShadow || isInjection) {
          diagnostics.push({
            id: isShadow ? 'mixin-shadow-missing' : 'mixin-injection-target-missing',
            severity: 'warning',
            title: 'Static Mixin Validation',
            summary: `@${isShadow ? 'Shadow' : 'Injection'} target ${methodName}${descriptor} was not found on ${owner}`,
            stage: 'VALIDATE',
            detected: [`${fqn}#${methodName}${descriptor}`, `target: ${owner}`],
            cause:
              'The target member is supplied by the Minecraft runtime namespace and is not present in the artifact under the built namespace, so this cannot be verified statically.',
            suggestions: [
              'Verify the mappings namespace used at build time matches the namespace the target member belongs to.',
              'Regenerate the refmap if the project ships one.',
            ],
            evidence: [`config: ${configEntry}`],
            rawMessages: [],
          });
        }
      }
    }

    if (config.refmap !== undefined) {
      refmapPresence.push({
        mixin: config.configName,
        refmap: config.refmap,
        present: entryNames.some((name) => name === config.refmap || name.replace(/\//g, '.') === config.refmap),
      });
    }

    const declaredEnvironment =
      config.environment ?? (config.client.length > 0 && config.server.length === 0 ? 'client' : config.server.length > 0 && config.client.length === 0 ? 'server' : undefined);
    if (declaredEnvironment !== undefined && input.expectedEnvironment !== undefined && declaredEnvironment !== 'both') {
      const compatible = input.expectedEnvironment === 'both' || input.expectedEnvironment === declaredEnvironment;
      if (!compatible) environmentMismatches.push(`${configEntry} declares environment ${declaredEnvironment}`);
    }
  }

  const missingRefmaps = refmapPresence.filter((entry) => !entry.present).map((entry) => `${entry.mixin}: ${entry.refmap}`);

  if (missingMixinClasses.length > 0) {
    diagnostics.push({
      id: 'mixin-class-missing',
      severity: 'error',
      title: 'Static Mixin Validation',
      summary: `${missingMixinClasses.length} mixin class${missingMixinClasses.length === 1 ? ' is' : 'es are'} listed in the configuration but absent from the artifact`,
      stage: 'VALIDATE',
      detected: missingMixinClasses.slice(0, 20),
      cause: 'A mixin configuration references classes that the build did not package.',
      suggestions: ['Compile and package every referenced mixin class, or remove the stale entries from the configuration.'],
      evidence: configs.map((config) => `config: ${config.configName}`),
      rawMessages: [],
    });
  }
  if (missingRefmaps.length > 0) {
    diagnostics.push({
      id: 'mixin-refmap-missing',
      severity: 'warning',
      title: 'Static Mixin Validation',
      summary: `${missingRefmaps.length} declared refmap file${missingRefmaps.length === 1 ? ' is' : 's are'} not packaged`,
      stage: 'VALIDATE',
      detected: missingRefmaps.slice(0, 20),
      cause: 'The mixin configuration declares a refmap that the artifact does not contain.',
      suggestions: ['Generate the refmap during the remap task or remove the refmap declaration.'],
      evidence: [],
      rawMessages: [],
    });
  }
  if (environmentMismatches.length > 0) {
    diagnostics.push({
      id: 'mixin-environment-mismatch',
      severity: 'warning',
      title: 'Static Mixin Validation',
      summary: `${environmentMismatches.length} mixin configuration${environmentMismatches.length === 1 ? '' : 's'} target a side other than the expected one`,
      stage: 'VALIDATE',
      detected: environmentMismatches,
      cause: 'The mixin side configuration does not match the side the build expects.',
      suggestions: ['Split client-only and server-only mixins into separate configurations.'],
      evidence: [],
      rawMessages: [],
    });
  }
  if (missingConfigs.length > 0) {
    diagnostics.push({
      id: 'mixin-config-unreadable',
      severity: 'warning',
      title: 'Static Mixin Validation',
      summary: `${missingConfigs.length} file${missingConfigs.length === 1 ? '' : 's'} named like a mixin configuration could not be interpreted`,
      stage: 'VALIDATE',
      detected: missingConfigs,
      suggestions: ['Confirm the file is a mixin configuration JSON document.'],
      evidence: [],
      rawMessages: [],
    });
  }

  diagnostics.push({
    id: 'mixin-runtime-not-executed',
    severity: 'info',
    title: 'Static Mixin Validation',
    summary: 'Static mixin validation completed; runtime mixin behavior was not executed',
    stage: 'VALIDATE',
    detected: [`configurations: ${configs.length}`, `declarations: ${targets.length}`],
    suggestions: ['Run the build with --runtime-test to observe mixin application inside a disposable sandbox.'],
    evidence: [],
    rawMessages: [],
  });

  return {
    configs,
    targets,
    missingConfigs,
    missingMixinClasses,
    missingTargets: [],
    refmapPresence,
    environmentMismatches,
    pluginDeclarations,
    runtimeBehaviorExecuted: false,
    diagnostics,
    passed: !diagnostics.some((diagnostic) => diagnostic.severity === 'error'),
  };
}

function readClassMixinTarget(model: ClassModel): string | undefined {
  for (const attribute of model.attributes) {
    if (attribute.name !== 'RuntimeVisibleAnnotations' && attribute.name !== 'RuntimeInvisibleAnnotations') continue;
    const binary = attribute.data.toString('binary');
    const mixinIndex = binary.indexOf('Lorg/spongepowered/asm/mixin/Mixin;');
    if (mixinIndex === -1) continue;
    const values = [...model.constantPool]
      .map((entry, index) => ({ entry, index }))
      .filter((item) => item.entry.tag === 7);
    void values;
    const targetIndex = binary.indexOf('value');
    if (targetIndex === -1) continue;
    const ownerCandidates = [...model.constantPool].map((entry, index) => ({ entry, index })).filter((item) => item.entry.tag === 7 && item.entry.index1 !== undefined);
    void ownerCandidates;
    const annotationData = attribute.data;
    for (const { entry, index } of ownerCandidates) {
      const name = readUtf8(model, entry.index1 as number);
      if (name.startsWith('net/minecraft') || name.startsWith('net/minecraftforge') || name.startsWith('org/bspkrs') || name.startsWith('com/mojang')) {
        void index;
        return name;
      }
    }
    void annotationData;
  }
  return undefined;
}

export function collectMixinSummary(result: MixinValidationResult): string[] {
  const lines: string[] = [];
  lines.push(`mixin configurations: ${result.configs.length}`);
  for (const config of result.configs) {
    lines.push(
      `  ${config.configName}: ${config.mixins.length} common, ${config.client.length} client, ${config.server.length} server${config.refmap !== undefined ? `, refmap ${config.refmap}` : ''}`,
    );
  }
  lines.push(`declared targets: ${result.targets.length}`);
  lines.push(`missing mixin classes: ${result.missingMixinClasses.length}`);
  lines.push(`refmap entries: ${result.refmapPresence.length}`);
  return lines;
}

export function classUsageOf(model: ClassModel): number {
  return classReferences(model).classes.size;
}