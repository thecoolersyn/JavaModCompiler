import type { Diagnostic } from '../core/types.js';
import { openZip } from '../jar/zip.js';
import { parseClass, type ClassModel } from '../remap/class-writer.js';
import { classFileMajorToJavaMajor } from '../bytecode/class-file.js';

export interface SideClassification {
  side: 'common' | 'client' | 'server' | 'dedicated-server' | 'unknown';
  evidence: string[];
}

export interface SideValidationInput {
  jarPath: string;
  clientSourcePrefixes: string[];
  serverSourcePrefixes: string[];
  expectDedicatedServer: boolean;
  availableClasses?: Set<string>;
}

export interface SideValidationResult {
  classifications: Map<string, SideClassification>;
  clientOnlyReferencedByServer: Array<{ from: string; to: string }>;
  unknownSideClasses: string[];
  detectedEntryPoints: { client: string[]; server: string[]; common: string[] };
  diagnostics: Diagnostic[];
  runtimeBehaviorExecuted: boolean;
}

const CLIENT_MARKERS: Array<[RegExp, string]> = [
  [/^net\/minecraft\/client\//, 'package net.minecraft.client'],
  [/^net\/minecraftforge\/client\//, 'package net.minecraftforge.client'],
  [/^net\/neoforged\/neoforge\/client\//, 'package net.neoforged.neoforge.client'],
  [/^com\/mojang\/blaze3d\//, 'package com.mojang.blaze3d'],
  [/^net\/minecraftforge\.client\./, 'package net.minecraftforge.client'],
];

const SERVER_MARKERS: Array<[RegExp, string]> = [
  [/^net\/minecraftforge\/server\//, 'package net.minecraftforge.server'],
  [/^net\/neoforged\/neoforge\/server\//, 'package net.neoforged.neoforge.server'],
  [/^net\/minecraft\/server\//, 'package net.minecraft.server'],
];

const CLIENT_ANNOTATIONS = new Set([
  'Lnet/minecraft/client/gui/screen/Screen;',
  'Lnet/minecraft/client/Minecraft;',
  'Lcom/mojang/blaze3d/platform/InputHandler;',
]);

export function classifyClass(model: ClassModel, className: string): SideClassification {
  const evidence: string[] = [];
  const binary = model.attributes
    .map((attribute) => attribute.data.toString('binary'))
    .join('\n');
  const isClient = CLIENT_MARKERS.some(([pattern]) => pattern.test(className));
  if (isClient) {
    const marker = CLIENT_MARKERS.find(([pattern]) => pattern.test(className));
    evidence.push(marker?.[1] ?? 'client package');
  }
  const isServer = SERVER_MARKERS.some(([pattern]) => pattern.test(className));
  if (isServer) {
    const marker = SERVER_MARKERS.find(([pattern]) => pattern.test(className));
    evidence.push(marker?.[1] ?? 'server package');
  }
  for (const annotation of CLIENT_ANNOTATIONS) {
    if (binary.includes(annotation)) {
      evidence.push(`references ${annotation.replace(/L|;/g, '')}`);
      break;
    }
  }
  const mentionsClientOnlySymbol = constantPoolEntries(model).some((entry) => {
    if (entry.tag !== 7 || entry.index1 === undefined) return false;
    const name = model.constantPool[entry.index1]?.utf8;
    if (typeof name !== 'string') return false;
    return name.startsWith('net/minecraft/client/') || name.startsWith('com/mojang/blaze3d/');
  });
  if (mentionsClientOnlySymbol && !isClient && !isServer) {
    evidence.push('references a client-only package');
  }
  if (isClient && isServer) return { side: 'unknown', evidence: [...evidence, 'class is referenced by both client and server markers'] };
  if (isClient) return { side: 'client', evidence };
  if (isServer) return { side: 'dedicated-server', evidence };
  if (mentionsClientOnlySymbol) return { side: 'client', evidence };
  return { side: 'common', evidence: evidence.length > 0 ? evidence : ['no client-only or server-only references detected'] };
}

export function validateClientServerSides(input: SideValidationInput): SideValidationResult {
  const archive = openZip(input.jarPath);
  const entries = archive.entries.filter((entry) => !entry.isDirectory && entry.name.endsWith('.class'));
  const models = new Map<string, ClassModel>();
  for (const entry of entries) {
    try {
      models.set(entry.name.slice(0, -6), parseClass(archive.read(entry)));
    } catch {
      continue;
    }
  }
  const classifications = new Map<string, SideClassification>();
  for (const [name, model] of models) classifications.set(name, classifyClass(model, name));

  const clientOnlyReferencedByServer: Array<{ from: string; to: string }> = [];
  for (const [name, model] of models) {
    const classification = classifications.get(name);
    if (classification === undefined) continue;
    if (classification.side !== 'dedicated-server' && classification.side !== 'server') continue;
    for (const referenced of referencedClasses(model)) {
      const referencedClassification = classifications.get(referenced);
      if (referencedClassification?.side !== 'client') continue;
      clientOnlyReferencedByServer.push({ from: name, to: referenced });
    }
  }

  const unknownSideClasses = [...classifications.entries()]
    .filter(([, classification]) => classification.side === 'unknown')
    .map(([name]) => name);

  const clientEntry = findEntrypoints(models, 'client');
  const serverEntry = findEntrypoints(models, 'server');

  const diagnostics: Diagnostic[] = [];
  if (clientOnlyReferencedByServer.length > 0) {
    diagnostics.push({
      id: 'client-only-on-server',
      severity: 'error',
      title: 'Client/Server Validation',
      summary: `${clientOnlyReferencedByServer.length} server-side class${clientOnlyReferencedByServer.length === 1 ? '' : 'es'} reference${clientOnlyReferencedByServer.length === 1 ? 's' : ''} client-only classes`,
      stage: 'VALIDATE',
      detected: clientOnlyReferencedByServer.slice(0, 20).map((entry) => `${entry.from} -> ${entry.to}`),
      cause: 'Server-side code references types that only exist on the client, which fails on a dedicated server.',
      suggestions: [
        'Move the server-side code into the common source set.',
        'Guard client-only behaviour behind a side check, or move it to a client source set.',
      ],
      evidence: clientOnlyReferencedByServer.slice(0, 20).map((entry) => `${entry.from} references ${entry.to}`),
      rawMessages: [],
    });
  }
  if (unknownSideClasses.length > 0) {
    diagnostics.push({
      id: 'ambiguous-side',
      severity: 'info',
      title: 'Client/Server Validation',
      summary: `${unknownSideClasses.length} class${unknownSideClasses.length === 1 ? '' : 'es'} could not be attributed to a side`,
      stage: 'VALIDATE',
      detected: unknownSideClasses.slice(0, 10),
      suggestions: ['No action is required unless these classes are entry points.'],
      evidence: [],
      rawMessages: [],
    });
  }
  if (input.expectDedicatedServer && serverEntry.length === 0 && clientEntry.length > 0) {
    diagnostics.push({
      id: 'no-server-entrypoint',
      severity: 'warning',
      title: 'Client/Server Validation',
      summary: 'The artifact declares client entry points but no dedicated server entry points',
      stage: 'VALIDATE',
      detected: clientEntry,
      cause: 'A dedicated server build would find no entry point declared by the artifact.',
      suggestions: ['Add a dedicated server entry point if the mod is intended to run on servers.'],
      evidence: [],
      rawMessages: [],
    });
  }
  diagnostics.push({
    id: 'side-validation-runtime-not-executed',
    severity: 'info',
    title: 'Client/Server Validation',
    summary: 'Static side analysis completed; dedicated server startup was not executed',
    stage: 'VALIDATE',
    detected: [`classes inspected: ${models.size}`],
    suggestions: ['Run the build with --runtime-test to observe dedicated server startup in the sandbox.'],
    evidence: [],
    rawMessages: [],
  });

  return {
    classifications,
    clientOnlyReferencedByServer,
    unknownSideClasses,
    detectedEntryPoints: { client: clientEntry, server: serverEntry, common: [] },
    diagnostics,
    runtimeBehaviorExecuted: false,
  };
}

function constantPoolEntries(model: ClassModel): Array<{ tag: number; index1?: number; index2?: number; utf8?: string }> {
  const entries: Array<{ tag: number; index1?: number; index2?: number; utf8?: string }> = [];
  for (let index = 1; index < model.constantPool.length; index += 1) {
    const entry = model.constantPool[index];
    if (entry === undefined || entry === null) continue;
    entries.push({
      tag: entry.tag,
      index1: typeof entry.index1 === 'number' ? entry.index1 : undefined,
      index2: typeof entry.index2 === 'number' ? entry.index2 : undefined,
      utf8: typeof entry.utf8 === 'string' ? entry.utf8 : undefined,
    });
  }
  return entries;
}

function referencedClasses(model: ClassModel): Set<string> {
  const result = new Set<string>();
  if (model.superClass !== undefined) result.add(model.superClass);
  for (const entry of model.interfaces) result.add(entry);
  const GAME_ROOTS = ['net/minecraft', 'net/minecraftforge', 'net/neoforged', 'com/mojang', 'org/quiltmc', 'net/fabricmc'];
  for (const poolEntry of constantPoolEntries(model)) {
    if (poolEntry.tag !== 7 || poolEntry.index1 === undefined) continue;
    const name = model.constantPool[poolEntry.index1]?.utf8;
    if (typeof name !== 'string') continue;
    if (GAME_ROOTS.some((root) => name.startsWith(root))) result.add(name);
  }
  return result;
}

function findEntrypoints(models: Map<string, ClassModel>, side: 'client' | 'server'): string[] {
  const found: string[] = [];
  for (const [name, model] of models) {
    const annotationNames = model.attributes
      .filter((attribute) => attribute.name === 'RuntimeVisibleAnnotations')
      .map((attribute) => attribute.data.toString('binary'));
    if (annotationNames.length === 0) continue;
    const joined = annotationNames.join('\n');
    const isClient = joined.includes('Lnet/minecraft/client/') || joined.includes('Lnet/fabricmc/api/ClientModInitializer;');
    const isServer = joined.includes('Lnet/minecraft/server/') || joined.includes('Lnet/fabricmc/api/DedicatedServerModInitializer;');
    if (side === 'client' && isClient) found.push(name);
    if (side === 'server' && isServer) found.push(name);
  }
  return found;
}

export function highestClassFileMajor(models: Map<string, ClassModel>): number {
  let max = 0;
  for (const model of models.values()) {
    if (model.majorVersion > max) max = model.majorVersion;
  }
  return max;
}

export function requiredJavaForMajor(major: number): number {
  return classFileMajorToJavaMajor(major);
}