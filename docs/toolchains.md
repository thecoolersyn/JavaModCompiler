# Toolchains

## How JMC resolves a toolchain

JMC never assumes a Minecraft version, loader or build system. Resolution is
evidence-based and happens in this order:

1. Explicit flags, `--minecraft`, `--loader`, `--java`.
2. Gradle properties such as `minecraft_version`, `minecraft_version`, `version`.
3. Plugin versions declared in the build file.
4. Dependency coordinates declared in the build file.
5. Loader metadata such as `fabric.mod.json`, `mods.toml` or `quilt.mod.json`.
6. Mapping metadata.
7. Cached version metadata.

Each candidate is recorded with its source and a weight, and the strongest
candidate wins. The full evidence list appears in `jmc detect` and in the JSON
report, so a wrong resolution is always traceable.

## Version abstraction

`src/minecraft/version.ts` parses a version identifier structurally:

```text
1.7.10     classic release, era classic, family 1.7
1.12.2     classic release, era 1.12, family 1.12
1.16.5     classic release, era 1.16-1.17, family 1.16
1.20.1     classic release, era modern, family 1.20
24w14a     snapshot
21.1.72    numeric era
1.21.4     classic release, era modern, family 1.21
```

The parser produces major, minor, patch, snapshot and release flags, a scheme, an
era label and a family key. Nothing is compared against a version list, so future
and historical identifiers work without code changes.

Java baselines are derived from the parsed version: Java 8 for 1.16 and earlier,
Java 16 for 1.17, Java 17 for 1.18 to 1.20.4, and Java 21 from 1.20.5 onward. A
project toolchain declaration always takes precedence over the baseline.

## Loader adapters

An adapter declares what the toolchain needs. JMC asks the adapter rather than
deciding for it.

| Adapter | Detects through | Compile | Transform | Remap | Package |
| --- | --- | --- | --- | --- | --- |
| Fabric | `fabric-loom`, `net.fabricmc` coordinates, `fabric.mod.json` | `classes` | `genSources` | `remapJar` | `jar` |
| Quilt | `org.quiltmc.loom`, `quilt.mod.json`, `quilted_fabric.json` | `classes` | `genSources` | `remapJar` | `jar` |
| NeoForge | `net.neoforged.moddev`, `neoforge.mods.toml` | `classes` | `patchClasses` | `reobfJar` | `jar` |
| Forge | `ForgeGradle`, `mods.toml`, `net.minecraftforge` coordinates | `classes` | `patchClasses` | `reobfJar` | `reobfJar` |
| Generic | any Gradle project | `classes` | none | project-declared task | `jar` |

An adapter is selected only when loader detection confidence reaches the
threshold and an adapter claims the project. Otherwise the generic adapter runs
the project's own tasks. `--loader` overrides the selection.

Task selection is validated against the tasks the project actually declares. If
the project has no `remapJar` task, JMC does not invoke one and reports that the
delegated toolchain owns remapping.

## Why delegation beats reimplementation

Loader toolchains contain years of accumulated behaviour: Loom's remapping,
ForgeGradle's userdev pipeline, NeoForge's production-mode patching. Reimplementing
them would produce wrong results. JMC instead:

1. Supplies a managed JDK with the required version.
2. Supplies a Gradle distribution, preferring the project wrapper.
3. Copies the project into an isolated workspace.
4. Injects a Gradle init script adding the repositories JMC resolved, without
   modifying the project.
5. Runs the loader's own tasks.
6. Selects the produced artifact from build output using project metadata.

Compilation, remapping and packaging are performed by the toolchain the project
already declares. JMC's own remapper is used when JMC itself performs the remap,
for example for direct JAR remapping through the public API.

## Mapping providers

| Provider | Formats | Source namespace | Target namespace |
| --- | --- | --- | --- |
| Tiny | Tiny v1, Tiny v2 | as declared in the header | as declared in the header |
| TSRG | TSRG, TSRG2, SRG | `official`, `obf` or `srg` | `named` or `srg` |
| ProGuard-like | Yarn, Intermediary, ProGuard | `official` or `intermediary` | `named` |
| Mojang | Mojang ProGuard mappings | `official` | `named` |
| Parchment | Parchment metadata | `official` | `named` |

Namespace roles are derived from the namespace names themselves. `official`,
`obf`, `srg` and `notch` are source namespaces. `intermediary` is an intermediary
namespace. `named`, `mcp` and `parchment` are target namespaces.

The registry probes every provider and scores candidates by declared format,
entry counts and version confidence. The most credible candidate wins, and every
candidate is reported.

### Mapping compatibility

Compatibility is evaluated between the mappings, the resolved Minecraft version,
the loader and the Java version. Findings have severities:

| Severity | Meaning | Effect |
| --- | --- | --- |
| `info` | Informational, no action needed | None |
| `warning` | Suspect but not provably wrong | Reported as a warning |
| `error` | Provably inconsistent | Fails the build |

A mappings-to-Minecraft mismatch is an error when the mapping metadata states the
version with high confidence and a warning when the version was inferred from a
file name. An unverified relationship is never silently accepted.

## Mappings argument versus loader-supplied mappings

A mappings argument and a remapping loader can both describe the namespace the
build compiles against, and JMC treats them differently.

* For loaders that own their mappings, the delegated build decides. Loom reads
  the `mappings` configuration from the project build file, ModDevGradle reads its
  `neoForge { mappings { ... } }` or `minecraft { mappings channel: ... }` block,
  and ForgeGradle reads its `minecraft { mappings }` setting. JMC stages the files
  you passed into the workspace mappings directory, records them in the build lock
  and validates that they are a format it can read, but it does not inject them
  into the loader's configuration. The loader's own mappings win.
* For a project that does not use a remapping loader, the generic adapter runs the
  project's own tasks, and the staged mappings are what JMC itself can read when it
  has to validate or report namespaces.
* Version compatibility is always checked. If the staged mappings declare a
  Minecraft version that contradicts the version the project resolves to, JMC fails
  the build at `DISCOVER` with a `minecraft-mapping-mismatch` diagnostic, even when
  a loader would have ignored the argument. A silent contradiction is reported
  rather than ignored.
* Passing a mappings path that does not exist fails the build at `DISCOVER` with
  `mappings-path-missing`, and a directory JMC cannot identify a mapping provider
  for fails there with `mappings-format-unknown`. Neither failure reaches the
  delegated build.

In short: the mappings argument is validated and recorded, but for Loom,
ModDevGradle and ForgeGradle the effective mappings are the ones the project
declares.

## Plugins

Plugins live in `~/.umc/plugins/`. A plugin is a JavaScript module, or a directory
with a `package.json`.

```javascript
export const name = 'acme-toolchain';
export const version = '1.0.0';
export const capabilities = ['mappings', 'validator'];

export const mappingProviders = [
  {
    descriptor: {
      id: 'acme',
      name: 'Acme mappings',
      formats: ['acme'],
      extensions: ['.acme'],
      namespaces: [],
      detectConfidence: () => 80,
    },
    async probe(directory) {
      return {
        format: 'acme',
        formatConfidence: 80,
        providerId: 'acme',
        namespaces: [
          { name: 'official', side: 'primary' },
          { name: 'named', side: 'target' },
        ],
        primaryNamespace: 'official',
        targetNamespace: 'named',
        minecraft: { confidence: 'none' },
        entryCounts: { classes: 0, fields: 0, methods: 0, parameters: 0 },
        fileCount: 0,
        totalBytes: 0,
        files: [],
        provenance: [],
        notes: [],
        directory,
      };
    },
  },
];
```

A mapping provider plugin makes an unrecognized mapping format buildable without
changing the core engine.

### Loader adapter plugin

```javascript
export const adapters = [
  {
    id: 'acme-loader',
    displayName: 'Acme Loader',
    detect(project) {
      if (!project.modMetadata.some((metadata) => metadata.kind === 'acme.json')) return undefined;
      return { id: 'acme-loader', displayName: 'Acme Loader', buildTasks: ['build'], notes: [] };
    },
    async plan(project, context) {
      return {
        adapterId: 'acme-loader',
        buildTasks: ['build'],
        notes: [],
        gradleArguments: [],
        buildTaskArguments: [],
        properties: {},
      };
    },
    async configureCompiler() {},
    async configureMappings() {},
    async configureRemapping() {},
    async configurePackaging() {},
    async validate(artifactPath) {
      return [];
    },
  },
];
```

### Validator plugin

```javascript
export const validators = [
  {
    id: 'acme-policy',
    async validate({ artifactPath }) {
      return [];
    },
  },
];
```

Plugin validators run during the `VALIDATE` stage and their diagnostics appear in
the console output, the JSON report and the HTML report.

## Repositories

JMC resolves dependencies against repositories in priority order:

1. The local Maven repository, when present.
2. Repositories declared by the project build, with the built-in equivalents of
   `mavenCentral`, `mavenLocal`, `google` and `gradlePluginPortal`.
3. Built-in loader repositories: Fabric, Forge, NeoForge, Quilt, JitPack.
4. Any additional repository declared by the project.

When a project declares no repositories, JMC injects an init script adding the
repositories it resolved so the delegated build can resolve the same artifacts.
The project files are never modified.

Resolution walks transitive dependencies through POM documents, honours optional
dependencies, exclusions and dependency management, and records conflicts. Missing
artifacts are reported with their coordinate, requested version, requesting
module, every repository checked and the cause.

## Java runtime management

`JavaRuntimeManager` searches, in order:

1. `JAVA_HOME`
2. Managed runtimes under `~/.umc/runtimes/`
3. Platform directories such as `/usr/lib/jvm`, `/Library/Java/JavaVirtualMachines`
   and the Windows program files directories
4. SDKMAN, jabba, asdf, mise and Homebrew
5. The Windows registry
6. `java` on PATH

When nothing satisfies the requirement, JMC queries the Adoptium API for a
Temurin JDK matching the operating system and architecture, verifies the published
SHA-256 checksum, extracts it into `~/.umc/runtimes/` and uses it. The system
installation is never modified. Only the JMC-selected `JAVA_HOME` is exposed to
the build process.

If the exact version is unavailable, JMC tries successive higher versions that
satisfy the requirement and reports the version actually used.

## Gradle management

The project wrapper is preferred whenever it exists. When it does not, JMC
resolves a compatible Gradle version, downloads the distribution into
`~/.umc/cache/gradle/` and invokes it with:

* `--no-daemon` so no background process survives the build
* `--stacktrace` so failures carry a full trace
* a private `--project-cache-dir` inside the workspace
* a private `GRADLE_USER_HOME` inside the workspace
* `--offline` when offline mode is requested
* a heap size derived from host memory, never consuming all system RAM

## Resource budgeting

`src/platform/resources.ts` derives budgets from the host:

| Setting | Rule |
| --- | --- |
| Gradle heap | 35% of total memory, clamped to 512 MiB and 4 GiB |
| Compiler heap | 25% of total memory, clamped to 256 MiB and 2 GiB |
| Download concurrency | 2 to 8, limited by free memory |
| Parallel operations | Half the CPU count, clamped to 1 and 4 |

`JMC_GRADLE_MAX_HEAP` overrides the Gradle heap. The budgets are reported in the
JSON report so a build can be reproduced with the same limits.

## Caching and reproducibility

The cache is organized by section: `maven`, `minecraft`, `mappings`, `loaders`,
`gradle`, `java`, `transformed`, `remapped` and `artifacts`.

Entries are keyed per repository and per toolchain. On reuse JMC verifies the
recorded checksum and the recorded size. A mismatch removes the entry instead of
reusing it. Entries written by an incompatible cache format are discarded.

`build-lock.json` records the exact inputs of a build:

* Minecraft version and its evidence source
* Loader id and version
* Mappings path, format, namespaces and checksum
* Java major, version text and vendor
* Gradle version and distribution URL
* Compiler release and compatibility levels
* Every resolved dependency coordinate, version, repository and checksum
* Every repository URL
* The output artifact checksum
* JMC version, cache format, Node version and platform

Two builds with identical lock files used identical inputs.