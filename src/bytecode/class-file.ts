export interface ClassEntry {
  name: string;
  superName?: string;
  interfaces: string[];
  accessFlags: number;
  majorVersion: number;
  minorVersion: number;
  fields: Array<{ name: string; descriptor: string; accessFlags: number }>;
  methods: Array<{ name: string; descriptor: string; accessFlags: number }>;
  constantPool: ConstantPoolEntry[];
  innerClasses: Array<{ inner: string; outer?: string; name?: string }>;
}

export interface ConstantPoolEntry {
  tag: number;
  value?: string | number | { name: string; descriptor: string };
  classIndex?: number;
  nameAndTypeIndex?: number;
  stringIndex?: number;
}

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

export class ClassParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClassParseError';
  }
}

export function parseClassFile(buffer: Buffer): ClassEntry {
  let offset = 0;
  const need = (count: number): void => {
    if (offset + count > buffer.length) throw new ClassParseError(`Truncated class file at offset ${offset}`);
  };
  const u1 = (): number => {
    need(1);
    const value = buffer.readUInt8(offset);
    offset += 1;
    return value;
  };
  const u2 = (): number => {
    need(2);
    const value = buffer.readUInt16BE(offset);
    offset += 2;
    return value;
  };
  const u4 = (): number => {
    need(4);
    const value = buffer.readUInt32BE(offset);
    offset += 4;
    return value;
  };

  const magic = u4();
  if (magic !== 0xcafebabe) throw new ClassParseError('Not a Java class file (bad magic number)');
  const minorVersion = u2();
  const majorVersion = u2();
  const constantPoolCount = u2();
  const constantPool: ConstantPoolEntry[] = new Array(constantPoolCount).fill(undefined).map(() => ({ tag: 0 }));
  for (let index = 1; index < constantPoolCount; index += 1) {
    const tag = u1();
    const entry: ConstantPoolEntry = { tag };
    switch (tag) {
      case CONSTANT_UTF8: {
        const length = u2();
        need(length);
        entry.value = buffer.subarray(offset, offset + length).toString('utf8');
        offset += length;
        break;
      }
      case CONSTANT_INTEGER:
      case CONSTANT_FLOAT:
        entry.value = u4();
        break;
      case CONSTANT_LONG:
      case CONSTANT_DOUBLE:
        entry.value = Number(buffer.readBigUInt64BE(offset));
        offset += 8;
        index += 1;
        break;
      case CONSTANT_CLASS:
      case CONSTANT_STRING:
      case CONSTANT_METHOD_TYPE:
      case CONSTANT_MODULE:
      case CONSTANT_PACKAGE:
        entry.classIndex = u2();
        break;
      case CONSTANT_FIELDREF:
      case CONSTANT_METHODREF:
      case CONSTANT_INTERFACE_METHODREF:
      case CONSTANT_NAME_AND_TYPE:
      case CONSTANT_DYNAMIC:
      case CONSTANT_INVOKE_DYNAMIC:
        entry.classIndex = u2();
        entry.nameAndTypeIndex = u2();
        break;
      case CONSTANT_METHOD_HANDLE:
        entry.classIndex = u1();
        entry.nameAndTypeIndex = u2();
        break;
      default:
        throw new ClassParseError(`Unsupported constant pool tag ${tag}`);
    }
    constantPool[index] = entry;
  }

  const accessFlags = u2();
  const thisClass = u2();
  const superClass = u2();
  const interfaceCount = u2();
  const interfaces: string[] = [];
  for (let index = 0; index < interfaceCount; index += 1) {
    interfaces.push(classNameAt(constantPool, u2()));
  }

  const fields: ClassEntry['fields'] = [];
  const fieldCount = u2();
  for (let index = 0; index < fieldCount; index += 1) {
    const flags = u2();
    const name = utf8At(constantPool, u2());
    const descriptor = utf8At(constantPool, u2());
    skipAttributes();
    fields.push({ name, descriptor, accessFlags: flags });
  }

  const methods: ClassEntry['methods'] = [];
  const methodCount = u2();
  for (let index = 0; index < methodCount; index += 1) {
    const flags = u2();
    const name = utf8At(constantPool, u2());
    const descriptor = utf8At(constantPool, u2());
    skipAttributes();
    methods.push({ name, descriptor, accessFlags: flags });
  }

  const innerClasses: ClassEntry['innerClasses'] = [];
  const attributeCount = u2();
  for (let index = 0; index < attributeCount; index += 1) {
    const attributeName = utf8At(constantPool, u2());
    const attributeLength = u4();
    if (attributeName === 'InnerClasses') {
      const entries = u2();
      for (let inner = 0; inner < entries; inner += 1) {
        const innerIndex = u2();
        const outerIndex = u2();
        const nameIndex = u2();
        u2();
        innerClasses.push({
          inner: innerIndex === 0 ? '' : classNameAt(constantPool, innerIndex),
          outer: outerIndex === 0 ? undefined : classNameAt(constantPool, outerIndex),
          name: nameIndex === 0 ? undefined : utf8At(constantPool, nameIndex),
        });
      }
      offset = offset - 2 + attributeLength;
    } else {
      offset += attributeLength;
    }
    need(0);
  }

  function skipAttributes(): void {
    const count = u2();
    for (let index = 0; index < count; index += 1) {
      u2();
      offset += u4();
    }
  }

  return {
    name: classNameAt(constantPool, thisClass),
    superName: superClass === 0 ? undefined : classNameAt(constantPool, superClass),
    interfaces,
    accessFlags,
    majorVersion,
    minorVersion,
    fields,
    methods,
    constantPool,
    innerClasses,
  };
}

function utf8At(constantPool: ConstantPoolEntry[], index: number): string {
  const entry = constantPool[index];
  if (entry === undefined || typeof entry.value !== 'string') return '';
  return entry.value;
}

function classNameAt(constantPool: ConstantPoolEntry[], index: number): string {
  const entry = constantPool[index];
  if (entry === undefined) return '';
  const targetIndex = entry.classIndex ?? entry.stringIndex;
  if (targetIndex === undefined) return '';
  return utf8At(constantPool, targetIndex);
}

export function javaVersionToClassFileMajor(javaMajor: number): number {
  return javaMajor + 44;
}

export function classFileMajorToJavaMajor(major: number): number {
  return major - 44;
}

export function javaReleaseName(major: number): string {
  if (major <= 0) return `Java ${major}`;
  if (major <= 4) return `Java ${major}`;
  if (major === 5) return 'Java 5';
  return `Java ${major}`;
}

export function isClassFileMajorSupported(major: number, runtimeMajor: number): boolean {
  return major <= javaVersionToClassFileMajor(runtimeMajor);
}

export function constantPoolStrings(entry: ClassEntry): string[] {
  const strings: string[] = [];
  for (const item of entry.constantPool) {
    if (item.tag === CONSTANT_UTF8 && typeof item.value === 'string') strings.push(item.value);
  }
  return strings;
}