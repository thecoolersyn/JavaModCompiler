# Contributing

## Zero-source-comment rule

JMC-authored source files contain zero comments. This applies to every
`.ts`, `.js`, `.mjs`, `.java`, `.kt`, `.gradle`, `.xml`, `.yaml`, `.yml`,
`.jsonc`, `.sh`, `.ps1`, `.css`, `.html` and test file in this repository.

Not allowed in source:

* `//` line comments
* `/* */` block comments
* `/** */` documentation comments
* `#` comments in scripts, Gradle files and configuration
* `<!-- -->` comments in markup
* `TODO`, `FIXME`, `XXX` and `HACK` markers
* commented-out code
* license headers in JMC-authored files, unless a license is legally required

This rule exists because JMC must be legible without a legend. Names carry the
meaning, types carry the constraints, and functions stay small.

The scan runs in CI:

```bash
npm run lint:comments
```

All human-readable technical documentation lives in Markdown: `README.md`,
`ARCHITECTURE.md`, `CONTRIBUTING.md` and `docs/`.

## Setup

```bash
npm install
```

## Commands

| Command | Purpose |
| --- | --- |
| `npm run typecheck` | TypeScript type check |
| `npm run bundle` | Bundle the CLI into `dist/bin` |
| `npm run build` | Clean, typecheck and bundle |
| `npm run lint:comments` | Zero-comment scan |
| `npm run test` | Unit tests |
| `npm run test:integration` | CLI, CI and end-to-end build tests |
| `npm run verify` | Comment scan, typecheck and unit tests |
| `npm run check:packaging` | Verify launchers and installation |
| `npm run install-local` | Install into an isolated home |
| `npm run package` | Produce a platform distribution archive |

## Development workflow

1. Open an issue describing the behaviour change.
2. Add or update the relevant test first.
3. Implement the change.
4. Run `npm run verify` and `npm run test:integration`.
5. Run `npm run lint:comments`.
6. Update documentation in Markdown.
7. Open a pull request describing the behaviour change and how it was verified.

## Module boundaries

Dependencies point downward only.

```text
cli → core → engine → platform
```

* `src/cli` may import `src/core` and engine modules. Nothing may import `src/cli`
  except `src/index.ts`, which exposes the public API.
* `src/core` may import engine modules. Engine modules may not import `src/core`
  types at runtime; they use interfaces declared in their own module or in
  `src/core/types.ts`, which is type-only.
* `src/platform` and `src/net` import nothing from the engine.
* `src/logging` is imported by everything and imports nothing else.

## Adding a loader adapter

1. Extend `GenericGradleAdapter` in `src/loader/generic-gradle.ts`.
2. Implement `detect` using plugin ids, dependency coordinates and loader
   metadata. Do not infer a loader from a version number.
3. Declare `buildTasks`, `remapTasks`, `jarTasks` and `requiredJava`.
4. Return `undefined` from `detect` when the project does not match, so the
   generic adapter can take over.
5. Add a fixture project under `fixtures/` covering the loader.
6. Add detection tests to `tests/integration/fixtures.test.mjs`.

## Adding a mapping provider

1. Implement `MappingProvider` in a new module under `src/mappings/`.
2. Implement `probe(directory)` to return a `MappingDescriptor` with the format,
   namespaces, entry counts and version hint.
3. Register the provider in `MappingRegistry`, placed before the built-in
   providers when the format is more specific.
4. Add tests in `tests/unit/mappings.test.mjs` covering the format, the namespace
   roles and the entry counts.

## Diagnostics

Diagnostics must be evidence-based. A diagnostic records:

* `id`, `severity` and `title`
* `summary` describing what was observed
* `detected` values read from the build output
* `expected` and `actual` when a comparison is available
* `cause` only when the evidence supports it
* `suggestions` derived from the cause
* `evidence` and `rawMessages` for reproducibility

Never invent a cause. When the available data does not identify a cause, say so
and point at the raw output. Static validation must state that runtime behaviour
was not executed.

## Testing expectations

A change is not complete until tests cover it. Tests must:

* Cover more than one Minecraft era where behaviour is version dependent.
* Assert on observable behaviour, not internal implementation details.
* Assert that failures report actionable diagnostics with evidence.
* Assert that static success is never presented as runtime proof.
* Assert exit codes for success and for each failure class.
* Assert that isolation holds, for example that no user Minecraft directory is
  touched.

Network dependent tests must use a local HTTP server rather than the public
internet, and must not depend on ordering or shared cache state.

## Fixtures

`fixtures/` holds small projects and mapping sets spanning multiple eras:

| Fixture | Purpose |
| --- | --- |
| `fabric-1.20.1` | Modern Fabric with Loom |
| `forge-1.12.2` | Legacy Forge with ForgeGradle |
| `neoforge-1.21` | Modern NeoForge with ModDevGradle |
| `quilt-1.20.4` | Quilt with Quilt Loom |
| `maven-1.16.5` | Maven build |
| `plain-java-1.7.10` | Minimal Gradle project with an old Java target |
| `kotlin-1.21` | Mixed Java and Kotlin with a toolchain declaration |
| `mappings-tiny-v2` | Tiny v2 with three namespaces |
| `mappings-tsrg2` | TSRG2 |
| `mappings-yarn` | Yarn ProGuard-style mappings |
| `mappings-mojang` | Mojang ProGuard mappings |

## Pull requests

* One logical change per pull request.
* No comments in source.
* Typecheck clean, comment scan clean, all tests green.
* Documentation updated in Markdown.
* Cross-platform assumptions checked: no path separators, no shell assumptions,
  no case-sensitivity assumptions, no absolute paths.