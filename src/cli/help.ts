export const JMC_VERSION = '1.0.0';

export interface HelpEntry {
  usage: string;
  description: string;
}

export const USAGE_LINES: string[] = [
  'jmc <mappings> <output.jar>            Build the project in the current directory',
  'jmc --project <path> <mappings> <out>  Build a project in another directory',
  'jmc build [project]                    Build using build configuration only',
  'jmc doctor                             Verify the installation and environment',
  'jmc detect [project]                   Report detected project configuration',
  'jmc mappings <path>                    Inspect a mappings directory',
  'jmc dependencies [project]             Resolve and display the dependency graph',
  'jmc plugins                            List registered plugins',
  'jmc cache                              Inspect the JMC cache',
  'jmc init                               Create a JMC configuration file in the project',
  'jmc --help                             Show this help',
  'jmc --version                          Show the JMC version',
];

export const FLAG_HELP: HelpEntry[] = [
  { usage: '--project <path>', description: 'Project directory; defaults to the current working directory' },
  { usage: '--out <file.jar>', description: 'Output artifact path when the build command is used without positional arguments' },
  { usage: '--minecraft <version>', description: 'Target Minecraft version; detected from the project when omitted' },
  { usage: '--loader <loader>', description: 'Force a loader adapter (fabric, forge, neoforge, quilt, generic-gradle)' },
  { usage: '--java <version>', description: 'Java major version to build with; detected or downloaded when omitted' },
  { usage: '--offline', description: 'Never make network requests; use only cached artifacts' },
  { usage: '--debug', description: 'Enable debug logging and retain the workspace and raw output' },
  { usage: '--verbose', description: 'Enable info-level logging' },
  { usage: '--quiet', description: 'Only print failures and the final status' },
  { usage: '--json', description: 'Emit machine-readable JSON only' },
  { usage: '--keep-workspace', description: 'Retain the isolated build workspace after a successful build' },
  { usage: '--runtime-test', description: 'Launch Minecraft in a disposable sandbox after packaging' },
  { usage: '--no-cache', description: 'Bypass the JMC cache for this build' },
  { usage: '--clean', description: 'Clear build outputs before building' },
  { usage: '--force', description: 'Ignore cached decisions and rebuild from scratch' },
  { usage: '--yes', description: 'Authorize project build script execution without prompting' },
];

export const EXAMPLES: string[] = [
  'jmc mappings-26.2 mod.jar',
  'jmc mappings-26.2 mod.jar --debug',
  'jmc mappings-26.2 ./build/mod.jar',
  'jmc mappings-26.2 mod.jar --runtime-test',
  'jmc mappings-26.2 mod.jar --offline',
  'jmc --project ./productionmod mappings-26.2 mod.jar',
  'jmc detect .',
  'jmc mappings ./mappings-26.2',
  'jmc dependencies .',
];

export const EXIT_CODES = {
  success: 0,
  generalFailure: 1,
  invalidUsage: 2,
  authorizationRequired: 3,
  validationFailure: 4,
  runtimeTestFailure: 5,
  offlineMissingArtifacts: 6,
} as const;

export function helpText(): string {
  const lines: string[] = [];
  lines.push('JMC - Java Mod Compiler');
  lines.push('');
  lines.push('Usage:');
  for (const line of USAGE_LINES) lines.push(`  ${line}`);
  lines.push('');
  lines.push('Options:');
  for (const entry of FLAG_HELP) lines.push(`  ${entry.usage.padEnd(24)} ${entry.description}`);
  lines.push('');
  lines.push('Examples:');
  for (const example of EXAMPLES) lines.push(`  ${example}`);
  lines.push('');
  lines.push(`JMC ${JMC_VERSION}`);
  return lines.join('\n');
}