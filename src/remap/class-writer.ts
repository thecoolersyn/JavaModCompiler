import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const CONSTANT_UTF8 = 1;
const CONSTANT_INTEGER = 3;
const CONSTANT_FLOAT = 4;
const CONSTANT_LONG = 5;
const CONSTANT_DOUBLE = 6;
const CONSTANT_CLASS = 7;
const CONSTANT_STRING = 8;
const CONSTANT_FIELDREF = 9;
const CONSTANT_METHODREF = 10;
const CONSTANT_INTERFACE_METHODREF = 11;
const CONSTANT_NAME_AND_TYPE = 12;
const CONSTANT_METHOD_HANDLE = 15;
const CONSTANT_METHOD_TYPE = 16;
const CONSTANT_DYNAMIC = 17;
const CONSTANT_INVOKE_DYNAMIC = 18;
const CONSTANT_MODULE = 19;
const CONSTANT_PACKAGE = 20;

const ACC_PUBLIC = 0x0001;
const ACC_PRIVATE = 0x0002;
const ACC_PROTECTED = 0x0004;
const ACC_STATIC = 0x0008;
const ACC_FINAL = 0x0010;
const ACC_SUPER = 0x0020;
const ACC_SYNCHRONIZED = 0x0020;
const ACC_VOLATILE = 0x0040;
const ACC_TRANSIENT = 0x0080;
const ACC_VARARGS = 0x0080;
const ACC_NATIVE = 0x0100;
const ACC_INTERFACE = 0x0200;
const ACC_ABSTRACT = 0x0400;
const ACC_SYNTHETIC = 0x1000;
const ACC_ANNOTATION = 0x2000;
const ACC_ENUM = 0x4000;

interface RawPoolEntry {
  tag: number;
  [key: string]: unknown;
  utf8?: string;
  intValue?: number;
  longValue?: bigint;
  index1?: number;
  index2?: number;
  reference?: number;
}

export interface FieldInfo {
  name: string;
  descriptor: string;
  accessFlags: number;
  attributes: Array<{ name: string; data: Buffer }>;
}

export interface MethodInfo {
  name: string;
  descriptor: string;
  accessFlags: number;
  attributes: Array<{ name: string; data: Buffer }>;
}

export interface ClassModel {
  minorVersion: number;
  majorVersion: number;
  constantPool: RawPoolEntry[];
  accessFlags: number;
  thisClass: string;
  superClass?: string;
  interfaces: string[];
  fields: FieldInfo[];
  methods: MethodInfo[];
  attributes: Array<{ name: string; data: Buffer }>;
}

class Reader {
  offset = 0;

  constructor(readonly buffer: Buffer) {}

  u1(): number {
    const value = this.buffer.readUInt8(this.offset);
    this.offset += 1;
    return value;
  }

  u2(): number {
    const value = this.buffer.readUInt16BE(this.offset);
    this.offset += 2;
    return value;
  }

  u4(): number {
    const value = this.buffer.readUInt32BE(this.offset);
    this.offset += 4;
    return value;
  }

  bytes(count: number): Buffer {
    const value = this.buffer.subarray(this.offset, this.offset + count);
    this.offset += count;
    return value;
  }
}

class Writer {
  private readonly chunks: Buffer[] = [];

  u1(value: number): void {
    const buffer = Buffer.alloc(1);
    buffer.writeUInt8(value & 0xff, 0);
    this.chunks.push(buffer);
  }

  u2(value: number): void {
    const buffer = Buffer.alloc(2);
    buffer.writeUInt16BE(value & 0xffff, 0);
    this.chunks.push(buffer);
  }

  u4(value: number): void {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32BE(value >>> 0, 0);
    this.chunks.push(buffer);
  }

  bytes(value: Buffer): void {
    this.chunks.push(value);
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.chunks);
  }

  get length(): number {
    let total = 0;
    for (const chunk of this.chunks) total += chunk.length;
    return total;
  }
}

export function parseClass(buffer: Buffer): ClassModel {
  const reader = new Reader(buffer);
  const magic = reader.u4();
  if (magic !== 0xcafebabe) throw new Error('Invalid class file magic');
  const minorVersion = reader.u2();
  const majorVersion = reader.u2();
  const poolCount = reader.u2();
  const pool: RawPoolEntry[] = [];
  for (let index = 1; index < poolCount; index += 1) {
    const tag = reader.u1();
    const entry: RawPoolEntry = { tag };
    switch (tag) {
      case CONSTANT_UTF8: {
        const length = reader.u2();
        entry.utf8 = reader.bytes(length).toString('utf8');
        break;
      }
      case CONSTANT_INTEGER:
      case CONSTANT_FLOAT:
        entry.intValue = reader.u4();
        break;
      case CONSTANT_LONG:
      case CONSTANT_DOUBLE:
        entry.longValue = reader.buffer.readBigUInt64BE(reader.offset);
        reader.offset += 8;
        index += 1;
        break;
      case CONSTANT_CLASS:
      case CONSTANT_STRING:
      case CONSTANT_METHOD_TYPE:
      case CONSTANT_MODULE:
      case CONSTANT_PACKAGE:
        entry.index1 = reader.u2();
        break;
      case CONSTANT_FIELDREF:
      case CONSTANT_METHODREF:
      case CONSTANT_INTERFACE_METHODREF:
      case CONSTANT_NAME_AND_TYPE:
      case CONSTANT_DYNAMIC:
      case CONSTANT_INVOKE_DYNAMIC:
        entry.index1 = reader.u2();
        entry.index2 = reader.u2();
        break;
      case CONSTANT_METHOD_HANDLE:
        entry.reference = reader.u1();
        entry.index1 = reader.u2();
        break;
      default:
        throw new Error(`Unsupported constant pool tag ${tag}`);
    }
    pool[index] = entry;
  }

  const utf8 = (index: number | undefined): string => (index === undefined ? '' : (pool[index]?.utf8 ?? ''));
  const className = (index: number): string => {
    if (index === 0) return '';
    return utf8(pool[index]?.index1);
  };

  const accessFlags = reader.u2();
  const thisClassIndex = reader.u2();
  const superClassIndex = reader.u2();
  const interfaceCount = reader.u2();
  const interfaces: string[] = [];
  for (let index = 0; index < interfaceCount; index += 1) interfaces.push(className(reader.u2()));

  const readMembers = (): Array<FieldInfo> => {
    const count = reader.u2();
    const members: Array<FieldInfo> = [];
    for (let index = 0; index < count; index += 1) {
      const flags = reader.u2();
      const name = utf8(reader.u2());
      const descriptor = utf8(reader.u2());
      const attributeCount = reader.u2();
      const attributes: Array<{ name: string; data: Buffer }> = [];
      for (let attributeIndex = 0; attributeIndex < attributeCount; attributeIndex += 1) {
        const attributeName = utf8(reader.u2());
        const length = reader.u4();
        attributes.push({ name: attributeName, data: Buffer.from(reader.bytes(length)) });
      }
      members.push({ name, descriptor, accessFlags: flags, attributes });
    }
    return members;
  };

  const fields = readMembers() as Array<FieldInfo>;
  const methods = readMembers() as Array<MethodInfo>;

  const attributeCount = reader.u2();
  const attributes: Array<{ name: string; data: Buffer }> = [];
  for (let index = 0; index < attributeCount; index += 1) {
    const attributeName = utf8(reader.u2());
    const length = reader.u4();
    attributes.push({ name: attributeName, data: Buffer.from(reader.bytes(length)) });
  }

  return {
    minorVersion,
    majorVersion,
    constantPool: pool,
    accessFlags,
    thisClass: className(thisClassIndex),
    superClass: superClassIndex === 0 ? undefined : className(superClassIndex),
    interfaces,
    fields,
    methods,
    attributes,
  };
}

export interface ClassRemapContext {
  mapInternalName(name: string): string;
  mapMethodName(owner: string, name: string, descriptor: string): string;
  mapFieldName(owner: string, name: string, descriptor: string): string;
  mapInvokeDynamicName(owner: string, bootstrapName: string, descriptor: string): string;
}

export function writeClass(model: ClassModel, context?: ClassRemapContext): Buffer {
  const writer = new Writer();
  writer.u4(0xcafebabe);
  writer.u2(model.minorVersion);
  writer.u2(model.majorVersion);

  const pool = model.constantPool;
  const nameIndexOf = (name: string): number => {
    for (let index = 1; index < pool.length; index += 1) {
      const entry = pool[index];
      if (entry !== undefined && entry.tag === CONSTANT_UTF8 && entry.utf8 === name) return index;
    }
    pool.push({ tag: CONSTANT_UTF8, utf8: name });
    return pool.length - 1;
  };
  const classIndexOf = (internalName: string): number => {
    for (let index = 1; index < pool.length; index += 1) {
      const entry = pool[index];
      if (entry !== undefined && entry.tag === CONSTANT_CLASS && (pool[entry.index1 ?? 0]?.utf8 ?? '') === internalName) return index;
    }
    const utf8Index = nameIndexOf(internalName);
    pool.push({ tag: CONSTANT_CLASS, index1: utf8Index });
    return pool.length - 1;
  };
  const stringIndexOf = (value: string): number => {
    for (let index = 1; index < pool.length; index += 1) {
      const entry = pool[index];
      if (entry !== undefined && entry.tag === CONSTANT_STRING && (pool[entry.index1 ?? 0]?.utf8 ?? '') === value) return index;
    }
    const utf8Index = nameIndexOf(value);
    pool.push({ tag: CONSTANT_STRING, index1: utf8Index });
    return pool.length - 1;
  };
  const nameAndTypeIndexOf = (name: string, descriptor: string): number => {
    for (let index = 1; index < pool.length; index += 1) {
      const entry = pool[index];
      if (entry !== undefined && entry.tag === CONSTANT_NAME_AND_TYPE) {
        if ((pool[entry.index1 ?? 0]?.utf8 ?? '') === name && (pool[entry.index2 ?? 0]?.utf8 ?? '') === descriptor) return index;
      }
    }
    const nameIndex = nameIndexOf(name);
    const descriptorIndex = nameIndexOf(descriptor);
    pool.push({ tag: CONSTANT_NAME_AND_TYPE, index1: nameIndex, index2: descriptorIndex });
    return pool.length - 1;
  };

  const mapDescriptor = (descriptor: string): string => {
    let out = '';
    let index = 0;
    while (index < descriptor.length) {
      const char = descriptor[index] as string;
      if (char === 'L') {
        const end = descriptor.indexOf(';', index);
        if (end === -1) {
          out += descriptor.slice(index);
          break;
        }
        const internalName = descriptor.slice(index + 1, end);
        out += `L${context === undefined ? internalName : context.mapInternalName(internalName)};`;
        index = end + 1;
        continue;
      }
      out += char;
      index += 1;
    }
    return out;
  };

  const ownerOf = (index: number | undefined): string => {
    if (index === undefined) return '';
    const entry = pool[index];
    if (entry === undefined) return '';
    return pool[entry.index1 ?? 0]?.utf8 ?? '';
  };
  const nameAndTypeOf = (index: number | undefined): { name: string; descriptor: string } => {
    if (index === undefined) return { name: '', descriptor: '' };
    const entry = pool[index];
    if (entry === undefined) return { name: '', descriptor: '' };
    return { name: pool[entry.index1 ?? 0]?.utf8 ?? '', descriptor: pool[entry.index2 ?? 0]?.utf8 ?? '' };
  };

  const seenUtf8 = new Map<number, string>();
  const seenClass = new Map<number, number>();
  const seenString = new Map<number, number>();
  const seenNameAndType = new Map<number, number>();

  const rewriteEntry = (originalIndex: number): number => {
    const entry = pool[originalIndex] as RawPoolEntry;
    switch (entry.tag) {
      case CONSTANT_CLASS: {
        const original = pool[entry.index1 ?? 0]?.utf8 ?? '';
        const mapped = context === undefined ? original : context.mapInternalName(original);
        const key = originalIndex;
        const existing = seenClass.get(key);
        if (existing !== undefined) return existing;
        const created = classIndexOf(mapped);
        seenClass.set(key, created);
        return created;
      }
      case CONSTANT_STRING: {
        const original = pool[entry.index1 ?? 0]?.utf8 ?? '';
        const created = stringIndexOf(original);
        seenString.set(originalIndex, created);
        return created;
      }
      case CONSTANT_NAME_AND_TYPE: {
        const name = pool[entry.index1 ?? 0]?.utf8 ?? '';
        const descriptor = pool[entry.index2 ?? 0]?.utf8 ?? '';
        const mappedName = context === undefined ? name : remapMemberName(name, descriptor);
        const mappedDescriptor = mapDescriptor(descriptor);
        const created = nameAndTypeIndexOf(mappedName, mappedDescriptor);
        seenNameAndType.set(originalIndex, created);
        return created;
      }
      case CONSTANT_FIELDREF:
      case CONSTANT_METHODREF:
      case CONSTANT_INTERFACE_METHODREF: {
        const owner = ownerOf(entry.index1);
        const member = nameAndTypeOf(entry.index2);
        const mappedDescriptor = mapDescriptor(member.descriptor);
        const mappedOwner = context === undefined ? owner : context.mapInternalName(owner);
        const mappedName =
          context === undefined
            ? member.name
            : entry.tag === CONSTANT_METHODREF || entry.tag === CONSTANT_INTERFACE_METHODREF
              ? context.mapMethodName(mappedOwner, member.name, member.descriptor)
              : context.mapFieldName(mappedOwner, member.name, member.descriptor);
        const rewritten: RawPoolEntry = { tag: entry.tag };
        rewritten.index1 = classIndexOf(mappedOwner);
        rewritten.index2 = nameAndTypeIndexOf(mappedName, mappedDescriptor);
        pool.push(rewritten);
        return pool.length - 1;
      }
      case CONSTANT_METHOD_TYPE: {
        const original = pool[entry.index1 ?? 0]?.utf8 ?? '';
        const rewritten: RawPoolEntry = { tag: entry.tag };
        rewritten.index1 = nameIndexOf(mapDescriptor(original));
        pool.push(rewritten);
        return pool.length - 1;
      }
      case CONSTANT_DYNAMIC:
      case CONSTANT_INVOKE_DYNAMIC: {
        const member = nameAndTypeOf(entry.index2);
        const mappedDescriptor = mapDescriptor(member.descriptor);
        const mappedName =
          context === undefined
            ? member.name
            : context.mapInvokeDynamicName(model.thisClass, member.name, member.descriptor);
        const rewritten: RawPoolEntry = { tag: entry.tag };
        rewritten.index1 = entry.index1;
        rewritten.index2 = nameAndTypeIndexOf(mappedName, mappedDescriptor);
        pool.push(rewritten);
        return pool.length - 1;
      }
      case CONSTANT_METHOD_HANDLE: {
        const rewritten: RawPoolEntry = { tag: entry.tag, reference: entry.reference };
        rewritten.index1 = entry.index1;
        rewritten.index2 = rewriteEntry(entry.index1 ?? 0);
        pool.push(rewritten);
        return pool.length - 1;
      }
      default:
        return originalIndex;
    }
  };

  function remapMemberName(name: string, descriptor: string): string {
    if (context === undefined) return name;
    if (name.startsWith('<')) return name;
    const isMethod = descriptor.startsWith('(');
    return isMethod
      ? context.mapMethodName(model.thisClass, name, descriptor)
      : context.mapFieldName(model.thisClass, name, descriptor);
  }

  const maxOriginal = pool.length - 1;
  const mappedIndices = new Map<number, number>();
  for (let index = 1; index <= maxOriginal; index += 1) {
    const entry = pool[index];
    if (entry === undefined) continue;
    if (
      entry.tag === CONSTANT_CLASS ||
      entry.tag === CONSTANT_STRING ||
      entry.tag === CONSTANT_NAME_AND_TYPE ||
      entry.tag === CONSTANT_FIELDREF ||
      entry.tag === CONSTANT_METHODREF ||
      entry.tag === CONSTANT_INTERFACE_METHODREF ||
      entry.tag === CONSTANT_METHOD_TYPE ||
      entry.tag === CONSTANT_DYNAMIC ||
      entry.tag === CONSTANT_INVOKE_DYNAMIC ||
      entry.tag === CONSTANT_METHOD_HANDLE
    ) {
      mappedIndices.set(index, rewriteEntry(index));
    }
  }
  void seenUtf8;

  const poolCount = pool.length;
  writer.u2(poolCount);
  for (let index = 1; index < poolCount; index += 1) {
    const entry = pool[index] as RawPoolEntry;
    switch (entry.tag) {
      case CONSTANT_UTF8:
        writer.u1(entry.tag);
        const utf8Buffer = Buffer.from(entry.utf8 ?? '', 'utf8');
        writer.u2(utf8Buffer.length);
        writer.bytes(utf8Buffer);
        break;
      case CONSTANT_INTEGER:
      case CONSTANT_FLOAT:
        writer.u1(entry.tag);
        writer.u4(entry.intValue ?? 0);
        break;
      case CONSTANT_LONG:
      case CONSTANT_DOUBLE: {
        const wide = entry.longValue ?? 0n;
        writer.u1(entry.tag);
        writer.u4(Number((wide >> 32n) & 0xffffffffn));
        writer.u4(Number(wide & 0xffffffffn));
        break;
      }
      case CONSTANT_CLASS:
      case CONSTANT_STRING:
      case CONSTANT_METHOD_TYPE:
      case CONSTANT_MODULE:
      case CONSTANT_PACKAGE:
        writer.u1(entry.tag);
        writer.u2(mappedIndices.get(index) ?? entry.index1 ?? 0);
        break;
      case CONSTANT_FIELDREF:
      case CONSTANT_METHODREF:
      case CONSTANT_INTERFACE_METHODREF:
      case CONSTANT_NAME_AND_TYPE:
      case CONSTANT_DYNAMIC:
      case CONSTANT_INVOKE_DYNAMIC:
        writer.u1(entry.tag);
        writer.u2(mappedIndices.get(index) ?? entry.index1 ?? 0);
        writer.u2(mappedIndices.get(index) ?? entry.index2 ?? 0);
        break;
      case CONSTANT_METHOD_HANDLE:
        writer.u1(entry.tag);
        writer.u1(entry.reference ?? 0);
        writer.u2(mappedIndices.get(index) ?? entry.index1 ?? 0);
        break;
      default:
        break;
    }
  }

  writer.u2(model.accessFlags);
  writer.u2(classIndexOf(model.thisClass));
  writer.u2(model.superClass === undefined ? 0 : classIndexOf(model.superClass));
  writer.u2(model.interfaces.length);
  for (const name of model.interfaces) writer.u2(classIndexOf(name));

  const writeMembers = (members: Array<FieldInfo | MethodInfo>): void => {
    writer.u2(members.length);
    for (const member of members) {
      writer.u2(member.accessFlags);
      const mappedName =
        context === undefined
          ? member.name
          : isMethodDescriptor(member.descriptor)
            ? context.mapMethodName(model.thisClass, member.name, member.descriptor)
            : context.mapFieldName(model.thisClass, member.name, member.descriptor);
      writer.u2(nameIndexOf(mappedName));
      writer.u2(nameIndexOf(mapDescriptor(member.descriptor)));
      writer.u2(member.attributes.length);
      for (const attribute of member.attributes) {
        writer.u2(nameIndexOf(attribute.name));
        writer.u4(attribute.data.length);
        writer.bytes(attribute.data);
      }
    }
  };

  writeMembers(model.fields);
  writeMembers(model.methods);

  writer.u2(model.attributes.length);
  for (const attribute of model.attributes) {
    writer.u2(nameIndexOf(attribute.name));
    writer.u4(attribute.data.length);
    writer.bytes(attribute.data);
  }

  return writer.toBuffer();
}

function isMethodDescriptor(descriptor: string): boolean {
  return descriptor.startsWith('(');
}

export function internalNameOf(className: string): string {
  return className.replace(/\./g, '/');
}

export function classAccessSummary(flags: number): string[] {
  const parts: string[] = [];
  if ((flags & ACC_PUBLIC) !== 0) parts.push('public');
  if ((flags & ACC_PRIVATE) !== 0) parts.push('private');
  if ((flags & ACC_PROTECTED) !== 0) parts.push('protected');
  if ((flags & ACC_STATIC) !== 0) parts.push('static');
  if ((flags & ACC_FINAL) !== 0) parts.push('final');
  if ((flags & ACC_INTERFACE) !== 0) parts.push('interface');
  if ((flags & ACC_ABSTRACT) !== 0) parts.push('abstract');
  if ((flags & ACC_ENUM) !== 0) parts.push('enum');
  if ((flags & ACC_ANNOTATION) !== 0) parts.push('annotation');
  return parts;
}

export function methodAccessSummary(flags: number): string[] {
  const parts: string[] = [];
  if ((flags & ACC_PUBLIC) !== 0) parts.push('public');
  if ((flags & ACC_PRIVATE) !== 0) parts.push('private');
  if ((flags & ACC_PROTECTED) !== 0) parts.push('protected');
  if ((flags & ACC_STATIC) !== 0) parts.push('static');
  if ((flags & ACC_FINAL) !== 0) parts.push('final');
  if ((flags & ACC_SYNCHRONIZED) !== 0) parts.push('synchronized');
  if ((flags & ACC_NATIVE) !== 0) parts.push('native');
  if ((flags & ACC_VARARGS) !== 0) parts.push('varargs');
  if ((flags & ACC_SYNTHETIC) !== 0) parts.push('synthetic');
  return parts;
}

export function readClassFile(filePath: string): ClassModel {
  return parseClass(fs.readFileSync(filePath));
}

export function annotationValues(attributeData: Buffer): string[] {
  const reader = new Reader(attributeData);
  try {
    const count = reader.u2();
    const values: string[] = [];
    for (let index = 0; index < count; index += 1) {
      values.push(readAnnotationElement(reader));
    }
    return values;
  } catch {
    return [];
  }
}

const ELEMENT_NAMES = [
  'B', 'C', 'D', 'F', 'I', 'J', 'S', 'Z', 's', 'e', 'c', '@', '[',
];

function readAnnotationElement(reader: Reader): string {
  const tag = String.fromCharCode(reader.u1());
  if (tag === '@') {
    const typeIndex = reader.u2();
    const elementNameIndex = reader.u2();
    return `@${reader.buffer.subarray(0, 0).toString()}${typeIndex}:${elementNameIndex}`;
  }
  const index = ELEMENT_NAMES.indexOf(tag);
  const kind = index === -1 ? tag : (ELEMENT_NAMES[index] as string);
  void kind;
  return readConstValue(reader, tag);
}

function readConstValue(reader: Reader, tag: string): string {
  switch (tag) {
    case 'B':
    case 'C':
    case 'I':
    case 'S':
    case 'Z':
      return String.fromCharCode(reader.u1());
    case 'D':
    case 'F':
    case 'J':
      return `num:${reader.u2()}`;
    case 's':
      return reader.u2().toString(16);
    default:
      return `tag${tag}`;
  }
}

export function classDirectoryFor(jarRoot: string, classInternalName: string): string {
  return path.join(jarRoot, path.dirname(classInternalName).split('/').join(path.sep));
}

export function gzipToBuffer(input: Buffer): Buffer {
  return zlib.gunzipSync(input);
}