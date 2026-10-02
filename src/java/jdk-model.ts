import fs from 'node:fs';
import path from 'node:path';
import { detectPlatform } from '../platform/os.js';
import type { Architecture, OperatingSystem } from '../platform/os.js';

export interface JdkInstallation {
  javaHome: string;
  javaExecutable: string;
  javacExecutable?: string;
  javacVersion?: string;
  javaVersion?: string;
  version: number;
  versionText: string;
  architecture: Architecture;
  vendor: string;
  origin: 'JAVA_HOME' | 'PATH' | 'jvm-registry' | 'jmc-managed' | 'sdkman' | 'jabba' | 'asdf' | 'mise' | 'brew' | 'system-scan';
}

export interface JavaRequirement {
  majorVersion: number;
  release?: number;
  vendorHint?: string;
  source: string;
}

export interface JdkDownloadSpec {
  url: string;
  javaHomeRelativePath: string;
  archiveFormat: 'tar.gz' | 'zip';
}

const JDK_SCAN_ROOTS_LINUX = [
  '/usr/lib/jvm',
  '/usr/java',
  '/opt/java',
  '/opt/jdk',
  '/Library/Java/JavaVirtualMachines',
  path.join(process.env.HOME ?? '', '.sdkman', 'candidates', 'java'),
  path.join(process.env.HOME ?? '', '.jabba', 'jdk'),
  path.join(process.env.HOME ?? '', '.asdf', 'installs', 'java'),
  path.join(process.env.HOME ?? '', '.local', 'share', 'mise', 'installs', 'java'),
  'C:/Program Files/Java',
  'C:/Program Files/Eclipse Adoptium',
  'C:/Program Files/Microsoft',
  'C:/Program Files/Amazon Corretto',
  'C:/Program Files/BellSoft',
  'C:/Program Files/Zulu',
  'C:/Program Files (x86)/Java',
];

const VENDOR_DIRECTORIES: Record<string, string> = {
  'eclipse adoptium': 'eclipse',
  temurin: 'eclipse',
  corretto: 'amazon',
  'azul zulu': 'zulu',
  zulu: 'zulu',
  graalvm: 'graalvm',
  oracle: 'oracle',
  openjdk: 'other',
  microsoft: 'microsoft',
  ibm: 'ibm',
  sap: 'sap',
  dragonwell: 'alibaba',
};

export function parseJavaVersionOutput(output: string): { versionText: string; version: number; vendor: string } | undefined {
  const combined = `${output}\n`;
  const openjdk = /openjdk version "([^"]+)"/i.exec(combined);
  const jre = /java version "([^"]+)"/i.exec(combined);
  const raw = openjdk?.[1] ?? jre?.[1];
  if (raw === undefined) return undefined;
  const version = javaVersionToMajor(raw);
  if (version === undefined) return undefined;
  const vendorMatch = /^(openjdk|java|Oracle|IBM|SAP|Azul|Eclipse|Temurin|Corretto|GraalVM)[^\n(]*/im.exec(combined);
  const vendorRaw = (vendorMatch?.[1] ?? 'openjdk').trim();
  return { versionText: raw, version, vendor: vendorRaw };
}

export function javaVersionToMajor(versionText: string): number | undefined {
  const trimmed = versionText.trim();
  if (trimmed.startsWith('1.')) {
    const parts = trimmed.split('.');
    if (parts.length >= 2) {
      const parsed = Number.parseInt(parts[1], 10);
      return Number.isNaN(parsed) ? undefined : parsed;
    }
    return undefined;
  }
  const major = Number.parseInt(trimmed.split(/[.\-+]/)[0], 10);
  return Number.isNaN(major) ? undefined : major;
}

export function javaExecutableName(platformOs: OperatingSystem = detectPlatform().os): string {
  return platformOs === 'win32' ? 'java.exe' : 'java';
}

export function javacExecutableName(platformOs: OperatingSystem = detectPlatform().os): string {
  return platformOs === 'win32' ? 'javac.exe' : 'javac';
}

export function parseJavaVendorFromHome(javaHome: string): string {
  const lower = javaHome.toLowerCase();
  for (const [needle, vendor] of Object.entries(VENDOR_DIRECTORIES)) {
    if (lower.includes(needle)) return vendor;
  }
  return 'other';
}

export function detectJavaHomeFromReleaseFile(javaHome: string): { versionText?: string; vendor?: string; implementation?: string } {
  const releasePath = path.join(javaHome, 'release');
  try {
    const content = fs.readFileSync(releasePath, 'utf8');
    const pick = (key: string): string | undefined => {
      const match = new RegExp(`^${key}="?([^"\\n]+)"?`, 'm').exec(content);
      return match?.[1];
    };
    return {
      versionText: pick('JAVA_VERSION'),
      vendor: pick('IMPLEMENTOR'),
      implementation: pick('IMPLEMENTOR_VERSION'),
    };
  } catch {
    return {};
  }
}