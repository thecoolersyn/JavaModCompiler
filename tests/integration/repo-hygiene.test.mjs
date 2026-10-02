import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { repoRoot } from '../helpers/harness.mjs';

function git(args) {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
  if (result.status !== 0) return undefined;
  return result.stdout.trim();
}

const tracked = git(['ls-files']);

test('the repository tracks no build output or dependency directory', (t) => {
  if (tracked === undefined) {
    t.skip('git is not available in this environment');
    return;
  }
  const forbidden = /^(dist|node_modules|dist-release|\.jmc-test-tmp|\.jmc-build|types)\//;
  const offenders = tracked.split('\n').filter((entry) => forbidden.test(entry));
  assert.deepEqual(offenders, []);
});

test('the ignore file excludes build output and dependency directories', () => {
  const ignore = fs.readFileSync(path.join(repoRoot, '.gitignore'), 'utf8');
  const entries = ignore.split('\n').map((line) => line.trim().replace(/\/$/, '')).filter((line) => line.length > 0);
  for (const required of ['node_modules', 'dist', 'dist-release', '.jmc-test-tmp']) {
    assert.ok(entries.includes(required), `.gitignore must exclude ${required}`);
  }
});

test('every package script that points at a repository file exists', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  for (const [name, command] of Object.entries(packageJson.scripts ?? {})) {
    const match = /^node\s+(?:-e|--eval)\s/.test(command) ? undefined : /^node\s+(\S+)/.exec(command);
    if (match === null || match === undefined) continue;
    const target = path.join(repoRoot, match[1]);
    assert.equal(fs.existsSync(target), true, `the ${name} script points at a missing file: ${match[1]}`);
  }
});

test('the package exposes no entry that points at a missing file', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  for (const [name, entry] of Object.values(packageJson.bin ?? {}).entries()) {
    const target = String(entry);
    assert.match(target, /^\.\/dist\//, `the ${name} binary must be built into dist: ${target}`);
  }
  for (const [name, exportTarget] of Object.entries(packageJson.exports ?? {})) {
    assert.equal(
      Object.hasOwn(exportTarget, 'types'),
      false,
      `the ${name} export must not advertise a types entry, because no declarations are published`,
    );
    for (const [condition, target] of Object.entries(exportTarget)) {
      assert.match(String(target), /^\.\/dist\//, `the ${name} export (${condition}) must point into dist: ${target}`);
    }
  }
});

test('the readme does not recommend a global install of an unpublished name', () => {
  const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
  const codeLines = readme.split('\n').filter((line) => /^\s*(npm|yarn|pnpm)\s+install\s+(-g|--global)/.test(line));
  assert.deepEqual(codeLines, [], `the readme must not run a global install of an unpublished package: ${codeLines.join(', ')}`);
  assert.match(readme, /@thecoolersyn\/jmc/);
});

test('the readme separates verified loaders from detected loaders', () => {
  const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
  assert.match(readme, /Verified by a real end-to-end build/);
  assert.match(readme, /Detected and parsed only/);
  assert.match(readme, /arm64 is untested in\s+CI|CI runs on Linux, Windows and macOS/);
});
