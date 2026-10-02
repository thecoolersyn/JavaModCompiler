import type { Diagnostic, StageId } from '../core/types.js';

export interface DiagnosticSignal {
  id: string;
  pattern: RegExp;
  severity: Diagnostic['severity'];
  title: string;
  extract: (match: RegExpExecArray, context: DiagnosticContext) => Diagnostic;
}

export interface DiagnosticContext {
  stage: StageId | string;
  rawOutput: string;
  detectedJavaTarget?: number;
  activeJavaMajor?: number;
  requestedJavaMajor?: number;
  detectedMinecraft?: string;
  detectedLoader?: string;
  detectedBuildSystem?: string;
  mappingsFormat?: string;
  mappingsVersion?: string;
  evidence: string[];
}

interface EngineRule {
  id: string;
  applies(context: DiagnosticContext): boolean;
  classify(context: DiagnosticContext): Diagnostic | undefined;
}

function evidenceFrom(text: string, limit = 6): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(-limit);
}

function firstNumber(context: DiagnosticContext): number | undefined {
  const order: Array<keyof DiagnosticContext> = ['detectedJavaTarget', 'activeJavaMajor', 'requestedJavaMajor'];
  for (const key of order) {
    const value = context[key];
    if (typeof value === 'number') return value;
  }
  return undefined;
}

const UNSUPPORTED_CLASS_FILE: EngineRule = {
  id: 'unsupported-class-file-major-version',
  applies: (context) => /Unsupported class file major version|class file has wrong version|bad class file/i.test(context.rawOutput),
  classify: (context) => {
    const majorMatch = /major version (\d+)/i.exec(context.rawOutput);
    const requiredClassFile = majorMatch !== null ? Number.parseInt(majorMatch[1], 10) : undefined;
    const requiredJava = requiredClassFile !== undefined ? Math.max(0, requiredClassFile - 44) : undefined;
    const detectedTarget = context.detectedJavaTarget ?? firstNumber(context);
    const active = context.activeJavaMajor;
    const parts: string[] = [];
    if (detectedTarget !== undefined) parts.push(`Detected compiler target: ${detectedTarget}`);
    if (active !== undefined) parts.push(`Active Java runtime: ${active}`);
    if (requiredJava !== undefined) parts.push(`Class file version required: ${requiredClassFile}`);
    const cause =
      active !== undefined && requiredJava !== undefined && requiredJava > active
        ? `The build input was compiled to class file version ${requiredClassFile}, which requires a Java ${requiredJava} runtime, but the active runtime is Java ${active}.`
        : active !== undefined && detectedTarget !== undefined && detectedTarget > active
          ? `The build targets Java ${detectedTarget} but the active Java runtime is ${active}.`
          : 'A class file version was produced that the active compiler or runtime cannot read.';
    const suggestions: string[] = [];
    if (requiredJava !== undefined) {
      suggestions.push(`Run the build with a Java ${requiredJava} runtime (JMC will download one automatically when --java is passed).`);
    } else if (detectedTarget !== undefined) {
      suggestions.push(`Run the build with Java ${detectedTarget} or newer.`);
    }
    suggestions.push('Check the toolchain declared by the project build file against the Java version used by the build.');
    return {
      id: UNSUPPORTED_CLASS_FILE.id,
      severity: 'error',
      title: 'Java Compatibility',
      summary: 'The build could not read a class file version that the active Java runtime does not support',
      stage: context.stage,
      detected: parts,
      expected: requiredJava !== undefined ? `Java ${requiredJava}` : undefined,
      cause,
      suggestions,
      evidence: [...context.evidence, ...evidenceFrom(context.rawOutput)],
      rawMessages: context.rawOutput.split(/\r?\n/).filter((line) => /class file|version/i.test(line)).slice(0, 20),
    };
  },
};

const COMPILATION_FAILURE: EngineRule = {
  id: 'compilation-failed',
  applies: (context) => /compilation failed|error: cannot find symbol|error: package .* does not exist|^\s*error:/im.test(context.rawOutput),
  classify: (context) => {
    const errorLines = context.rawOutput
      .split(/\r?\n/)
      .filter((line) => /\berror:|\.java:\d+|\.kt:\d+/i.test(line))
      .slice(0, 20);
    const missingSymbols = [...context.rawOutput.matchAll(/error: cannot find symbol\s*\n(?:.*\n)?\s*symbol:\s*(.+)/g)]
      .map((match) => (match[1] ?? '').trim())
      .slice(0, 10);
    const missingPackages = [...context.rawOutput.matchAll(/error: package (\S+) does not exist/g)].map((match) => match[1] as string).slice(0, 10);
    const suggestions: string[] = [];
    if (missingSymbols.length > 0) suggestions.push(`Verify that every referenced class is on the compile classpath: ${missingSymbols.join(', ')}`);
    if (missingPackages.length > 0) suggestions.push(`Verify that every referenced package is on the compile classpath: ${missingPackages.join(', ')}`);
    if (missingSymbols.length === 0 && missingPackages.length === 0) {
      suggestions.push('Read the compiler output above; the first reported error is usually the root cause.');
    }
    return {
      id: COMPILATION_FAILURE.id,
      severity: 'error',
      title: 'Compilation',
      summary: `The build reported ${errorLines.length} compiler error line${errorLines.length === 1 ? '' : 's'}`,
      stage: context.stage,
      detected: errorLines.slice(0, 5),
      cause: missingSymbols.length > 0 || missingPackages.length > 0 ? 'Compilation inputs reference types that are not on the compile classpath.' : 'The compiler reported errors that are described in the build output.',
      suggestions,
      evidence: context.evidence,
      rawMessages: errorLines,
    };
  },
};

const MIXIN_FAILURE: EngineRule = {
  id: 'mixin-application-failed',
  applies: (context) => /MixinApplyError|MixinTransformer|could not apply mixin|invalid injection point/i.test(context.rawOutput),
  classify: (context) => {
    const mixinLines = context.rawOutput
      .split(/\r?\n/)
      .filter((line) => /mixin|inject|@Shadow|InvalidInjectionException|InvalidMixinException/i.test(line))
      .slice(0, 20);
    return {
      id: MIXIN_FAILURE.id,
      severity: 'error',
      title: 'Mixin Application',
      summary: 'A Mixin transformation failed while the classes were being remapped or loaded',
      stage: context.stage,
      detected: mixinLines.slice(0, 5),
      cause: 'A Mixin target or injection point did not match the remapped classes available at transform time.',
      suggestions: [
        'Confirm the mappings namespace used at build time matches the namespace used at runtime.',
        'Check that every @Mixin target class and method descriptor exists in the target namespace.',
        'Regenerate the refmap for the target namespace if the project ships one.',
      ],
      evidence: context.evidence,
      rawMessages: mixinLines,
    };
  },
};

const JAVA_UNAVAILABLE: EngineRule = {
  id: 'java-runtime-unavailable',
  applies: (context) => /JavaRuntimeUnavailableError|No Java \d+ runtime is available|Adoptium returned HTTP/i.test(context.rawOutput),
  classify: (context): Diagnostic => {
    const requested = /No Java (\d+) runtime/.exec(context.rawOutput)?.[1];
    const adoptiumMatch = /Adoptium returned HTTP (\d+)/.exec(context.rawOutput);
    const adoptiumStatus = adoptiumMatch?.[1];
    const noDistribution = /no distribution is published for Java ([^\n]+)/.exec(context.rawOutput)?.[1];
    const detected: string[] = [];
    if (requested !== undefined) detected.push(`Required Java major version: ${requested}`);
    if (adoptiumStatus !== undefined) detected.push(`Adoptium API response: HTTP ${adoptiumStatus}`);
    if (noDistribution !== undefined) detected.push(`No published distribution for Java ${noDistribution}`);
    detected.push('No installed JDK satisfies the requirement');
    return {
      id: JAVA_UNAVAILABLE.id,
      severity: 'error',
      title: 'Java Runtime',
      summary:
        requested === undefined
          ? 'No Java runtime satisfying the build could be located or installed'
          : `Java ${requested} is required but could not be located or installed`,
      stage: context.stage,
      detected,
      expected: requested === undefined ? undefined : `Java ${requested} or newer`,
      cause: adoptiumStatus === '404'
        ? 'The Adoptium API has no build of the required Java version for this operating system and architecture.'
        : 'No installed runtime satisfies the requirement and no distribution could be downloaded for this platform.',
      suggestions: [
        requested === undefined
          ? 'Install a JDK manually and point JMC at it with JAVA_HOME or --java.'
          : `Install Java ${requested} or newer manually, or re-run when the download is reachable.`,
        'Pass --java <major> to select a different Java version explicitly.',
        'Use --offline to build with an already installed runtime instead of downloading one.',
      ],
      evidence: context.evidence,
      rawMessages: context.rawOutput.split(/\r?\n/).filter((line) => /Java|adoptium|runtime/i.test(line)).slice(0, 10),
    };
  },
};

const GRADLE_FAILURE: EngineRule = {
  id: 'gradle-build-failed',
  applies: (context) => /FAILURE: Build failed|What went wrong|A problem occurred evaluating|Could not resolve/i.test(context.rawOutput),
  classify: (context) => {
    const whatWentWrong = /What went wrong:\n([\s\S]*?)(?:\n\n|\nTry:|$)/.exec(context.rawOutput)?.[1];
    const couldNotResolve = [...context.rawOutput.matchAll(/Could not resolve ([^\s.]+)\./g)].map((match) => match[1] as string);
    const suggestions: string[] = [];
    if (whatWentWrong !== undefined) suggestions.push(`Address the Gradle failure: ${whatWentWrong.split('\n').filter((line) => line.trim().length > 0).slice(0, 3).join(' | ')}`);
    if (couldNotResolve.length > 0) suggestions.push(`Add a repository that serves: ${[...new Set(couldNotResolve)].join(', ')}`);
    if (/network|UnknownHost|Connection|timeout/i.test(context.rawOutput)) suggestions.push('Re-run with network access, or pre-populate the JMC cache and use --offline.');
    if (suggestions.length === 0) suggestions.push('Inspect the build log for the first failing task.');
    return {
      id: GRADLE_FAILURE.id,
      severity: 'error',
      title: 'Build System',
      summary: whatWentWrong !== undefined ? whatWentWrong.split('\n')[0] ?? 'Gradle reported a build failure' : 'Gradle reported a build failure',
      stage: context.stage,
      detected: whatWentWrong !== undefined ? whatWentWrong.split('\n').filter((line) => line.trim().length > 0).slice(0, 6) : [],
      cause: 'The delegated build system reported a failure. The exact task and message are reproduced below.',
      suggestions,
      evidence: context.evidence,
      rawMessages: context.rawOutput.split(/\r?\n/).slice(-30),
    };
  },
};

const NETWORK_FAILURE: EngineRule = {
  id: 'network-failure',
  applies: (context) => /ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|TLS|certificate|self.signed|getaddrinfo/i.test(context.rawOutput),
  classify: (context) => {
    const dns = /ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(context.rawOutput);
    const tls = /certificate|self.signed|TLS|SSL/i.test(context.rawOutput);
    return {
      id: NETWORK_FAILURE.id,
      severity: 'error',
      title: 'Network',
      summary: dns ? 'A host name could not be resolved' : tls ? 'A TLS connection could not be established' : 'A network connection failed',
      stage: context.stage,
      cause: dns
        ? 'DNS resolution failed for a repository or distribution host.'
        : tls
          ? 'The TLS certificate presented by the remote host was not trusted by this machine.'
          : 'The connection to a remote host was interrupted or timed out.',
      suggestions: [
        'Verify network access and retry the build.',
        'When the required artifacts are already cached, run with --offline to skip network access.',
        'Behind a TLS-intercepting proxy, install the proxy root certificate into the system trust store.',
      ],
      evidence: context.evidence,
      rawMessages: context.rawOutput.split(/\r?\n/).filter((line) => /ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|TLS|certificate|getaddrinfo/i.test(line)).slice(0, 20),
    };
  },
};

const DOWNLOAD_TIMEOUT: EngineRule = {
  id: 'download-timeout',
  applies: (context) => /timed out|Timeout|ETIMEDOUT|The operation was aborted due to timeout|ESOCKETTIMEDOUT/i.test(context.rawOutput),
  classify: (context): Diagnostic => {
    const url = /Request to (\S+) timed out/.exec(context.rawOutput)?.[1] ?? /([a-z]+:\/\/[^\s"']+)/i.exec(context.rawOutput)?.[1];
    return {
      id: DOWNLOAD_TIMEOUT.id,
      severity: 'error',
      title: 'Network',
      summary: 'A download exceeded its time limit',
      stage: context.stage,
      detected: [
        ...(url === undefined ? [] : [`artifact: ${url}`]),
        ...context.evidence,
      ],
      cause: 'The connection did not transfer the artifact within the allotted time. Large JDK, Gradle and Minecraft artifacts can require many minutes on a slow link.',
      suggestions: [
        'Re-run the build; partial downloads are not cached, so the transfer restarts from a clean file.',
        'Increase available bandwidth or use a local mirror through the repository configuration.',
        'Pre-populate the cache once with a reliable connection, then build with --offline.',
      ],
      evidence: context.evidence,
      rawMessages: context.rawOutput.split(/\r?\n/).filter((line) => /timed out|Timeout|ETIMEDOUT/i.test(line)).slice(0, 10),
    };
  },
};

const MISSING_TASK: EngineRule = {
  id: 'gradle-task-not-found',
  applies: (context) => /Task '[^']+' not found|Cannot locate tasks|Could not find method|UnknownTaskException/i.test(context.rawOutput),
  classify: (context): Diagnostic => {
    const task = /Task '([^']+)' not found/.exec(context.rawOutput)?.[1];
    const method = /Could not find method ([^\n(]+)/.exec(context.rawOutput)?.[1];
    return {
      id: MISSING_TASK.id,
      severity: 'error',
      title: 'Build Task',
      summary: task === undefined ? 'A Gradle method could not be resolved' : `Gradle task ${task} does not exist in this project`,
      stage: context.stage,
      detected: [
        ...(task === undefined ? [] : [`task: ${task}`]),
        ...(method === undefined ? [] : [`method: ${method}`]),
      ],
      cause:
        task === undefined
          ? 'The build script calls a Gradle API that is not available in this Gradle version.'
          : 'The selected task is not declared by this project. The task name was chosen from loader conventions rather than from the project task list.',
      suggestions: [
        'Run the build with --verbose to see which tasks JMC selected and why.',
        'Add the task to the project, or point JMC at a project whose build declares it.',
        'Use the generic Gradle adapter when the project does not implement the loader-specific tasks.',
      ],
      evidence: context.evidence,
      rawMessages: context.rawOutput.split(/\r?\n/).filter((line) => /not found|Cannot locate tasks|Could not find method/i.test(line)).slice(0, 10),
    };
  },
};

const ARTIFACT_NOT_FOUND: EngineRule = {
  id: 'artifact-not-found',
  applies: (context) =>
    /HTTP 404|Not Found in|Could not find artifact|artifact not found|Could not resolve all (?:files|artifacts)|Could not resolve/i.test(
      context.rawOutput,
    ),
  classify: (context) => {
    const coordinates = [
      ...new Set(
        [...context.rawOutput.matchAll(/(?:^|[\s'"])([\w][\w.-]*):([\w][\w.-]*):([\w][\w.+-]*)(?=[\s'"]|$)/gm)]
          .map((match) => `${match[1]}:${match[2]}:${match[3]}`)
          .filter((coordinate) => isCoordinateLike(coordinate)),
      ),
    ]
      .filter((value, index, all) => all.indexOf(value) === index)
      .slice(0, 10);
    return {
      id: ARTIFACT_NOT_FOUND.id,
      severity: 'error',
      title: 'Dependency Resolution',
      summary: coordinates.length > 0 ? `Artifacts were not found: ${coordinates.join(', ')}` : 'A required artifact was not found in any configured repository',
      stage: context.stage,
      detected: coordinates,
      cause: 'No configured repository serves the requested artifact at the requested version.',
      suggestions: [
        'Confirm the artifact coordinates and version are correct.',
        'Add the repository that publishes the artifact to the project build configuration.',
        'Check whether the artifact lives in a private repository requiring credentials.',
      ],
      evidence: context.evidence,
      rawMessages: context.rawOutput.split(/\r?\n/).slice(-20),
    };
  },
};

const PERMISSION_FAILURE: EngineRule = {
  id: 'permission-denied',
  applies: (context) =>
    /(?:^|\s)(?:EACCES|EPERM)\b|Permission denied|Access is denied|Cannot create directory|Operation not permitted/i.test(
      context.rawOutput,
    ) &&
    !/Acquiring file lock|file lock for/i.test(context.rawOutput),
  classify: (context) => {
    const paths = [...context.rawOutput.matchAll(/(?:Permission denied|EACCES)[^\n]*?(?:path |: )(\/[^\s:]+|[A-Za-z]:\\[^\s:]+)/g)].map((match) => match[1] as string);
    return {
      id: PERMISSION_FAILURE.id,
      severity: 'error',
      title: 'Filesystem',
      summary: 'The build was denied access to a path it requires',
      stage: context.stage,
      detected: paths.slice(0, 5),
      cause: 'The process running the build lacks read or write permission for the affected path.',
      suggestions: [
        'Run JMC with permission to write the JMC home directory and the project output path.',
        'Check the permissions of the project directory and the JMC cache.',
      ],
      evidence: context.evidence,
      rawMessages: context.rawOutput.split(/\r?\n/).filter((line) => /EACCES|Permission denied|Access is denied/i.test(line)).slice(0, 10),
    };
  },
};

const DISK_SPACE_FAILURE: EngineRule = {
  id: 'disk-space',
  applies: (context) => /ENOSPC|No space left on device/i.test(context.rawOutput),
  classify: (context): Diagnostic => ({
    id: DISK_SPACE_FAILURE.id,
    severity: 'error',
    title: 'Disk Space',
    summary: 'The build ran out of disk space',
    stage: context.stage,
    detected: context.rawOutput.split(/\r?\n/).filter((line) => /ENOSPC|No space left/i.test(line)).slice(0, 5),
    cause: 'The filesystem holding the workspace or the cache filled up during the build.',
    suggestions: [
      'Free disk space or point JMC_HOME at a volume with more capacity.',
      'Remove JMC cache sections that are no longer needed.',
    ],
    evidence: context.evidence,
    rawMessages: context.rawOutput.split(/\r?\n/).filter((line) => /ENOSPC|No space left/i.test(line)).slice(0, 10),
  }),
};

const RULES: EngineRule[] = [
  DISK_SPACE_FAILURE,
  PERMISSION_FAILURE,
  JAVA_UNAVAILABLE,
  MISSING_TASK,
  DOWNLOAD_TIMEOUT,
  UNSUPPORTED_CLASS_FILE,
  MIXIN_FAILURE,
  ARTIFACT_NOT_FOUND,
  NETWORK_FAILURE,
  GRADLE_FAILURE,
  COMPILATION_FAILURE,
];

export class DiagnosticEngine {
  classify(context: DiagnosticContext): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    for (const rule of RULES) {
      if (!rule.applies(context)) continue;
      const diagnostic = rule.classify(context);
      if (diagnostic !== undefined) diagnostics.push(diagnostic);
    }
    if (diagnostics.length === 0) {
      diagnostics.push(genericFailure(context));
    }
    return diagnostics;
  }

  classifyError(error: unknown, stage: StageId | string, extra: Partial<DiagnosticContext> = {}): Diagnostic[] {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? (error.stack ?? '') : '';
    return this.classify({
      stage,
      rawOutput: `${message}\n${stack}`,
      evidence: [`Stage: ${stage}`],
      ...extra,
    });
  }
}

function genericFailure(context: DiagnosticContext): Diagnostic {
  const tail = context.rawOutput.split(/\r?\n/).filter((line) => line.trim().length > 0).slice(-8);
  return {
    id: 'unclassified-failure',
    severity: 'error',
    title: 'Stage Failure',
    summary: `Stage ${context.stage} failed without a recognized diagnostic signature`,
    stage: context.stage,
    detected: tail,
    cause: 'JMC does not have a specific rule for this failure, so no additional cause can be asserted from the available evidence.',
    suggestions: [
      'Re-run with --debug to retain the full workspace and raw logs.',
      'Inspect the stage output above for the failing task or command.',
    ],
    evidence: context.evidence,
    rawMessages: tail,
  };
}

const COORDINATE_GROUP_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_-]+)+$/;
const COORDINATE_ARTIFACT_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const COORDINATE_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.+-]*$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}/;
const VERSION_LIKE_ONLY = /^[0-9.]+$/;

export function isCoordinateLike(value: string): boolean {
  const parts = value.split(':');
  if (parts.length !== 3) return false;
  const [group, artifact, version] = parts as [string, string, string];
  if (TIMESTAMP_PATTERN.test(version)) return false;
  if (TIMESTAMP_PATTERN.test(group) || TIMESTAMP_PATTERN.test(artifact)) return false;
  if (!COORDINATE_GROUP_PATTERN.test(group)) return false;
  if (!COORDINATE_ARTIFACT_PATTERN.test(artifact)) return false;
  if (!COORDINATE_VERSION_PATTERN.test(version)) return false;
  if (VERSION_LIKE_ONLY.test(group) || VERSION_LIKE_ONLY.test(artifact)) return false;
  if (group.includes(' ')) return false;
  return true;
}

export function formatDiagnostic(diagnostic: Diagnostic): string[] {
  const lines: string[] = [];
  lines.push(`${diagnostic.severity.toUpperCase()}: ${diagnostic.title}`);
  lines.push(`  ${diagnostic.summary}`);
  if (diagnostic.detected !== undefined && diagnostic.detected.length > 0) {
    lines.push('  Detected:');
    for (const item of diagnostic.detected) lines.push(`    - ${item}`);
  }
  if (diagnostic.expected !== undefined) lines.push(`  Expected: ${diagnostic.expected}`);
  if (diagnostic.actual !== undefined) lines.push(`  Actual: ${diagnostic.actual}`);
  if (diagnostic.cause !== undefined) lines.push(`  Cause: ${diagnostic.cause}`);
  if (diagnostic.suggestions.length > 0) {
    lines.push('  Suggested action:');
    for (const suggestion of diagnostic.suggestions) lines.push(`    - ${suggestion}`);
  }
  return lines;
}