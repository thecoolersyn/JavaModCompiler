# Architecture

JMC is a layered engine with a strict dependency direction. No module imports a
module from a layer above it.

```text
┌──────────────────────────────────────────────┐
│ CLI            src/cli                       │
├──────────────────────────────────────────────┤
│ Core           src/core                      │
├──────────────────────────────────────────────┤
│ Engine         src/java src/gradle           │
│                src/mappings src/minecraft    │
│                src/deps src/remap            │
│                src/loader src/validate       │
│                src/cache src/runtime         │
│                src/security src/diagnostics  │
├──────────────────────────────────────────────┤
│ Platform       src/platform src/net          │
│                src/jar src/bytecode          │
├──────────────────────────────────────────────┤
│ Logging        src/logging                   │
└──────────────────────────────────────────────┘
```

## Layers

### Logging

`src/logging` owns structured status output. `Logger` collects records and
forwards them to sinks. `ConsoleSink` renders human readable output with
`[PASS]`, `[FAILED]`, `[WARNING]`, `[INFO]` and `[DOWNLOAD]` tags. JSON mode
installs a silent sink so that machine-readable output is never polluted by
status text. Nothing else writes to stdout or stderr.

### Platform

`src/platform` abstracts everything that varies between operating systems.

* `os.ts` detects operating system, architecture, libc flavour, CI and container
  state, shell, path separator and case sensitivity.
* `fs.ts` provides a filesystem abstraction with walking, searching, size
  accounting, writable probes and safe path joining.
* `process.ts` runs child processes with timeouts, output limits, streaming
  callbacks and both asynchronous and synchronous execution.
* `paths.ts` resolves the JMC home directory and every section beneath it.
* `resources.ts` derives memory, heap and concurrency budgets from the host.

No engine module contains an operating system conditional.

### Network

`src/net` contains the downloader and archive handling. `download.ts` classifies
failures into DNS, timeout, TLS, HTTP status, connection reset, partial download,
offline and checksum categories, retries only recoverable failures and validates
checksums when the source publishes them. `archive.ts` extracts ZIP and TAR
archives with traversal protection, preserving the executable bit for launchers.

### Jar and bytecode

`src/jar` reads and writes ZIP archives directly. `zip.ts` parses the central
directory with ZIP64 support and verifies CRCs. `jar.ts` inspects artifacts and
writes reproducible JARs. `manifest.ts` parses JAR manifests.

`src/bytecode` reads class files. `class-file.ts` parses the constant pool,
fields, methods and the version pair, and converts between Java versions and class
file versions.

### Engine

`src/java` implements `JavaRuntimeManager`: it scans installed JDKs, `JAVA_HOME`,
PATH, SDKMAN, jabba, asdf, mise, Homebrew and the Windows registry, then downloads
a Temurin JDK from the Adoptium API when nothing satisfies the requirement.
Managed runtimes live in `~/.umc/runtimes/` and the system installation is never
modified.

`src/gradle` prefers the project Gradle wrapper. When the project has no wrapper,
JMC resolves a compatible version from per-plugin compatibility rules, verifies
the published SHA-256 of the distribution before it is installed, re-verifies the
cached archive and its marker on reuse, and invokes it with a private
`GRADLE_USER_HOME`. A distribution whose checksum cannot be fetched is refused
rather than installed. Each rule carries its own Gradle range and JDK major, so a
1.12.2 ForgeGradle 2 build selects Gradle 4 with Java 8 while a Fabric Loom build
selects Gradle 8 with Java 17. An empty rule intersection is reported with the
conflicting plugins instead of silently choosing a version.

`src/mappings` is the mapping subsystem. `MappingProvider` implementations detect
and describe mapping sets. The registry probes every provider, scores the
candidates and picks the most credible one. `compatibility.ts` evaluates
compatibility between mappings, Minecraft version, loader and Java without any
hardcoded version list. Providers exist for Tiny v1 and v2, TSRG, TSRG2, SRG,
ProGuard-like formats, Yarn, Intermediary, Mojang and Parchment.

`src/minecraft` holds version abstraction and `MinecraftArtifactManager`.
`version.ts` parses arbitrary version identifiers including snapshot and numeric
eras and derives the era and family key without a whitelist.
`artifact-manager.ts` resolves client, server, mappings, libraries and asset
indexes from the Mojang manifest into the isolated cache.

`src/deps` implements dependency resolution. `pom-parser.ts` parses POM documents
with property interpolation. `maven-resolver.ts` resolves coordinates against
ordered repositories, fetches POMs, walks transitive graphs, honours optional
dependencies, exclusions and scopes, and records conflicts. `local-resolver.ts`
inspects local JARs including nested JARs and loader manifests.

`src/remap` rewrites class files. `class-writer.ts` parses and re-emits class
files while rewriting the constant pool. `service.ts` applies a mapping tree to a
JAR, remapping class names, field and method names, descriptors and mixin
configuration targets, while leaving JDK and library classes untouched.

`src/loader` is the adapter layer. `ModLoaderAdapter` declares `detect`, `plan`,
`configureCompiler`, `configureMappings`, `configureRemapping`,
`configurePackaging`, `validate` and `runtimeTest`. Adapters exist for Fabric,
Quilt, NeoForge and Forge, all derived from `GenericGradleAdapter`, which
delegates to the project's own build tasks inside the isolated environment.
Packaging rejects a build that produced only a development JAR, and rejects a
remapping loader's output when the selected artifact is not a remapped JAR.

`src/validate` implements static validation. `bytecode.ts` checks class file
versions, duplicate classes, package and path consistency, JAR integrity, unsafe
archive entries and loader metadata. `mixin.ts` parses mixin configurations,
resolves declared targets and reports missing mixin classes, shadow members,
injection points, refmaps and environment mismatches. It also resolves the mixin
configurations that `fabric.mod.json` and `quilt.mod.json` declare, and requires
both the configuration and every class it names to be present in the artifact.
`sides.ts` classifies client-only, server-only and common classes and detects
server code that references client-only types.

`src/cache` implements the validated content cache. `ContentCache` stores
artifacts per repository and toolchain, verifies checksums on reuse, removes
corrupt entries and prevents reuse across incompatible toolchains.

`src/runtime` implements the disposable runtime sandbox and crash classification.
`src/security` implements build script authorization: the approval digest is a
SHA-256 over the relative path and the contents of every build script the project
can execute, covering subprojects, `buildSrc`, included builds, `apply from:`
targets, the Gradle wrapper and Maven configuration. `--yes` and
`JMC_TRUST_PROJECT_SCRIPTS=1` authorize a single run and never persist a record.
`src/diagnostics` converts raw build output into structured, evidence-based
diagnostics.

### Core

`src/core` composes the engine. `types.ts` declares the context, stage, adapter
and diagnostic contracts. `context.ts` constructs an isolated workspace and wires
services. `pipeline.ts` executes stages, records status, duration, messages,
diagnostics and artifacts, and stops at the first mandatory failure.
`build-runner.ts` orchestrates discovery, loader planning, the remaining stages
and report generation.

### CLI

`src/cli` parses arguments, dispatches commands and renders output. It depends on
the core and engine, never the reverse. `index.ts` exposes the same engine APIs
that the CLI uses, so a GUI or an agent can drive builds without the CLI.

## Pipeline stages

| Stage | Responsibility |
| --- | --- |
| `DISCOVER` | Detect the project, authorize build scripts, resolve the Minecraft version, probe mappings, validate mapping compatibility, select a loader adapter |
| `RESOLVE` | Resolve every declared dependency including transitive dependencies, local JARs and version catalog aliases |
| `PREPARE` | Resolve or download the JDK, resolve or download Gradle, stage mappings, verify Minecraft artifacts |
| `COMPILE` | Execute the loader's compile task, or invoke `javac` directly for non-Gradle projects |
| `TRANSFORM` | Execute loader-specific transformation tasks when they exist |
| `REMAP` | Execute the remap task when the project declares one, otherwise report that the delegated toolchain owns remapping |
| `PACKAGE` | Select the correct final artifact from build output and copy it to the requested path |
| `VALIDATE` | Run bytecode, JAR integrity, metadata, mixin, client/server, dependency, loader, plugin and remapping checks |
| `RUNTIME_TEST` | Launch Minecraft inside a disposable sandbox when requested |
| `REPORT` | Write `build.log`, `build-report.json`, `build-report.html` and `build-lock.json` |

Every stage returns status, duration, messages, diagnostics and artifacts.

## Design rules

1. No hardcoded Minecraft version lists. Versions are parsed structurally and
   resolved from metadata, never compared against an enumeration.
2. No loader-specific assumptions in core logic. Core asks an adapter what to do.
3. No silent error suppression. Failures produce diagnostics with evidence.
4. No fake compilation, validation or dependency resolution. Every pass message
   corresponds to work that actually ran.
5. Isolation by default. Nothing outside the JMC home and the requested output
   path is written.
6. Reproducibility. `build-lock.json` records the exact inputs of a build.
7. Static success is never presented as runtime proof. Mixin and client/server
   validation state explicitly that runtime behaviour was not executed.
8. Zero comments in JMC-authored source.

## Extension points

A plugin lives in `~/.umc/plugins/` and may export any of:

| Export | Purpose |
| --- | --- |
| `adapters` | `ModLoaderAdapter` implementations |
| `mappingProviders` | `MappingProvider` implementations for new mapping formats |
| `validators` | Extra static validation with custom diagnostics |
| `name`, `version`, `capabilities` | Plugin metadata |

Registering a mapping provider makes a previously unrecognized mapping format
buildable without touching the core engine. See `docs/toolchains.md`.