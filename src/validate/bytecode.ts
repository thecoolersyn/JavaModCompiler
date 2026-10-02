import path from 'node:path';
import type { Diagnostic } from '../core/types.js';
import { parseClass, classAccessSummary, type ClassModel } from '../remap/class-writer.js';
import { classFileMajorToJavaMajor } from '../bytecode/class-file.js';
import { openZip } from '../jar/zip.js';
import { jarEntryNames } from '../jar/jar.js';
import { readJarManifest } from '../jar/manifest.js';
import { verifyZipCrcs } from '../jar/zip.js';
import { isSuspiciousEntryName } from '../jar/zip.js';

export interface BytecodeCheckInput {
  jarPath: string;
  maxSupportedMajor?: number;
  requireRuntimeMajor?: number;
}

export interface BytecodeCheckResult {
  classes: number;
  maxMajor: number;
  minMajor: number;
  tooNew: Array<{ name: string; major: number; requiredJava: number }>;
  parseFailures: Array<{ name: string; reason: string }>;
  inconsistentPackages: Array<{ name: string; declaredPath: string }>;
  duplicateClasses: Array<{ name: string }>;
  diagnostics: Diagnostic[];
  modelByClass: Map<string, ClassModel>;
}

const DEFAULT_MAX_MAJOR = 65;

export function analyzeBytecode(input: BytecodeCheckInput): BytecodeCheckResult {
  const archive = openZip(input.jarPath);
  const classNames = archive.entries.filter((entry) => !entry.isDirectory && entry.name.endsWith('.class')).map((entry) => entry.name);
  const seen = new Set<string>();
  const duplicateClasses: Array<{ name: string }> = [];
  const tooNew: Array<{ name: string; major: number; requiredJava: number }> = [];
  const parseFailures: Array<{ name: string; reason: string }> = [];
  const inconsistentPackages: Array<{ name: string; declaredPath: string }> = [];
  const modelByClass = new Map<string, ClassModel>();
  let maxMajor = 0;
  let minMajor = Number.MAX_SAFE_INTEGER;
  const diagnostics: Diagnostic[] = [];
  const limit = input.maxSupportedMajor ?? DEFAULT_MAX_MAJOR;

  for (const entry of archive.entries) {
    if (entry.isDirectory || !entry.name.endsWith('.class')) continue;
    if (seen.has(entry.name)) duplicateClasses.push({ name: entry.name });
    seen.add(entry.name);
    let model: ClassModel;
    try {
      model = parseClass(archive.read(entry));
    } catch (error) {
      parseFailures.push({ name: entry.name, reason: error instanceof Error ? error.message : String(error) });
      continue;
    }
    const internalName = entry.name.slice(0, -6);
    modelByClass.set(internalName, model);
    if (model.majorVersion > maxMajor) maxMajor = model.majorVersion;
    if (model.majorVersion < minMajor) minMajor = model.majorVersion;
    if (model.majorVersion > limit) {
      tooNew.push({ name: entry.name, major: model.majorVersion, requiredJava: classFileMajorToJavaMajor(model.majorVersion) });
    }
    const expectedPath = `${model.thisClass}.class`;
    if (expectedPath !== entry.name) {
      inconsistentPackages.push({ name: entry.name, declaredPath: expectedPath });
    }
  }

  if (parseFailures.length > 0) {
    diagnostics.push({
      id: 'bytecode-parse-failure',
      severity: 'error',
      title: 'Bytecode',
      summary: `${parseFailures.length} class file${parseFailures.length === 1 ? '' : 's'} could not be parsed`,
      stage: 'VALIDATE',
      detected: parseFailures.slice(0, 10).map((failure) => `${failure.name}: ${failure.reason}`),
      cause: 'The produced class files are not valid JVM class files.',
      suggestions: ['Rebuild with a compiler that targets the required release.'],
      evidence: [],
      rawMessages: parseFailures.map((failure) => `${failure.name}: ${failure.reason}`),
    });
  }
  if (tooNew.length > 0) {
    const highest = tooNew.reduce((a, b) => (a.major >= b.major ? a : b));
    diagnostics.push({
      id: 'bytecode-too-new',
      severity: 'error',
      title: 'Java Compatibility',
      summary: `${tooNew.length} class file${tooNew.length === 1 ? '' : 's'} target a class file version newer than ${classFileMajorToJavaMajor(limit)}`,
      stage: 'VALIDATE',
      detected: [`highest class file version: ${highest.major}`, `requires Java ${highest.requiredJava}`, ...tooNew.slice(0, 10).map((entry) => `${entry.name}: major ${entry.major}`)],
      expected: `Java ${classFileMajorToJavaMajor(limit)}`,
      cause: `The project compiled to class file version ${highest.major}, which requires a Java ${highest.requiredJava} runtime.`,
      suggestions: [
        `Set the build release to ${highest.requiredJava} or lower, or run the artifact on Java ${highest.requiredJava} or newer.`,
      ],
      evidence: [],
      rawMessages: tooNew.slice(0, 30).map((entry) => `${entry.name}: major ${entry.major}`),
    });
  }
  if (duplicateClasses.length > 0) {
    diagnostics.push({
      id: 'duplicate-class',
      severity: 'error',
      title: 'Bytecode',
      summary: `The artifact contains ${duplicateClasses.length} duplicate class file${duplicateClasses.length === 1 ? '' : 's'}`,
      stage: 'VALIDATE',
      detected: duplicateClasses.slice(0, 10).map((entry) => entry.name),
      cause: 'More than one entry maps to the same class path, so the loaded class is ambiguous.',
      suggestions: ['Remove shadowed jars from the runtime classpath or exclude duplicate entries from the packaging task.'],
      evidence: [],
      rawMessages: [],
    });
  }
  if (inconsistentPackages.length > 0) {
    diagnostics.push({
      id: 'package-path-mismatch',
      severity: 'error',
      title: 'Package Consistency',
      summary: `${inconsistentPackages.length} class file${inconsistentPackages.length === 1 ? '' : 's'} declare a name that does not match their path`,
      stage: 'VALIDATE',
      detected: inconsistentPackages.slice(0, 10).map((entry) => `${entry.name} declares ${entry.declaredPath}`),
      cause: 'The compiler emitted a class file whose path disagrees with its declared class name.',
      suggestions: ['Rebuild after removing stale class files from the output directory.'],
      evidence: [],
      rawMessages: [],
    });
  }

  return {
    classes: classNames.length,
    maxMajor,
    minMajor: minMajor === Number.MAX_SAFE_INTEGER ? 0 : minMajor,
    tooNew,
    parseFailures,
    inconsistentPackages,
    duplicateClasses,
    diagnostics,
    modelByClass,
  };
}

export interface JarIntegrityResult {
  ok: boolean;
  crcFailures: Array<{ name: string; expected: number; actual: number }>;
  suspiciousEntries: string[];
  hasManifest: boolean;
  entryCount: number;
  missingDirectories: string[];
  diagnostics: Diagnostic[];
}

export function checkJarIntegrity(jarPath: string): JarIntegrityResult {
  const crc = verifyZipCrcs(jarPath);
  const entries = jarEntryNames(jarPath);
  const suspiciousEntries = entries.filter((entry) => isSuspiciousEntryName(entry));
  const archive = openZip(jarPath);
  const manifestPresent = archive.entries.some((entry) => entry.name.toLowerCase() === 'meta-inf/manifest.mf');
  const directories = new Set(archive.entries.filter((entry) => entry.isDirectory).map((entry) => entry.name.replace(/\/$/, '')));
  const missingDirectories: string[] = [];
  for (const entry of entries) {
    const slash = entry.lastIndexOf('/');
    if (slash === -1) continue;
    const parent = entry.slice(0, slash);
    if (!directories.has(parent)) missingDirectories.push(parent);
  }
  const diagnostics: Diagnostic[] = [];
  if (!crc.ok) {
    diagnostics.push({
      id: 'jar-crc-failure',
      severity: 'error',
      title: 'JAR Integrity',
      summary: `${crc.failures.length} entr${crc.failures.length === 1 ? 'y' : 'ies'} failed CRC verification`,
      stage: 'VALIDATE',
      detected: crc.failures.slice(0, 10).map((failure) => `${failure.name}: expected ${failure.expected}, got ${failure.actual}`),
      cause: 'The archive content does not match the checksums recorded in its central directory, so the file is corrupt.',
      suggestions: ['Rebuild the artifact; the packaged file was written incorrectly.'],
      evidence: [],
      rawMessages: crc.failures.map((failure) => failure.name),
    });
  }
  if (suspiciousEntries.length > 0) {
    diagnostics.push({
      id: 'jar-unsafe-entry',
      severity: 'error',
      title: 'JAR Integrity',
      summary: `${suspiciousEntries.length} archive entr${suspiciousEntries.length === 1 ? 'y' : 'ies'} have unsafe path names`,
      stage: 'VALIDATE',
      detected: suspiciousEntries.slice(0, 10),
      cause: 'Archive entries containing absolute paths or parent traversal can write outside the extraction directory.',
      suggestions: ['Review the packaging configuration and remove entries with absolute or traversing paths.'],
      evidence: [],
      rawMessages: [],
    });
  }
  return {
    ok: crc.ok && suspiciousEntries.length === 0,
    crcFailures: crc.failures,
    suspiciousEntries,
    hasManifest: manifestPresent,
    entryCount: entries.length,
    missingDirectories: [...new Set(missingDirectories)].slice(0, 50),
    diagnostics,
  };
}

export interface MetadataCheckResult {
  manifest?: Record<string, string>;
  fabricModJson?: Record<string, unknown>;
  modsToml?: string;
  diagnostics: Diagnostic[];
  loaderDetected: string | undefined;
}

export function checkMetadata(jarPath: string): MetadataCheckResult {
  const entries = jarEntryNames(jarPath);
  const manifest = readJarManifest(jarPath);
  const result: MetadataCheckResult = { manifest, diagnostics: [], loaderDetected: undefined };
  const fabricEntry = entries.find((entry) => entry.toLowerCase() === 'fabric.mod.json');
  if (fabricEntry !== undefined) {
    result.loaderDetected = 'fabric';
    try {
      const archive = openZip(jarPath);
      const entry = archive.entries.find((candidate) => candidate.name === fabricEntry);
      if (entry !== undefined) {
        result.fabricModJson = JSON.parse(archive.read(entry).toString('utf8')) as Record<string, unknown>;
      }
    } catch (error) {
      result.diagnostics.push({
        id: 'fabric-mod-json-invalid',
        severity: 'error',
        title: 'Metadata',
        summary: 'fabric.mod.json could not be parsed',
        stage: 'VALIDATE',
        detected: [(error as Error).message],
        cause: 'The loader metadata file is not valid JSON.',
        suggestions: ['Fix the JSON syntax of fabric.mod.json.'],
        evidence: [],
        rawMessages: [(error as Error).message],
      });
    }
  }
  const tomlEntry = entries.find((entry) => entry.toLowerCase().endsWith('mods.toml'));
  if (tomlEntry !== undefined) {
    if (result.loaderDetected === undefined) result.loaderDetected = tomlEntry.toLowerCase().includes('neoforge') ? 'neoforge' : 'forge';
    const archive = openZip(jarPath);
    const entry = archive.entries.find((candidate) => candidate.name === tomlEntry);
    if (entry !== undefined) {
      const text = archive.read(entry).toString('utf8');
      result.modsToml = text;
      if (!/modId\s*=/.test(text)) {
        result.diagnostics.push({
          id: 'mods-toml-no-modid',
          severity: 'error',
          title: 'Metadata',
          summary: `${tomlEntry} does not declare a modId`,
          stage: 'VALIDATE',
          detected: [tomlEntry],
          cause: 'Forge and NeoForge require a modId entry in the TOML descriptor.',
          suggestions: ['Add modId to the [mod] or [[mods]] section of the descriptor.'],
          evidence: [],
          rawMessages: [],
        });
      }
    }
  }
  if (manifest !== undefined) {
    const manifestVersion = manifest['Manifest-Version'];
    if (manifestVersion === undefined) {
      result.diagnostics.push({
        id: 'manifest-no-version',
        severity: 'warning',
        title: 'Metadata',
        summary: 'The JAR manifest does not declare Manifest-Version',
        stage: 'VALIDATE',
        detected: [],
        cause: 'Some loaders and tooling expect Manifest-Version to be present.',
        suggestions: ['Set Manifest-Version: 1.0 in the packaging configuration.'],
        evidence: [],
        rawMessages: [],
      });
    }
  }
  return result;
}

export function classReferences(model: ClassModel): { classes: Set<string>; methods: Array<{ owner: string; name: string; descriptor: string }> } {
  const classes = new Set<string>();
  const methods: Array<{ owner: string; name: string; descriptor: string }> = [];
  if (model.superClass !== undefined) classes.add(model.superClass);
  for (const entry of model.interfaces) classes.add(entry);
  for (const field of model.fields) {
    for (const match of field.descriptor.matchAll(/L([^;]+);/g)) {
      if (match[1] !== undefined) classes.add(match[1]);
    }
  }
  for (const method of model.methods) {
    for (const match of method.descriptor.matchAll(/L([^;]+);/g)) {
      if (match[1] !== undefined) classes.add(match[1]);
    }
  }
  for (let index = 1; index < model.constantPool.length; index += 1) {
    const entry = model.constantPool[index];
    if (entry === undefined) continue;
    if (entry.tag === 7 && typeof entry.index1 === 'number') {
      const utf8 = model.constantPool[entry.index1];
      if (utf8 !== undefined && typeof utf8.utf8 === 'string') classes.add(utf8.utf8);
    }
    if (entry.tag === 12 && typeof entry.index1 === 'number') {
      const nameEntry = model.constantPool[entry.index1];
      const descriptorEntry = typeof entry.index2 === 'number' ? model.constantPool[entry.index2] : undefined;
      if (nameEntry?.utf8 !== undefined && descriptorEntry?.utf8 !== undefined) {
        methods.push({ owner: model.thisClass, name: nameEntry.utf8, descriptor: descriptorEntry.utf8 });
      }
    }
  }
  return { classes, methods };
}

export function publicApiSummary(model: ClassModel): string[] {
  const summary: string[] = [`${model.thisClass} [${classAccessSummary(model.accessFlags).join(' ')}]`];
  for (const field of model.fields) summary.push(`  field ${field.name} ${field.descriptor}`);
  for (const method of model.methods) summary.push(`  method ${method.name}${method.descriptor}`);
  return summary;
}

export function artifactBaseName(artifactPath: string): string {
  return path.basename(artifactPath).replace(/\.jar$/, '');
}