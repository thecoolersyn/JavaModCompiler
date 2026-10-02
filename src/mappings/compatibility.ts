import path from 'node:path';
import type { CompatibilityFinding, MappingCompatibilityReport, MappingDescriptor } from './types.js';

export interface CompatibilitySubject {
  minecraftVersion?: string;
  minecraftVersionSource?: string;
  loader?: string;
  javaMajor?: number;
  intermediaryVersion?: string;
  mappingsMinecraftVersion?: string;
}

export interface CompatibilityInput {
  mappings: MappingDescriptor;
  subject: CompatibilitySubject;
}

function add(
  findings: CompatibilityFinding[],
  id: string,
  severity: CompatibilityFinding['severity'],
  message: string,
  extra: Partial<CompatibilityFinding> = {},
): void {
  findings.push({ id, severity, subject: extra.subject ?? 'mappings', message, ...extra });
}

export function evaluateMappingCompatibility(input: CompatibilityInput): MappingCompatibilityReport {
  const findings: CompatibilityFinding[] = [];
  const { mappings, subject } = input;
  const mappingVersion = mappings.minecraft.version;

  add(
    findings,
    'mapping-format',
    'info',
    `Mapping format ${mappings.format} handled by provider ${mappings.providerId}`,
    { subject: 'format', actual: mappings.format, evidence: mappings.provenance },
  );

  add(
    findings,
    'mapping-namespaces',
    'info',
    `Source namespace ${mappings.primaryNamespace}, target namespace ${mappings.targetNamespace}`,
    { subject: 'namespaces', actual: `${mappings.primaryNamespace} -> ${mappings.targetNamespace}` },
  );

  if (mappings.entryCounts.classes === 0) {
    add(findings, 'mapping-empty', 'error', 'Mapping set contains no class entries and cannot drive a remap', {
      subject: 'entries',
    });
  } else if (mappings.entryCounts.classes < 500) {
    add(
      findings,
      'mapping-small',
      'warning',
      `Mapping set has only ${mappings.entryCounts.classes} class entries, which is unusual for a full Minecraft mapping set`,
      { subject: 'entries', actual: String(mappings.entryCounts.classes) },
    );
  }

  if (subject.minecraftVersion === undefined) {
    add(findings, 'minecraft-version-unknown', 'warning', 'Minecraft version could not be determined, mapping compatibility is unverified', {
      subject: 'minecraft',
    });
  } else if (mappingVersion !== undefined && subject.minecraftVersion !== mappingVersion) {
    const severity: CompatibilityFinding['severity'] =
      mappings.minecraft.confidence === 'high' ? 'error' : mappings.minecraft.confidence === 'medium' ? 'warning' : 'info';
    add(
      findings,
      'minecraft-mapping-mismatch',
      severity,
      severity === 'error'
        ? `Mapping metadata targets Minecraft ${mappingVersion} but the selected Minecraft artifact is ${subject.minecraftVersion}`
        : `Mapping metadata suggests Minecraft ${mappingVersion} while the project resolves ${subject.minecraftVersion}`,
      {
        subject: 'minecraft',
        expected: subject.minecraftVersion,
        actual: mappingVersion,
        evidence: [`mapping confidence: ${mappings.minecraft.confidence}`, `source: ${mappings.minecraft.source ?? 'unknown'}`],
      },
    );
  } else if (mappingVersion !== undefined) {
    add(findings, 'minecraft-mapping-match', 'info', `Mapping metadata matches Minecraft ${mappingVersion}`, {
      subject: 'minecraft',
      expected: subject.minecraftVersion,
      actual: mappingVersion,
    });
  }

  if (subject.intermediaryVersion !== undefined && mappings.format === 'yarn') {
    add(
      findings,
      'intermediary-loader-mismatch',
      'warning',
      'Yarn mappings are provided but the resolved loader uses an intermediary-based namespace, remapping may be a no-op or incorrect',
      { subject: 'loader', expected: 'named (official namespace)', actual: 'intermediary (loader namespace)' },
    );
  }

  if (subject.javaMajor !== undefined) {
    const requiredJava = mappings.notes.find((note) => /requires java/i.test(note));
    if (requiredJava !== undefined) {
      add(findings, 'mapping-java', 'info', requiredJava, { subject: 'java', actual: String(subject.javaMajor) });
    }
  }

  const parchment = mappings.parchment;
  if (parchment?.minecraftVersion !== undefined && subject.minecraftVersion !== undefined) {
    if (parchment.minecraftVersion !== subject.minecraftVersion) {
      add(
        findings,
        'parchment-mismatch',
        'warning',
        `Parchment metadata targets Minecraft ${parchment.minecraftVersion} but the project resolves ${subject.minecraftVersion}`,
        { subject: 'minecraft', expected: subject.minecraftVersion, actual: parchment.minecraftVersion },
      );
    }
  }

  const hasError = findings.some((finding) => finding.severity === 'error');
  return { compatible: !hasError, severity: hasError ? 'error' : findings.some((f) => f.severity === 'warning') ? 'warning' : 'info', findings };
}

export function describeCompatibility(report: MappingCompatibilityReport): string[] {
  return report.findings
    .filter((finding) => finding.severity !== 'info')
    .map((finding) => `${finding.severity.toUpperCase()} ${finding.subject}: ${finding.message}`);
}

export function compatibilityPrimaryError(report: MappingCompatibilityReport): CompatibilityFinding | undefined {
  return report.findings.find((finding) => finding.severity === 'error');
}

export function mappingSummaryLines(descriptor: MappingDescriptor): string[] {
  const lines: string[] = [];
  lines.push(`Mapping format: ${descriptor.format}`);
  lines.push(`Provider: ${descriptor.providerId}`);
  lines.push(`Namespaces: ${descriptor.namespaces.map((entry) => `${entry.name} (${entry.side})`).join(', ')}`);
  lines.push(`Source namespace: ${descriptor.primaryNamespace}`);
  lines.push(`Target namespace: ${descriptor.targetNamespace}`);
  if (descriptor.mappingVersion !== undefined) lines.push(`Mapping version: ${descriptor.mappingVersion}`);
  lines.push(`Minecraft version: ${descriptor.minecraft.version ?? 'unknown'} (confidence ${descriptor.minecraft.confidence})`);
  lines.push(`Class entries: ${descriptor.entryCounts.classes}`);
  lines.push(`Field entries: ${descriptor.entryCounts.fields}`);
  lines.push(`Method entries: ${descriptor.entryCounts.methods}`);
  lines.push(`Parameter entries: ${descriptor.entryCounts.parameters}`);
  lines.push(`Files: ${descriptor.fileCount}`);
  for (const file of descriptor.files.slice(0, 10)) {
    lines.push(`  ${path.basename(file.path)} (${file.sizeBytes} bytes)`);
  }
  if (descriptor.parchment !== undefined) {
    lines.push(`Parchment: ${descriptor.parchment.name ?? 'unknown'} ${descriptor.parchment.version ?? ''}`.trim());
  }
  for (const note of descriptor.notes) lines.push(`Note: ${note}`);
  for (const provenance of descriptor.provenance) lines.push(`Evidence: ${provenance}`);
  return lines;
}