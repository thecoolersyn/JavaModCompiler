import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createApi, tempDir, runCli } from '../helpers/harness.mjs';

const api = createApi();

test('an incomplete part download is removed by the sweep', async () => {
  const cache = tempDir('cleanup-part-files');
  fs.writeFileSync(path.join(cache, 'gradle-8.10.2-bin.zip.part-1234-1'), 'partial');
  fs.writeFileSync(path.join(cache, 'gradle-8.10.2-bin.zip.part'), 'partial');
  fs.writeFileSync(path.join(cache, 'gradle-8.10.2-bin.zip'), 'complete');
  const harness = await api.cleanupHarness();
  harness.sweepPartFiles(cache);
  const remaining = fs.readdirSync(cache).sort();
  assert.deepEqual(remaining, ['gradle-8.10.2-bin.zip'], `only a complete archive may survive, got ${remaining.join(', ')}`);
});

test('the cleanup path is idempotent', async () => {
  const harness = await api.cleanupHarness();
  let calls = 0;
  const target = tempDir('cleanup-idempotent');
  fs.mkdirSync(path.join(target, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(target, 'nested', 'file.txt'), 'data');
  harness.registerHook(() => {
    calls += 1;
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
  });
  await harness.runCleanup();
  await harness.runCleanup();
  assert.equal(calls, 2, 'each cleanup run invokes the hook');
  assert.equal(fs.existsSync(target), false, 'a repeated cleanup must not throw on a missing directory');
});

test('a hook that throws does not prevent the other hooks from running', async () => {
  const harness = await api.cleanupHarness();
  const ran = [];
  harness.registerHook(() => {
    ran.push('first');
    throw new Error('cleanup failure');
  });
  harness.registerHook(() => {
    ran.push('second');
  });
  await harness.runCleanup();
  assert.deepEqual(ran, ['first', 'second'], 'a failing hook must not stop the remaining cleanup');
});

test('the interrupted flag is false during a normal run', async () => {
  const harness = await api.cleanupHarness();
  assert.equal(harness.isInterrupted(), false);
});

test('a normal build still completes and cleans its workspace', { timeout: 900_000 }, async (t) => {
  const reachable = await probe('https://services.gradle.org/distributions/gradle-8.10.2-bin.zip.sha256');
  if (reachable !== true) {
    t.skip(`the Gradle distribution host is unreachable, so a real build cannot be run: ${reachable}`);
    return;
  }
  const project = tempDir('cleanup-normal-build');
  fs.mkdirSync(path.join(project, 'src', 'main', 'java', 'com', 'example'), { recursive: true });
  fs.writeFileSync(path.join(project, 'build.gradle'), "plugins { id 'java' }\n");
  fs.writeFileSync(path.join(project, 'settings.gradle'), "rootProject.name = 'cleanup'\n");
  fs.writeFileSync(path.join(project, 'gradle.properties'), 'minecraft_version=1.20.1\n');
  fs.writeFileSync(path.join(project, 'src', 'main', 'java', 'com', 'example', 'A.java'), 'package com.example;\npublic class A {}\n');
  const home = path.join(tempDir('cleanup-home'), '.umc');
  const result = await runCli([project, '--out', path.join(project, 'out.jar'), '--yes', '--java', '21', '--json'], {
    env: { JMC_HOME: home, JMC_DISABLE_UPDATE_CHECK: '1' },
    stdin: { isTTY: false },
  });
  assert.equal(result.code, 0, result.stdout.slice(0, 300));
  const workspaces = path.join(home, 'workspaces');
  const retained = fs.existsSync(workspaces) ? fs.readdirSync(workspaces) : [];
  assert.deepEqual(retained, [], `a successful build must not leave a workspace behind, found ${retained.join(', ')}`);
  const partFiles = [];
  for (const directory of ['cache/gradle', 'cache/java']) {
    const full = path.join(home, directory);
    if (fs.existsSync(full) === false) continue;
    for (const entry of fs.readdirSync(full)) {
      if (entry.includes('.part')) partFiles.push(`${directory}/${entry}`);
    }
  }
  assert.deepEqual(partFiles, [], `no partial download may be left behind, found ${partFiles.join(', ')}`);
});

async function probe(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    return response.status < 500;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
