export interface ParsedArguments {
  command?: string;
  positionals: string[];
  output?: string;
  project?: string;
  minecraft?: string;
  loader?: string;
  java?: number;
  offline: boolean;
  debug: boolean;
  verbose: boolean;
  quiet: boolean;
  json: boolean;
  keepWorkspace: boolean;
  runtimeTest: boolean;
  noCache: boolean;
  clean: boolean;
  force: boolean;
  yes: boolean;
  help: boolean;
  version: boolean;
  unknownFlags: string[];
  errors: string[];
}

export interface ArgumentParseResult {
  parsed: ParsedArguments;
  shorthand: boolean;
}

export const KNOWN_COMMANDS = new Set([
  'doctor',
  'detect',
  'mappings',
  'dependencies',
  'build',
  'help',
  'version',
  'plugins',
  'cache',
  'init',
]);

const BOOLEAN_FLAGS: Record<string, keyof ParsedArguments> = {
  '--offline': 'offline',
  '--debug': 'debug',
  '--verbose': 'verbose',
  '--quiet': 'quiet',
  '--json': 'json',
  '--keep-workspace': 'keepWorkspace',
  '--runtime-test': 'runtimeTest',
  '--no-cache': 'noCache',
  '--clean': 'clean',
  '--force': 'force',
  '--yes': 'yes',
  '-y': 'yes',
  '-h': 'help',
  '--help': 'help',
  '-v': 'version',
  '--version': 'version',
};

const VALUE_FLAGS: Record<string, keyof ParsedArguments> = {
  '--project': 'project',
  '-p': 'project',
  '--out': 'output',
  '--output': 'output',
  '--minecraft': 'minecraft',
  '--loader': 'loader',
  '--java': 'java',
};

export function emptyArguments(): ParsedArguments {
  return {
    positionals: [],
    offline: false,
    debug: false,
    verbose: false,
    quiet: false,
    json: false,
    keepWorkspace: false,
    runtimeTest: false,
    noCache: false,
    clean: false,
    force: false,
    yes: false,
    help: false,
    version: false,
    unknownFlags: [],
    errors: [],
  };
}

function looksLikeMappingsPath(value: string): boolean {
  if (value.startsWith('-')) return false;
  const lower = value.toLowerCase();
  return (
    lower.endsWith('.jar') ||
    lower.endsWith('.zip') ||
    lower.includes('mapping') ||
    lower.includes('mappings') ||
    /(^|\/)(tiny|tsrg|srg|yarn|intermediary|parchment|mojang)/i.test(lower)
  );
}

function looksLikeOutputPath(value: string): boolean {
  if (value.startsWith('-')) return false;
  const lower = value.toLowerCase();
  return lower.endsWith('.jar') || lower.endsWith('.zip') || lower.endsWith('.mod.jar');
}

export function parseArguments(argv: string[]): ArgumentParseResult {
  const parsed = emptyArguments();
  const rest: string[] = [];
  let index = 0;

  while (index < argv.length) {
    const token = argv[index] as string;
    if (token === '--') {
      rest.push(...argv.slice(index + 1));
      break;
    }
    if (token.startsWith('--') && token.includes('=')) {
      const separator = token.indexOf('=');
      const name = token.slice(0, separator);
      const value = token.slice(separator + 1);
      if (VALUE_FLAGS[name] !== undefined) {
        assignValue(parsed, VALUE_FLAGS[name] as string, value);
        index += 1;
        continue;
      }
      if (BOOLEAN_FLAGS[name] !== undefined) {
        parsed.unknownFlags.push(`${name}=${value}`);
        index += 1;
        continue;
      }
      parsed.unknownFlags.push(name);
      index += 1;
      continue;
    }
    const booleanTarget = BOOLEAN_FLAGS[token];
    if (booleanTarget !== undefined) {
      (parsed as unknown as Record<string, unknown>)[booleanTarget as string] = true;
      index += 1;
      continue;
    }
    const valueTarget = VALUE_FLAGS[token];
    if (valueTarget !== undefined) {
      const value = argv[index + 1];
      if (value === undefined) {
        parsed.errors.push(`${token} requires a value`);
        index += 1;
        continue;
      }
      assignValue(parsed, valueTarget as string, value);
      index += 2;
      continue;
    }
    if (token.startsWith('-') && token.length > 1) {
      parsed.unknownFlags.push(token);
      index += 1;
      continue;
    }
    rest.push(token);
    index += 1;
  }

  if (rest.length > 0) {
    const first = rest[0] as string;
    if (KNOWN_COMMANDS.has(first) && !looksLikeOutputPath(first)) {
      parsed.command = first;
      parsed.positionals = rest.slice(1);
    } else {
      parsed.command = 'build';
      parsed.positionals = rest;
    }
  } else if (parsed.help) {
    parsed.command = 'help';
  } else if (parsed.version) {
    parsed.command = 'version';
  } else {
    parsed.command = undefined;
  }

  const shorthand =
    parsed.command === 'build' &&
    parsed.project === undefined &&
    parsed.positionals.length === 2 &&
    looksLikeMappingsPath(parsed.positionals[0] as string) &&
    looksLikeOutputPath(parsed.positionals[1] as string);

  return { parsed, shorthand };
}

function assignValue(parsed: ParsedArguments, key: string, value: string): void {
  if (key === 'java') {
    const parsedJava = Number.parseInt(value, 10);
    if (Number.isNaN(parsedJava) || parsedJava <= 0) {
      parsed.errors.push(`--java requires a positive integer, received "${value}"`);
      return;
    }
    parsed.java = parsedJava;
    return;
  }
  (parsed as unknown as Record<string, string>)[key] = value;
}

export function resolveBuildArguments(parsed: ParsedArguments): {
  mappingsPath?: string;
  outputPath?: string;
  projectRoot: string;
  errors: string[];
} {
  const errors: string[] = [...parsed.errors];
  const projectRoot = parsed.project ?? process.cwd();
  if (parsed.command !== 'build') {
    return { projectRoot, errors };
  }
  let mappingsPath: string | undefined;
  let outputPath: string | undefined;
  const positionals = parsed.positionals;
  const explicitOutput = parsed.output !== undefined;
  if (explicitOutput) outputPath = parsed.output;

  if (explicitOutput) {
    const projectCandidates = positionals.filter((value) => !looksLikeOutputPath(value));
    if (projectCandidates.length > 1) {
      errors.push(`Build accepts at most one project directory when --out is used, received ${projectCandidates.length}`);
    } else if (projectCandidates.length === 1) {
      return { mappingsPath: undefined, outputPath, projectRoot: projectCandidates[0] as string, errors };
    }
    return { outputPath, projectRoot, errors };
  }

  if (positionals.length === 2) {
    mappingsPath = positionals[0];
    outputPath = positionals[1];
  } else if (positionals.length === 1) {
    if (looksLikeOutputPath(positionals[0] as string)) outputPath = positionals[0];
    else mappingsPath = positionals[0];
  } else if (positionals.length > 2) {
    errors.push(`Build accepts at most two positional arguments (mappings and output), received ${positionals.length}`);
  }

  return { mappingsPath, outputPath, projectRoot, errors };
}
