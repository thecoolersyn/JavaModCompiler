# Usage

## The primary workflow

```bash
cd ./productionmod
jmc mappings-26.2 mod.jar
```

JMC resolves:

* Project: the current working directory
* Mappings: `./mappings-26.2`
* Output: `./mod.jar`

Nothing else needs to be specified. JMC detects the build system, Minecraft
version, loader, Java version and dependency repositories from the project, and
downloads the toolchain components it needs.

## Path forms

All of these are equivalent with respect to how the paths are resolved:

```bash
jmc mappings-26.2 mod.jar
jmc ./mappings-26.2 mod.jar
jmc ./mappings-26.2 ./build/mod.jar
jmc /absolute/path/mappings-26.2 mod.jar
jmc --project ./productionmod mappings-26.2 mod.jar
```

The mappings path is resolved against the working directory first, then against
the project root. Relative output paths are resolved against the project root.
Parent directories of the output path are created automatically.

## Commands

### doctor

Verifies the installation and the environment.

```bash
jmc doctor
jmc doctor --json
jmc doctor --offline
```

Checks the JMC executable, PATH, OS, architecture, Java, Gradle, Git, network,
cache, disk space, local Maven repositories and cached Minecraft artifacts.
Exit code is zero when no check fails.

### detect

Reports the detected project configuration before any compilation happens.

```bash
jmc detect .
jmc detect --project ./productionmod
jmc detect . --json
```

Reports the project name and path, build system, plugins, languages, source sets,
Minecraft version with its evidence, loader with its confidence and evidence,
Java target and baseline, dependencies with resolved coordinates, repositories,
loader metadata, mixin configurations and annotation processors.

### mappings

Inspects a mappings directory or file.

```bash
jmc mappings ./mappings-26.2
jmc mappings ./mappings-26.2 --json
```

Reports the detected format, the provider that recognized it, the namespaces and
their roles, the source and target namespace, the mapping version, entry counts
for classes, fields, methods and parameters, the files involved, Parchment
metadata, compatibility with the declared Minecraft version and every candidate
considered.

### dependencies

Resolves and prints the dependency graph.

```bash
jmc dependencies .
jmc dependencies . --json
```

Prints the repositories used, the graph as a tree, the number of resolved and
unresolved dependencies, and for every unresolved dependency the coordinate, the
requested version, the requesting module, the repositories checked and the cause.

### build

Builds without supplying a mappings path.

```bash
jmc build . --out ./build/mod.jar
jmc build --project ./productionmod --out release/mod.jar
```

### plugins

Lists the built-in loader adapters and any installed plugins.

```bash
jmc plugins
jmc plugins --json
```

### cache

Shows the size of each cache section.

```bash
jmc cache
jmc cache --json
```

### init

Writes a `jmc.json` configuration file into the project.

```bash
jmc init .
```

## Options

### Project selection

| Option | Effect |
| --- | --- |
| `--project <path>` | Project directory. Defaults to the working directory. |
| `--out <file.jar>` | Output artifact path for `build` without positional arguments. |

### Toolchain overrides

JMC detects the Minecraft version, loader, Java version and build system. These
options override the detected values when a project is ambiguous.

| Option | Effect |
| --- | --- |
| `--minecraft <version>` | Target Minecraft version. |
| `--loader <loader>` | Force `fabric`, `quilt`, `neoforge`, `forge` or `generic-gradle`. |
| `--java <major>` | Java major version. JMC downloads a managed JDK when required. |

### Output control

| Option | Effect |
| --- | --- |
| `--json` | Emit machine-readable JSON only. No human status text. |
| `--quiet` | Only failures and the final status. |
| `--verbose` | Info-level logging. |
| `--debug` | Debug logging, raw build output, retained workspace. |
| `--keep-workspace` | Retain the isolated workspace after a successful build. |
| `--clean` | Clear build outputs before building. |
| `--force` | Ignore cached decisions and rebuild from scratch. |
| `--no-cache` | Bypass the JMC cache for this build. |

### Network

| Option | Effect |
| --- | --- |
| `--offline` | Never perform network requests. Missing artifacts are reported. |

### Runtime

| Option | Effect |
| --- | --- |
| `--runtime-test` | Launch Minecraft inside a disposable sandbox after packaging. |

### Authorization

| Option | Effect |
| --- | --- |
| `--yes` | Authorize project build script execution without prompting. |

The environment variable `JMC_TRUST_PROJECT_SCRIPTS=1` grants the same
authorization for controlled environments.

## Runtime smoke test

```bash
jmc mappings-26.2 mod.jar --runtime-test
```

The runtime test runs after packaging. JMC provisions a disposable sandbox under
`~/.umc/sandboxes/<project>/<version>/<build-id>/`, copies the artifact into the
sandbox `mods` directory and launches Minecraft only from that sandbox. JMC never
launches a user Minecraft installation.

Three outcomes are possible and are reported distinctly:

| Output | Meaning |
| --- | --- |
| `[PASS] Runtime Smoke Test` | Minecraft started and exited cleanly in the sandbox. |
| `[FAILED] Runtime Smoke Test` | Minecraft was launched and did not start cleanly. Logs and crash indicators are reported. |
| `[INFO] Runtime Smoke Test was not executed` | The sandbox has no Minecraft installation, so no runtime behaviour was observed. |

A successful compilation is never described as a runtime pass.

## Offline builds

```bash
jmc mappings-26.2 mod.jar --offline
```

In offline mode JMC makes no network requests. Artifacts already in the JMC
cache are reused. Missing artifacts are reported with their coordinate, the
requesting module and the cause. Exit code 6 signals an offline failure caused by
a missing artifact.

To populate the cache before going offline, run the build once with network
access.

## JSON mode

```bash
jmc mappings-26.2 mod.jar --json
```

JSON mode writes exactly one JSON document to stdout and nothing else. The
document contains:

| Field | Meaning |
| --- | --- |
| `status` | `pass`, `warning` or `failed` |
| `buildId` | Build identifier, also the workspace and sandbox directory name |
| `project` | Project root |
| `output` | Output path relative to the project root |
| `outputAbsolute` | Absolute output path |
| `failedStage` | Stage that failed, absent on success |
| `durationMs` | Wall-clock build duration |
| `stages` | Per-stage status, label, duration, messages and artifacts |
| `buildPassed` | Compilation, remapping and packaging succeeded |
| `runtimeTest` | Whether the runtime test was executed and its outcome |
| `runtimeTestPassed` | `true`, `false` or absent when not executed |
| `diagnostics` | Structured diagnostics with detected values, expected values, cause and suggestions |
| `warnings` | Number of non-fatal warnings |
| `workspace` | Workspace path when it was retained |

Example:

```json
{
  "status": "failed",
  "buildId": "20260101T120000-abc",
  "output": "mod.jar",
  "failedStage": "COMPILE",
  "stages": [
    { "stage": "DISCOVER", "status": "pass", "durationMs": 28 },
    { "stage": "COMPILE", "status": "failed", "durationMs": 4190 }
  ],
  "buildPassed": false,
  "diagnostics": [
    {
      "id": "compilation-failed",
      "severity": "error",
      "title": "Compilation",
      "summary": "The build reported 1 compiler error line",
      "stage": "COMPILE",
      "detected": ["src/main/java/com/example/Broken.java:3: error: cannot find symbol"],
      "cause": "Compilation inputs reference types that are not on the compile classpath.",
      "suggestions": ["Verify that every referenced class is on the compile classpath"],
      "evidence": ["task: compileJava", "exit code: 1"],
      "rawMessages": []
    }
  ]
}
```

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | General failure |
| 2 | Invalid usage |
| 3 | Authorization required for project build scripts |
| 4 | Static validation failure |
| 5 | Runtime smoke test failure |
| 6 | Offline mode could not find a required artifact |

## Reports

Every build writes four files into the retained workspace under `logs/`:

| File | Contents |
| --- | --- |
| `build.log` | Timestamped log records and a stage summary |
| `build-report.json` | Machine-readable report including the dependency graph and diagnostics |
| `build-report.html` | Self-contained HTML report |
| `build-lock.json` | Exact build inputs for reproducibility |

Retain the workspace with `--keep-workspace` or `--debug`, and for any failed
build. The workspace is removed automatically after a successful build unless
retention is requested.

## Troubleshooting

### `Authorization required`

The first build of a project requires authorization to run build scripts. Re-run
and approve the prompt, pass `--yes`, or set `JMC_TRUST_PROJECT_SCRIPTS=1`.

### `Java 21 is required but could not be located or installed`

No installed JDK satisfies the requirement and no distribution could be
downloaded for this platform. Pass `--java <major>` to select a different version,
or run the build with network access so a managed JDK can be downloaded.

### `Dependency Resolution` failure

The output lists each missing coordinate, the requested version, the requesting
module, every repository checked and the cause. Add the repository that publishes
the artifact to the project build configuration, or use `--offline` when the
artifact is already cached.

### `Mapping Compatibility` failure

The mapping metadata does not correspond to the detected Minecraft version. The
diagnostic states the expected and actual versions. Point JMC at mappings for the
detected version, or state the intended version with `--minecraft`.

### Gradle task not found

The project does not declare the task JMC selected. Run with `--verbose` to see
which task was chosen and why. Use `--loader generic-gradle` when the project does
not implement loader-specific tasks.

### `Runtime Smoke Test was not executed`

The sandbox has no Minecraft installation. Provision a Minecraft installation into
the sandbox to exercise the runtime test. JMC never falls back to a user
installation.

## Environment variables

| Variable | Effect |
| --- | --- |
| `JMC_HOME` | Relocates the entire JMC home directory. |
| `JMC_NODE` | Node binary used by the launcher. |
| `JMC_JAVA_HOME` | Preferred JDK when several satisfy the requirement. |
| `JMC_GRADLE_MAX_HEAP` | Overrides the Gradle heap size, for example `2g`. |
| `JMC_TRUST_PROJECT_SCRIPTS` | `1` authorizes project build scripts without prompting. |
| `JMC_NON_INTERACTIVE` | `1` disables interactive prompts entirely. |
| `JMC_MAVEN_LOCAL` | Additional local Maven repository root. |
| `JMC_MAVEN_CENTRAL_URL` | Mirror URL for Maven Central. |
| `JMC_NO_COLOR` | Disables ANSI colour in console output. |
| `NO_COLOR` | Standard colour opt-out, honoured by JMC. |