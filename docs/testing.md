# Testing

## Running the suites

```bash
npm run test              # unit tests
npm run test:integration  # CLI, CI and end-to-end build tests
npm run verify            # comment scan, typecheck, unit tests
```

Integration tests download a real JDK and a real Gradle distribution on first run
and take several minutes.

## Layers

### Unit tests

`tests/unit/` cover the engine modules in isolation.

| File | Covers |
| --- | --- |
| `project-detection.test.mjs` | Argument parsing, Gradle and Maven project detection, language detection, source sets, version evidence, wrapper detection, local JARs |
| `mappings.test.mjs` | Tiny v1 and v2, TSRG, TSRG2, SRG, Yarn, Intermediary, Mojang, ProGuard, Parchment, mixed directories |
| `java-runtime.test.mjs` | Version parsing across eras, snapshot identifiers, toolchain selection, compatibility levels, managed runtime layout, doctor checks |
| `validation.test.mjs` | Bytecode analysis, JAR integrity, mixin configuration parsing, client and server side classification, metadata detection, unsafe archive entries |
| `remap.test.mjs` | Class remapping, namespace conversion, partial coverage, no-op reporting, class file version preservation, archive reading and writing |
| `dependencies.test.mjs` | Artifact download, POM retrieval, transitive resolution, exclusions, unresolved reporting, HTTP failures, cache reuse, version catalog aliases, local JAR inspection |

### Integration tests

`tests/integration/` drive the CLI and full builds.

| File | Covers |
| --- | --- |
| `cli.test.mjs` | Every command, every flag, JSON purity, quiet mode, exit codes, authorization, multi-era projects |
| `ci.test.mjs` | CI behaviour, no prompting, launcher scripts, isolation, no user Minecraft access |
| `build.test.mjs` | Full Gradle builds, reports, lock files, sandbox creation, compile failures, mapping mismatches, reproducibility |
| `fixtures.test.mjs` | Every fixture project and mapping set, across multiple Minecraft eras |

## Test principles

1. Assert observable behaviour, not implementation details.
2. Assert that failures produce actionable diagnostics with evidence.
3. Assert that static success is never reported as runtime proof.
4. Assert exit codes for success and each failure class.
5. Assert that isolation holds.
6. Use a local HTTP server for dependency tests, never the public internet.
7. Give each test its own cache scope so ordering never matters.

## Diagnostic assertions

Tests verify that diagnostics are evidence-based rather than merely present:

```javascript
const diagnostic = summary.diagnostics.find((entry) => entry.id === 'minecraft-mapping-mismatch');
assert.equal(diagnostic.expected, '1.20.1');
assert.equal(diagnostic.actual, '26.2');
assert.ok(diagnostic.suggestions.length > 0);
assert.equal(diagnostic.stage, 'DISCOVER');
```

Runtime claims are asserted negatively:

```javascript
assert.equal(result.runtimeBehaviorExecuted, false);
const notice = result.diagnostics.find((entry) => entry.id === 'mixin-runtime-not-executed');
assert.equal(notice.severity, 'info');
assert.match(notice.summary, /not executed/);
```

## Isolation assertions

```javascript
const before = snapshotMinecraftDirectory();
await runCli(['build', project, '--out', 'out.jar', '--json', '--offline', '--yes']);
assert.deepEqual(snapshotMinecraftDirectory(), before);
```

## Failure-path assertions

```javascript
assert.equal(summary.status, 'failed');
assert.equal(summary.failedStage, 'COMPILE');
assert.notEqual(result.code, 0);
assert.equal(fs.existsSync(path.join(project, 'broken.jar')), false);
```

A failed build must not leave a partial artifact at the requested path.

## Offline assertions

```javascript
const first = await resolveWith(repositoryId);
const requestsAfterFirst = repository.requests().length;
const second = await resolveWith(repositoryId);
assert.equal(repository.requests().length, requestsAfterFirst);
```

Offline behaviour is verified by asserting that no additional requests are made
on a cache hit.

## Fixtures

`fixtures/` holds projects spanning several Minecraft eras and all built-in
loaders, plus mapping sets in four formats.

| Fixture | Era | Purpose |
| --- | --- | --- |
| `fabric-1.20.1` | 1.20 | Modern Fabric with Loom, yarn mappings |
| `forge-1.12.2` | 1.12 | Legacy Forge with ForgeGradle, mods.toml |
| `neoforge-1.21` | 1.21 | Modern NeoForge with ModDevGradle, neoforge.mods.toml |
| `quilt-1.20.4` | 1.20 | Quilt with Quilt Loom, quilt.mod.json |
| `maven-1.16.5` | 1.16 | Maven with compiler properties |
| `plain-java-1.7.10` | 1.7 | Minimal Gradle project with an old Java target |
| `kotlin-1.21` | 1.21 | Mixed Java and Kotlin with a toolchain declaration |
| `mappings-tiny-v2` | 1.20 | Tiny v2 with three namespaces |
| `mappings-tsrg2` | 1.16 | TSRG2 |
| `mappings-yarn` | 1.20 | Yarn ProGuard-style mappings |
| `mappings-mojang` | 1.20 | Mojang ProGuard mappings |

`fixtures.test.mjs` asserts that every fixture is detected exactly as intended,
that the fixtures span at least six distinct Minecraft versions, and that the
fixtures themselves contain no source comments.

## Adding a test

1. Choose the layer: engine behaviour in `tests/unit`, CLI and build behaviour in
   `tests/integration`.
2. Use `tempDir` for filesystem isolation.
3. Use `runCli` for CLI-level assertions.
4. Never depend on test ordering or shared cache state.
5. Never reach the public internet; start a local HTTP server when a repository is
   needed.
6. Assert the exit code and the machine-readable summary.

## End-to-end verification

The build tests run real toolchains. They verify that:

* The requested output path exists and contains the compiled classes.
* The JAR is readable, CRC valid and contains loader metadata.
* Every stage reports a status and a duration.
* `build.log`, `build-report.json`, `build-report.html` and `build-lock.json` are
  written.
* Two builds of the same project produce identical lock inputs.
* A failed compile produces a diagnostic with detected values and suggestions and
  leaves no artifact behind.
* A mapping version mismatch fails before any compilation.
* The runtime sandbox is created under the JMC home and never reuses a user
  installation.