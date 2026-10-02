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

* Node.js 22.0 or newer
* Windows, Linux or macOS on x64 or arm64
* No system Java, Gradle or Minecraft installation is required; JMC provisions a
  managed JDK matching the project's target. Minecraft 26.1 and newer require
  Java 25, and JMC provisions it the same way it provisions Java 8 for a 1.12.2
  ForgeGradle 2 build.

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
| `jmc update` | Check GitHub for a newer JMC release |
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
| `--clean` | Re-run the delegated tasks rather than reusing up-to-date outputs |
| `--force` | Refresh remote dependency metadata instead of reusing cached resolutions |
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
| Fabric (Loom) | Verified by a real end-to-end build | `tests/integration/fabric-26.3-autotool.test.mjs` builds `fixtures/fabric-26.3-autotool` with Minecraft 26.3, Fabric Loom 1.17.21, Fabric Loader 0.19.5 and Gradle 9.6.0, both directly through the fixture's own Gradle wrapper and again through JMC, then asserts DISCOVER, RESOLVE, PREPARE, COMPILE, PACKAGE and VALIDATE pass and inspects the published JAR |
| Generic Gradle (`java` plugin) | Verified by a real end-to-end build | CI compiles, packages, validates and reports on a plain Gradle project |
| NeoForge (ModDevGradle 2.x) | Verified by a real end-to-end build | `tests/integration/loader-builds.test.mjs` builds the `neoforge-1.21` fixture and asserts COMPILE, PACKAGE and VALIDATE all pass |
| Forge (ForgeGradle 2.x to 7.x) | Detected and parsed only | Per-plugin Gradle and JDK rules are covered by tests, and a real 1.12.2 build selects Gradle 4.10.3 with a managed Java 8 runtime, but ForgeGradle 2.3 no longer resolves from the live Forge maven so the end-to-end build is not claimed |
| Quilt (Quilt Loom) | Detected and parsed only | Fixtures cover detection; no end-to-end build is run in CI |
| Maven | Detected and parsed only | Fixtures cover detection and dependency coordinates |

A loader marked "detected and parsed only" has its detection, loader metadata
extraction, toolchain selection and validation rules covered by tests, but no
supported end-to-end build in this repository. No loader row should be read as a
claim that a real build passed unless it is marked verified.

### The Minecraft 26.3 AutoTool fixture

`fixtures/fabric-26.3-autotool` is a real Fabric mod, not a stub. It targets the
versions Fabric currently publishes for Minecraft 26.3 and exists so a synthetic
test cannot pass while a real loader build fails.

| Aspect | Value |
| --- | --- |
| Minecraft | 26.3 (`com.mojang:minecraft:26.3`) |
| Fabric Loom | 1.17.21, plugin id `net.fabricmc.fabric-loom` |
| Fabric Loader | 0.19.5 |
| Fabric API | 0.161.0+26.3 |
| Gradle | 9.6.0 through the committed wrapper |
| Java | 25, the version Minecraft 26.3 requires |
| Mappings | none requested: Minecraft 26.3 publishes no obfuscation mappings |
| Production artifact | `build/libs/jmc-autotool-1.0.0.jar` |

The mod implements an AutoTool: while a block is being broken it inspects the
hotbar and switches to a slot that mines the target faster, using the game's own
`ItemStack.getDestroySpeed(BlockState)` semantics rather than a hard-coded
block-to-tool table. It only ever changes the selected slot. It is enabled by
default and toggled with `/jmctool on`, `/jmctool off` and `/jmctool status`.

`tests/integration/fabric-26.3-autotool.test.mjs` verifies, from a cleaned
fixture each time:

1. The fixture's own `gradlew build` succeeds and produces the Loom artifact.
2. JMC builds the same fixture and DISCOVER, RESOLVE, PREPARE, COMPILE, PACKAGE
   and VALIDATE all pass.
3. The JAR JMC publishes is byte-identical to the Loom production JAR Loom
   built, so the real artifact is selected rather than something rebuilt.
4. The JAR is a valid archive whose `fabric.mod.json` parses, carries mod id
   `jmc_autotool`, version `1.0.0`, a Minecraft `~26.3` dependency, the client
   entrypoint and the `fabric-client-gametest` entrypoint, with both entrypoint
   classes packaged.
5. The AutoTool selection scenarios pass.
6. The mod loads in a real Minecraft 26.3 client: Fabric Loader starts,
   discovers `jmc_autotool`, runs the client entrypoint and completes the
   runtime checks registered under `fabric-client-gametest`.

Two stages are not asserted as `pass` because Loom does not expose them:
`REMAP` is reported as skipped, since Loom 1.17 remaps inside its own `jar` task
and publishes no separate remap task for JMC to invoke, and `RUNTIME_TEST` is
reported as skipped because JMC's own sandbox does not launch a client. The
client load is verified by step 6 instead.

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
build of a project and requires explicit authorization. The approval is a SHA-256
digest over the relative path and the contents of the build scripts JMC collects:
the root and subproject build and settings files, `buildSrc`, included builds, the
Gradle and Maven wrapper files, the `gradle` directory including
`libs.versions.toml`, `.mvn` configuration, every `pom.xml`, and the targets of
`apply from:` statements that resolve to a local file. Changing any collected
script revokes the approval, and a bare `touch` does not. JMC does not collect
`package.json`, a remote `apply from:` URL, a `settings.d` script, or a Gradle init
script supplied outside the project; a project that relies on those is not fully
covered by the approval.

Downloads are verified against the checksum the source publishes. A Gradle
distribution must match the published `SHA-256` or the wrapper's
`distributionSha256Sum`, and is refused when neither can be obtained. Minecraft
client, server, mappings and library artifacts are verified against the SHA-1 the
Mojang version manifest publishes, and the cache stores the algorithm that was
actually checked. A managed JDK is installed only when Adoptium publishes a
SHA-256 for it.

Reuse is verified rather than assumed. A cached Gradle archive is re-hashed
against its marker on every reuse, and the extracted tree is reinstalled from the
verified archive when it carries no installation record or its record does not
match, so the distribution JMC executes is the one that was verified. A managed
JDK is discarded unless its recorded archive checksum still matches the archive on
disk. Entries that fail verification are discarded instead of being reused.
`--offline` guarantees no network requests are made.

## Updates

Every command checks GitHub for a newer release in the background and prints a
short notice near the end of its output when one exists:

```
JMC update available: 1.0.0 → 1.1.0
Release: Release 1.1.0
Latest changes:
- Fixed
- Fixed Fabric/Loom production artifact detection
- Added
GitHub: https://github.com/thecoolersyn/JavaModCompiler/releases/tag/v1.1.0
```

`jmc update` forces a fresh check and prints the installed version, the latest
version, a bounded release-note summary and the release URL. JMC never installs
anything on its own. The check is skipped entirely with `--offline` and in
`--quiet` mode, adds no output in `--json` mode, never changes a command's exit
code, and reuses a cached result for six hours so at most one request is made per
six hours. An unreachable, rate-limited or malformed GitHub response is recorded
and ignored, and the command continues.

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
