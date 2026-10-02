import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { repoRoot, runCli, tempDir, write } from '../helpers/harness.mjs';

const CI_ENV = {
  ...process.env,
  CI: '1',
  JMC_HOME: path.join(tempDir('ci-home'), '.umc'),
};

function run(args, options = {}) {
  return runCli(args, { env: options.env, stdin: { isTTY: false } });
}

test('CI mode produces a machine readable summary on stdout only', async () => {
  const root = tempDir('ci-build');
  write(root, 'build.gradle', "plugins { id 'java' }\n");
  write(root, 'gradle.properties', 'minecraft_version=1.20.1\n');
  write(root, 'src/main/java/com/example/A.java', 'package com.example;\npublic class A {}\n');
  write(root, 'src/main/resources/fabric.mod.json', JSON.stringify({ schemaVersion: 1, id: 'ci', version: '1.0.0' }));

  const result = await run(['build', root, '--out', 'ci.jar', '--json', '--offline', '--yes'], { env: CI_ENV });
  assert.doesNotThrow(() => JSON.parse(result.stdout));
  const parsed = JSON.parse(result.stdout);
  assert.equal(typeof parsed.status, 'string');
  assert.ok(['pass', 'failed', 'warning'].includes(parsed.status));
  assert.equal(typeof parsed.buildId, 'string');
  assert.ok(Number.isFinite(parsed.durationMs));
});

test('CI mode returns exit code zero on success and non zero on failure', async () => {
  const failing = tempDir('ci-fail');
  write(failing, 'build.gradle', "plugins { id 'java' }\n");
  write(failing, 'gradle.properties', 'minecraft_version=1.20.1\n');
  write(failing, 'src/main/java/A.java', 'class A {}\n');

  const result = await run(['build', failing, '--out', 'out.jar', '--json', '--offline', '--yes'], { env: CI_ENV });
  const parsed = JSON.parse(result.stdout);
  if (parsed.status === 'pass') {
    assert.equal(result.code, 0);
  } else {
    assert.notEqual(result.code, 0);
    assert.ok(Array.isArray(parsed.diagnostics));
    assert.ok(parsed.diagnostics.length > 0);
  }
});

test('CI mode never prompts and never blocks on stdin', async () => {
  const root = tempDir('ci-noprompt');
  write(root, 'build.gradle', "plugins { id 'java' }\n");
  write(root, 'gradle.properties', 'minecraft_version=1.21.4\n');
  write(root, 'src/main/java/A.java', 'class A {}\n');
  const started = Date.now();
  const result = await run(['build', root, '--out', 'out.jar', '--json', '--offline'], { env: CI_ENV });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 60_000, `the build must not block on a prompt, took ${elapsed} ms`);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.failedStage, 'DISCOVER');
  assert.equal(result.code, 3);
});

test('the environment can grant authorization without a prompt', async () => {
  const root = tempDir('ci-trust');
  write(root, 'build.gradle', "plugins { id 'java' }\n");
  write(root, 'gradle.properties', 'minecraft_version=1.20.1\n');
  write(root, 'src/main/java/A.java', 'class A {}\n');
  const env = { ...CI_ENV, JMC_TRUST_PROJECT_SCRIPTS: '1' };
  const result = await run(['build', root, '--out', 'out.jar', '--json', '--offline'], { env });
  const parsed = JSON.parse(result.stdout);
  assert.notEqual(parsed.failedStage, 'DISCOVER');
});

test('the bundled launcher runs on this platform', async () => {
  const bundle = path.join(repoRoot, 'dist', 'bin', 'jmc.mjs');
  if (!fs.existsSync(bundle)) {
    assert.ok(false, 'the bundle must exist; run npm run bundle first');
    return;
  }
  const output = execFileSync(process.execPath, [bundle, '--version'], { encoding: 'utf8' });
  assert.match(output, /^jmc \d+\.\d+\.\d+$/m);
});

test('the shell launcher forwards arguments and exit codes', async () => {
  const launcher = path.join(repoRoot, 'dist', 'bin', 'jmc');
  if (!fs.existsSync(launcher)) {
    assert.ok(false, 'the launcher must exist; run npm run bundle first');
    return;
  }
  const output = execFileSync(launcher, ['detect', repoRoot], { encoding: 'utf8' });
  assert.match(output, /Build System:/);
});

test('the shell launcher returns the documented failure exit code', () => {
  const launcher = path.join(repoRoot, 'dist', 'bin', 'jmc');
  let status = 0;
  try {
    execFileSync(launcher, ['detect', '/nonexistent/project'], { encoding: 'utf8', stdio: 'pipe' });
  } catch (error) {
    status = error.status;
  }
  assert.equal(status, 2);
});

test('the windows launcher script is generated', () => {
  const windowsLauncher = path.join(repoRoot, 'dist', 'bin', 'jmc.cmd');
  assert.equal(fs.existsSync(windowsLauncher), true);
  const content = fs.readFileSync(windowsLauncher, 'utf8');
  assert.match(content, /jmc\.mjs/);
  assert.match(content, /errorlevel/i);
});

test('JMC_HOME fully isolates the cache from the user profile', async () => {
  const isolated = path.join(tempDir('ci-isolation'), '.umc');
  const env = { ...process.env, JMC_HOME: isolated };
  const cache = await run(['cache', '--json'], { env });
  const parsed = JSON.parse(cache.stdout);
  assert.equal(parsed.home, isolated);
  const doctor = await run(['doctor', '--offline', '--json'], { env });
  const report = JSON.parse(doctor.stdout);
  const cacheCheck = report.checks.find((check) => check.name === 'Cache');
  assert.ok(cacheCheck.detail.some((line) => line.includes(isolated)));
});

test('jmc never writes into a user Minecraft directory', async () => {
  const env = { ...process.env, JMC_HOME: path.join(tempDir('ci-no-minecraft'), '.umc') };
  const root = tempDir('ci-probe');
  write(root, 'build.gradle', "plugins { id 'java' }\n");
  write(root, 'gradle.properties', 'minecraft_version=1.20.1\n');
  write(root, 'src/main/java/A.java', 'class A {}\n');
  const before = snapshotMinecraftDirectory();
  await run(['build', root, '--out', 'out.jar', '--json', '--offline', '--yes'], { env });
  const after = snapshotMinecraftDirectory();
  assert.deepEqual(after, before);
});

function snapshotMinecraftDirectory() {
  const home = process.env.HOME ?? '';
  const candidates = [
    path.join(home, '.minecraft'),
    path.join(home, 'Library', 'Application Support', 'minecraft'),
  ];
  return candidates.map((candidate) => {
    try {
      const entries = fs.readdirSync(candidate).sort();
      return { candidate, entries };
    } catch {
      return { candidate, entries: null };
    }
  });
}