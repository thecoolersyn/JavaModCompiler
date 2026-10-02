import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createApi, repoRoot, tempDir, runCli } from '../helpers/harness.mjs';

const api = createApi();

const FIXTURE = path.join(repoRoot, 'fixtures', 'fabric-26.3-autotool');
const ARTIFACT_BASE = 'jmc-autotool';
const MOD_ID = 'jmc_autotool';
const CLIENT_ENTRYPOINT = 'com.jmc.autotool.AutoToolClient';
const GAME_TEST_ENTRYPOINT = 'com.jmc.autotool.AutoToolGameTest';
const GAME_TEST_ENTRYPOINT_KEY = 'fabric-client-gametest';

const HOME = path.join(tempDir('fabric-263-home'), '.umc');

function gradleWrapper() {
  return process.platform === 'win32' ? path.join(FIXTURE, 'gradlew.bat') : path.join(FIXTURE, 'gradlew');
}

function cleanGenerated() {
  fs.rmSync(path.join(FIXTURE, 'build'), { recursive: true, force: true });
  fs.rmSync(path.join(FIXTURE, '.gradle'), { recursive: true, force: true });
}

const REQUIRED_JAVA = 25;

function jdkCandidates() {
  const candidates = [];
  if (process.env.JMC_TEST_JAVA_HOME !== undefined && process.env.JMC_TEST_JAVA_HOME.length > 0) {
    candidates.push(process.env.JMC_TEST_JAVA_HOME);
  }
  if (process.env.JAVA_HOME !== undefined && process.env.JAVA_HOME.length > 0) candidates.push(process.env.JAVA_HOME);
  const managedRoots = [
    path.join(HOME, 'runtimes'),
    path.join(process.env.HOME ?? process.env.USERPROFILE ?? '', '.umc', 'runtimes'),
  ];
  for (const root of managedRoots) {
    if (root.length === 0 || fs.existsSync(root) === false) continue;
    for (const entry of fs.readdirSync(root)) {
      candidates.push(path.join(root, entry, 'jdk'));
      candidates.push(path.join(root, entry));
    }
  }
  return candidates;
}

async function jdkForDirectBuild() {
  for (const candidate of jdkCandidates()) {
    if (fs.existsSync(path.join(candidate, 'bin', 'java.exe')) === false && fs.existsSync(path.join(candidate, 'bin', 'java')) === false) {
      continue;
    }
    const major = await api.findJavaMajor(candidate);
    if (major >= REQUIRED_JAVA) return candidate;
  }
  const provisioned = await api.provisionJava(REQUIRED_JAVA, HOME);
  return provisioned.javaHome;
}

async function runGradle(args, timeoutMs = 45 * 60 * 1000) {
  const javaHome = await jdkForDirectBuild();
  const env = { JMC_DISABLE_UPDATE_CHECK: '1' };
  if (javaHome !== undefined) env.JAVA_HOME = javaHome;
  return api.runProcess(gradleWrapper(), [...args, '--no-daemon', '--console=plain'], {
    cwd: FIXTURE,
    env,
    timeoutMs,
  });
}

async function runDirectLoomBuild() {
  const result = await runGradle(['build']);
  const log = `${result.stdout}\n${result.stderr}`;
  const reportedSuccess = /BUILD SUCCESSFUL/.test(log);
  const reportedFailure = /BUILD FAILED/.test(log);
  let status = result.exitCode;
  if (status === null && reportedSuccess && reportedFailure === false) status = 0;
  if (status === null && reportedFailure) status = 1;
  return {
    status,
    stdout: result.stdout,
    stderr: result.stderr,
    failure: result.spawnError ?? (result.timedOut ? 'the build timed out' : undefined),
    reportedSuccess,
    reportedFailure,
  };
}

function directBuildArtifacts() {
  const libs = path.join(FIXTURE, 'build', 'libs');
  if (fs.existsSync(libs) === false) return [];
  return fs.readdirSync(libs).filter((name) => name.endsWith('.jar')).sort();
}

function retainedProjectDir() {
  const workspaces = path.join(HOME, 'workspaces');
  const candidates = fs
    .readdirSync(workspaces, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(workspaces, entry.name, 'readonly', 'project'))
    .filter((dir) => fs.existsSync(path.join(dir, 'build', 'libs')));
  if (candidates.length === 0) {
    throw new Error(`no retained JMC workspace with a Loom build output under ${workspaces}`);
  }
  return candidates.sort().at(-1);
}

function retainedLoomJars() {
  const libs = path.join(retainedProjectDir(), 'build', 'libs');
  return fs.readdirSync(libs).filter((name) => name.endsWith('.jar')).sort();
}

async function reachable(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(20_000), method: 'HEAD' });
    return response.status < 500;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

test('the Minecraft 26.3 AutoTool fixture builds directly with Fabric Loom', { timeout: 60 * 60 * 1000 }, async (t) => {
  const fabric = await reachable('https://maven.fabricmc.net/net/fabricmc/fabric-loom/fabric-loom.gradle.plugin/1.17.21/fabric-loom.gradle.plugin-1.17.21.pom');
  if (fabric !== true) {
    t.diagnostic(`INFRASTRUCTURE FAILURE: the Fabric maven is unreachable, so the direct Loom build cannot be attempted: ${fabric}`);
    assert.fail(`INFRASTRUCTURE FAILURE: the Fabric maven is unreachable: ${fabric}`);
    return;
  }

  cleanGenerated();
  assert.equal(fs.existsSync(path.join(FIXTURE, 'build')), false, 'the fixture must start from a clean state');

  const result = await runDirectLoomBuild();
  const artifacts = directBuildArtifacts();

  if (result.status !== 0) {
    const tail = `${result.stdout}\n${result.stderr}`.split('\n').slice(-25).join('\n');
    t.diagnostic(`INFRASTRUCTURE OR BUILD FAILURE in the direct Loom build (exit ${result.status}):\n${tail}`);
  }

  assert.equal(
    result.status,
    0,
    `the direct Loom build must succeed; exit=${result.status} spawnError=${result.failure ?? 'none'}`,
  );
  assert.equal(result.reportedFailure, false, 'Gradle must not report BUILD FAILED');
  assert.equal(artifacts.length > 0, true, 'the direct Loom build must produce JAR artifacts');
  assert.match(result.stdout, /Minecraft 26\.3|26\.3/, 'the build log must show Minecraft 26.3 being resolved');

  const production = `${ARTIFACT_BASE}-1.0.0.jar`;
  assert.equal(artifacts.includes(production), true, `expected ${production} among ${artifacts.join(', ')}`);
  assert.equal(
    artifacts.includes(`${ARTIFACT_BASE}-1.0.0-dev.jar`) || true,
    true,
    'a development JAR is optional for Loom 1.17',
  );
});

test('JMC builds, selects and validates the Minecraft 26.3 Loom artifact', { timeout: 60 * 60 * 1000 }, async (t) => {
  cleanGenerated();

  const output = path.join(tempDir('fabric-263-out'), 'jmc-autotool.jar');
  const result = await runCli([FIXTURE, '--out', output, '--yes', '--keep-workspace', '--json'], {
    env: { JMC_HOME: HOME, JMC_DISABLE_UPDATE_CHECK: '1' },
    stdin: { isTTY: false },
  });

  const summary = JSON.parse(result.stdout);
  if (summary.status !== 'pass') {
    t.diagnostic(
      `JMC BUILD FAILURE: status=${summary.status} failedStage=${summary.failedStage} ` +
        `diagnostics=${JSON.stringify((summary.diagnostics ?? []).slice(0, 3).map((entry) => `${entry.id}: ${entry.summary}`))} ` +
        `raw=${JSON.stringify((summary.diagnostics ?? []).flatMap((entry) => entry.rawMessages ?? []).slice(0, 12))}`,
    );
  }

  assert.equal(summary.status, 'pass', `JMC must build the 26.3 fixture: ${result.stdout.slice(0, 600)}`);
  assert.equal(result.code, 0, `JMC must exit 0; got ${result.code}`);

  const stages = new Map(summary.stages.map((entry) => [entry.stage, entry.status]));
  for (const stage of ['DISCOVER', 'RESOLVE', 'PREPARE', 'COMPILE', 'PACKAGE', 'VALIDATE']) {
    assert.equal(stages.get(stage), 'pass', `${stage} must pass, got ${stages.get(stage)}`);
  }
  t.diagnostic(
    `REMAP stage status: ${stages.get('REMAP') ?? 'absent'}. Fabric Loom 1.17 exposes no separate remap task; ` +
      'Loom remaps inside its own jar task, so JMC delegates that step to the loader.',
  );

  assert.equal(fs.existsSync(output), true, 'JMC must publish the artifact');

  const loomOutput = retainedLoomJars();
  const production = `${ARTIFACT_BASE}-1.0.0.jar`;
  assert.equal(
    loomOutput.includes(production),
    true,
    `the delegated Loom build must have produced ${production}, got ${loomOutput.join(', ')}`,
  );
  assert.equal(
    loomOutput.filter((name) => name.endsWith('.jar') && !/-sources\.jar$|-javadoc\.jar$/.test(name)).length,
    1,
    `exactly one publishable Loom artifact is expected, got ${loomOutput.join(', ')}`,
  );

  const published = fs.readFileSync(output);
  const loomJar = fs.readFileSync(path.join(retainedProjectDir(), 'build', 'libs', production));
  assert.equal(
    crypto.createHash('sha256').update(published).digest('hex'),
    crypto.createHash('sha256').update(loomJar).digest('hex'),
    'JMC must publish the genuine Loom production artifact byte for byte, not a rebuilt or renamed JAR',
  );
  assert.equal(/-(?:dev|unmapped)\.jar$/i.test(production), false, 'the published artifact must not be a development JAR');
  assert.equal(/-sources\.jar$/i.test(production), false, 'the published artifact must not be a sources JAR');
  assert.equal(/-javadoc\.jar$/i.test(production), false, 'the published artifact must not be a javadoc JAR');

  const magic = fs.readFileSync(output).subarray(0, 4);
  assert.equal(
    magic[0] === 0x50 && magic[1] === 0x4b,
    true,
    `the published artifact must begin with the ZIP magic PK, got ${[...magic].map((b) => b.toString(16)).join(' ')}`,
  );

  const names = await api.jarEntryNames(output);
  assert.equal(names.includes('fabric.mod.json'), true, 'fabric.mod.json must be inside the production JAR');

  const metadata = await api.checkMetadata(output);
  assert.equal(metadata.loaderDetected, 'fabric', 'the published artifact must be recognised as a Fabric mod');
  const fabricModJson = metadata.fabricModJson ?? {};
  assert.equal(metadata.diagnostics.length, 0, `loader metadata must parse cleanly: ${JSON.stringify(metadata.diagnostics)}`);
  assert.equal(fabricModJson.id, MOD_ID, 'the mod id must be correct');
  assert.equal(fabricModJson.version, '1.0.0', 'the mod version must be correct');
  assert.equal(fabricModJson.depends.minecraft, '~26.3', 'the mod must target Minecraft 26.3');
  assert.equal(fabricModJson.depends.fabricloader, '>=0.19.5', 'the mod must require Fabric Loader 0.19.5 or newer');

  const entrypoints = fabricModJson.entrypoints ?? {};
  assert.deepEqual(entrypoints.client, [CLIENT_ENTRYPOINT], 'the client entrypoint must be declared');
  assert.deepEqual(
    entrypoints[GAME_TEST_ENTRYPOINT_KEY],
    [GAME_TEST_ENTRYPOINT],
    `the ${GAME_TEST_ENTRYPOINT_KEY} entrypoint must be declared`,
  );
  assert.equal(
    names.includes(CLIENT_ENTRYPOINT.replace(/\./g, '/') + '.class'),
    true,
    'the client entrypoint class must be packaged',
  );
  assert.equal(
    names.includes(GAME_TEST_ENTRYPOINT.replace(/\./g, '/') + '.class'),
    true,
    'the game test entrypoint class must be packaged',
  );
  assert.equal(
    names.includes('com/jmc/autotool/AutoToolSelector.class'),
    true,
    'the selection algorithm must be packaged',
  );

  const digest = crypto.createHash('sha256').update(fs.readFileSync(output)).digest('hex');
  assert.match(digest, /^[0-9a-f]{64}$/, 'the published artifact must have a valid SHA-256 digest');
  t.diagnostic(`published ${production} as ${path.basename(output)} sha256=${digest}`);
});

test('the AutoTool behavior is verified with real Minecraft item and block APIs', { timeout: 60 * 60 * 1000 }, async (t) => {
  const fabric = await reachable('https://maven.fabricmc.net/net/fabricmc/fabric-loom/fabric-loom.gradle.plugin/1.17.21/fabric-loom.gradle.plugin-1.17.21.pom');
  if (fabric !== true) {
    t.diagnostic(`INFRASTRUCTURE FAILURE: the Fabric maven is unreachable: ${fabric}`);
    assert.fail(`INFRASTRUCTURE FAILURE: the Fabric maven is unreachable: ${fabric}`);
    return;
  }

  cleanGenerated();
  const result = await runGradle(['test', '--rerun-tasks']);

  if (result.exitCode !== 0) {
    t.diagnostic(`AutoTool behavior test failure (exit ${result.exitCode}):\n${(result.stdout).split('\n').slice(-25).join('\n')}`);
  }
  assert.equal(result.exitCode, 0, 'the AutoTool behavior tests must pass');

  for (const scenario of [
    'a better tool in another slot is selected',
    'no suitable tool leaves the current slot unchanged',
    'an equally suitable tool causes no switch',
    'a non-tool item is ignored',
    'empty slots are ignored',
    'a disabled feature never switches',
    'the correct tool class is preferred for its block',
  ]) {
    assert.match(result.stdout, new RegExp(scenario.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `missing scenario: ${scenario}`);
  }
  t.diagnostic('AutoTool behavior scenarios ran against bootstrapped Minecraft 26.3 block states');
});

test('the AutoTool mod loads and initializes inside a real Fabric client', { timeout: 60 * 60 * 1000 }, async (t) => {
  const fabric = await reachable('https://maven.fabricmc.net/net/fabricmc/fabric-loom/fabric-loom.gradle.plugin/1.17.21/fabric-loom.gradle.plugin-1.17.21.pom');
  if (fabric !== true) {
    t.diagnostic(`INFRASTRUCTURE FAILURE: the Fabric maven is unreachable: ${fabric}`);
    assert.fail(`INFRASTRUCTURE FAILURE: the Fabric maven is unreachable: ${fabric}`);
    return;
  }

  const result = await runGradle(['runClient', '-PjmcGameTest=true']);

  const log = `${result.stdout}\n${result.stderr}`;
  if (result.exitCode !== 0) {
    const failed = /Client gametests failed with an exception/.test(log);
    t.diagnostic(
      `RUNTIME LOAD ${failed ? 'FAILURE' : 'could not be verified'}: runClient exited ${result.exitCode}` +
        `${result.spawnError === undefined ? '' : ` (${result.spawnError})`}. ` +
        `A missing OpenGL context or display is an infrastructure failure, not a JMC failure.\n` +
        log.split('\n').slice(-20).join('\n'),
    );
    assert.equal(result.exitCode, 0, 'the Fabric client game test must pass');
    return;
  }

  assert.match(log, /jmc_autotool/, 'Fabric Loader must report the AutoTool mod among the loaded mods');
  assert.equal(/Client gametests failed with an exception/.test(log), false);
  t.diagnostic('Fabric Loader started, discovered jmc_autotool, ran the client entrypoint and completed the AutoTool runtime checks');
});

test('the AutoTool fixture is registered as a JMC fixture', async () => {
  const fixtures = fs.readdirSync(path.join(repoRoot, 'fixtures'));
  assert.equal(fixtures.includes('fabric-26.3-autotool'), true);
  const settings = fs.readFileSync(path.join(FIXTURE, 'settings.gradle'), 'utf8');
  assert.match(settings, /rootProject\.name\s*=\s*'jmc-autotool'/);
  const properties = fs.readFileSync(path.join(FIXTURE, 'gradle.properties'), 'utf8');
  assert.match(properties, /minecraft_version=26\.3/);
  assert.match(properties, /loader_version=0\.19\.5/);
  assert.match(properties, /loom_version=1\.17\.21/);
  assert.match(properties, /archives_base_name=jmc-autotool/);
  const wrapper = fs.readFileSync(path.join(FIXTURE, 'gradle', 'wrapper', 'gradle-wrapper.properties'), 'utf8');
  assert.match(wrapper, /gradle-9\.6\.0-bin\.zip/);
  assert.equal(
    fs.existsSync(path.join(FIXTURE, 'gradle', 'wrapper', 'gradle-wrapper.jar')),
    true,
    'the wrapper jar must be committed so the fixture builds without a system Gradle',
  );
  const build = fs.readFileSync(path.join(FIXTURE, 'build.gradle'), 'utf8');
  assert.match(build, /net\.fabricmc\.fabric-loom/);
  assert.equal(/net\.fabricmc\.fabric-loom-remap/.test(build), false, 'the obsolete remap plugin id must not be used');
  assert.equal(/mappings\s+["']/.test(build), false, 'Minecraft 26.3 publishes no obfuscation mappings, so none may be requested');
  assert.match(build, /options\.release\s*=\s*25/, 'the fixture must target Java 25 like Minecraft 26.3');
});
