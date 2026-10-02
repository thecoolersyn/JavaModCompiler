# JMC

JMC is the Java Mod Compiler: a universal command-line tool that compiles, remaps,
validates and packages Minecraft mods and clients across Minecraft versions and
toolchains, driven entirely from a terminal. This was built because Claude was giving me errors and crashes when building a client.

```bash
cd ./productionmod
jmc mappings-26.2 mod.jar
```

The project directory is the current working directory. The first positional
argument is the mappings directory or mapping file. The second positional
argument is the exact output artifact path. Everything else, including the
Minecraft version, loader, Java version, Gradle distribution and dependency
repositories, is detected from the project and supplied by JMC when missing.

## Requirements

* Node.js 20.10 or newer
* Windows, Linux or macOS on x64 or arm64
* No system Java, Gradle or Minecraft installation is required

CI runs on Linux, Windows and macOS, on x64 runners only. arm64 is untested in
CI: the platform and architecture detection paths exist and `npm run package`
produces an arm64 release archive, but no build in this repository is executed on
arm64.

## Install

Linux and macOS:

```bash
./scripts/install.sh
```

Windows:

```powershell
.\scripts\install.ps1
```

Both scripts build the bundle if needed, copy the launcher into the JMC home
directory, add that directory to PATH and verify the installation. A local npm
install is also available:

```bash
npm run build
npm run install-local
```

This repository is not published to a public npm registry. The npm package is
named `@thecoolersyn/jmc`, and `npm install --global jmc` would install an
unrelated package. Use the scripts above, or link a clone with `npm link`, to get
the `jmc` launcher on PATH.

After installation `jmc` resolves from any directory:

```bash
cd ~/Projects/MyMod
jmc mappings-26.2 mod.jar

cd C:\Projects\MyMod
jmc mappings-26.2 mod.jar

cd /home/user/project
jmc mappings-26.2 mod.jar
```

## Commands

| Command | Purpose |
| --- | --- |
| `jmc <mappings> <output.jar>` | Build the project in the current directory |
| `jmc --project <path> <mappings> <out>` | Build a project in another directory |
| `jmc build [project] --out <file>` | Build using project configuration only |
| `jmc doctor` | Verify installation, PATH, OS, Java, Gradle, network and cache |
| `jmc detect [project]` | Report the detected project configuration |
| `jmc mappings <path>` | Inspect a mappings directory or file |
| `jmc dependencies [project]` | Resolve and print the dependency graph |
| `jmc plugins` | List built-in adapters and installed plugins |
| `jmc cache` | Show cache section sizes |
| `jmc init [project]` | Write a `jmc.json` configuration file |
| `jmc --help` | Show usage |
| `jmc --version` | Show the JMC version |

### Options

| Option | Effect |
| --- | --- |
| `--project <path>` | Project directory, defaults to the working directory |
| `--out <file.jar>` | Output artifact when using `build` without positional arguments |
| `--minecraft <version>` | Target Minecraft version override |
| `--loader <loader>` | Force a loader adapter |
| `--java <major>` | Java major version override |
| `--offline` | Never perform network requests |
| `--debug` | Debug logging, raw build output, retained workspace |
| `--verbose` | Info-level logging |
| `--quiet` | Only failures and the final status |
| `--json` | Machine-readable JSON only |
| `--keep-workspace` | Retain the isolated workspace |
| `--runtime-test` | Launch Minecraft in a disposable sandbox |
| `--no-cache` | Bypass the JMC cache |
| `--clean` | Clear build outputs first |
| `--force` | Ignore cached decisions |
| `--yes` | Authorize build script execution without prompting |

### Examples

```bash
jmc mappings-26.2 mod.jar
jmc mappings-26.2 mod.jar --debug
jmc mappings-26.2 ./build/mod.jar
jmc mappings-26.2 mod.jar --runtime-test
jmc mappings-26.2 mod.jar --offline
jmc --project ./productionmod mappings-26.2 mod.jar
jmc detect .
jmc mappings ./mappings-26.2
jmc dependencies .
jmc doctor
```

## Build status

JMC reports every stage with an explicit tag and never hides underlying output.

```text
[PASS] Environment and Project
[PASS] Dependencies
[DOWNLOAD] Downloading JDK 21 (aarch64)
[PASS] Toolchain and Mappings
[PASS] Compilation
[PASS] Remapping
[PASS] Packaging
[PASS] Static Validation

FINAL STATUS: [PASS]

Output:
mod.jar
```

Failure reports name the failed stage and the diagnostic:

```text
[FAILED] Dependencies

Dependency: example.group:example-library:2.4.1
Repositories checked: Maven Central, Custom Repository
Reason: Artifact not found

FINAL STATUS: [FAILED]

Failed stage: RESOLVE
Diagnostic: Dependency Resolution - 1 dependency could not be resolved
Cause: One or more artifacts are absent from every configured repository.
Suggested action: Add the repository that publishes the missing artifact to the project build configuration.
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

## Loader support

Loader support is not uniform. The table below separates the loaders JMC has
proven end to end from the loaders it only detects and parses.

| Loader | Status | Notes |
| --- | --- | --- |
| Fabric (Loom) | Verified by a real end-to-end build | CI builds a Loom project and asserts the packaged artifact |
| Generic Gradle (`java` plugin) | Verified by a real end-to-end build | CI compiles, packages, validates and reports on a plain Gradle project |
| NeoForge (ModDevGradle 2.x) | Verified by a real end-to-end build | `tests/integration/loader-builds.test.mjs` builds the `neoforge-1.21` fixture and asserts COMPILE, PACKAGE and VALIDATE all pass |
| Forge (ForgeGradle 2.x to 7.x) | Detected and parsed only | Per-plugin Gradle and JDK rules are covered by tests, and a real 1.12.2 build selects Gradle 4.10.3 with a managed Java 8 runtime, but ForgeGradle 2.3 no longer resolves from the live Forge maven so the end-to-end build is not claimed |
| Quilt (Quilt Loom) | Detected and parsed only | Fixtures cover detection; no end-to-end build is run in CI |
| Maven | Detected and parsed only | Fixtures cover detection and dependency coordinates |

A loader marked "detected and parsed only" has its detection, loader metadata
extraction, toolchain selection and validation rules covered by tests, but no
supported end-to-end build in this repository. No loader row should be read as a
claim that a real build passed unless it is marked verified.

## Architecture

```text
CLI
 ↓
JMC Core
 ↓
Toolchain Engine
 ↓
Compiler / Build System
 ↓
Validation
 ↓
Artifact
```

The build pipeline is:

```text
DISCOVER → RESOLVE → PREPARE → COMPILE → TRANSFORM → REMAP → PACKAGE → VALIDATE → OPTIONAL RUNTIME TEST → REPORT
```

The CLI depends on the core only through the engine API. The core never depends
on the CLI. A future GUI calls the same engine API. See `ARCHITECTURE.md`.

## Isolation

JMC never writes to a user Minecraft installation, a system Java or a system
Gradle. Everything lives under the JMC home directory:

```text
~/.umc/
├── bin/        launchers on PATH
├── cache/      maven, minecraft, mappings, loaders, gradle, java, transformed, remapped, artifacts
├── runtimes/   JMC-managed JDKs
├── toolchains/ toolchain metadata
├── workspaces/ isolated build workspaces
├── sandboxes/  disposable runtime sandboxes
├── logs/       build reports
└── plugins/    third-party adapters and providers
```

Set `JMC_HOME` to relocate all of it. Each build runs in
`~/.umc/workspaces/<build-id>/` with a project copy, a JMC-selected JDK and a
private Gradle user home.

## CI and agents

`--json` emits machine-readable JSON only, with no human status text, so CI
systems and development agents can consume results directly. JMC never requires
an interactive terminal in CI. The first build of a project requires explicit
authorization to run build scripts; pass `--yes` or set
`JMC_TRUST_PROJECT_SCRIPTS=1`.

## Security

A project build executes build-system code. JMC reports this clearly on the first
build of a project and requires explicit authorization. The approval covers a
SHA-256 digest of every build script the project can execute, including
subprojects, `buildSrc`, the Gradle wrapper and any `apply from:` target; changing
any of them revokes the approval. Downloads are verified against the checksum the
source publishes, and a distribution whose checksum cannot be fetched is refused
rather than installed. Cached Gradle archives and JDK installs are checksum
re-verified on reuse, and corrupt entries are discarded rather than reused.
`--offline` guarantees no network requests are made.

## Documentation

* `ARCHITECTURE.md` — module map, extension points and design rules
* `CONTRIBUTING.md` — development workflow and the zero-source-comment rule
* `docs/usage.md` — command reference with examples
* `docs/toolchains.md` — loader adapters, mapping providers and plugin interfaces
* `docs/testing.md` — test strategy and fixture layout

## Development

```bash
npm install
npm run verify           # comment scan, typecheck, unit tests
npm run test:integration # CLI, CI and end-to-end build tests
npm run build            # typecheck and bundle
```

## License

MIT
