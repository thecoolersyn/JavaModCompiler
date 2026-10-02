import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApi, tempDir } from '../helpers/harness.mjs';

const api = createApi();

function spaceDirectory(label) {
  const base = path.join(os.tmpdir(), 'kilo');
  const target = path.join(base, label);
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  return target;
}

test('the batch command line wraps a space-containing path in quotes', async () => {
  const command = 'C:\\Users\\John Smith\\AppData\\Local\\Temp\\jmc\\gradle.bat';
  const line = await api.buildBatchCommandLine(command, ['--info', '--project-cache-dir=C:\\Users\\John Smith\\cache']);
  assert.match(line, /^\/d \/s \/c ""/);
  assert.match(line, /""$/);
  assert.match(line, /"C:\\Users\\John Smith\\AppData\\Local\\Temp\\jmc\\gradle\.bat"/);
});

test('a real .cmd invocation succeeds from a temporary directory containing spaces', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('the batch launcher path only applies to Windows');
    return;
  }
  const directory = spaceDirectory('jmc space regression');
  assert.match(directory, / /, 'the fixture directory must contain a space');
  const script = path.join(directory, 'probe script.cmd');
  fs.writeFileSync(script, ['@echo off', 'echo output-start', 'echo arg1=%~1', 'echo arg2=%~2', 'exit /b 0', ''].join('\r\n'), 'utf8');
  const runner = await api.createProcessRunner(30_000);
  const result = await runner.run(script, ['first value', 'C:\\Users\\John Smith\\second'], {});
  assert.equal(result.spawnError, undefined, `spawn must succeed: ${result.spawnError ?? ''}`);
  assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
  assert.match(result.stdout, /output-start/);
  assert.match(result.stdout, /arg1=first value/);
  assert.match(result.stdout, /arg2=C:\\Users\\John Smith\\second/);
});

test('a real .cmd invocation propagates its exit code', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('the batch launcher path only applies to Windows');
    return;
  }
  const directory = spaceDirectory('jmc space exit code');
  const script = path.join(directory, 'fail script.cmd');
  fs.writeFileSync(script, ['@echo off', 'exit /b 42', ''].join('\r\n'), 'utf8');
  const runner = await api.createProcessRunner(30_000);
  const result = await runner.run(script, [], {});
  assert.equal(result.exitCode, 42);
  const sync = runner.runSync(script, [], {});
  assert.equal(sync.exitCode, 42);
});

test('a .cmd argument containing shell metacharacters is not executed', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('the batch launcher path only applies to Windows');
    return;
  }
  const directory = spaceDirectory('jmc space metachar');
  const script = path.join(directory, 'echo arg.cmd');
  fs.writeFileSync(script, ['@echo off', 'echo arg1=%~1', 'exit /b 0', ''].join('\r\n'), 'utf8');
  const marker = path.join(directory, 'injected.txt');
  const runner = await api.createProcessRunner(30_000);
  const result = await runner.run(script, [`value&echo pwned>${marker}`], {});
  assert.equal(result.spawnError, undefined);
  assert.equal(result.exitCode, 0, 'a metacharacter argument must not change the command result');
  assert.equal(
    fs.existsSync(marker),
    false,
    'a metacharacter argument must never be executed as a command',
  );
  assert.equal(result.stdout.includes('pwned'), false, 'the metacharacter must not be executed as a second command');
});

test('a non-batch command is not rewritten', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('the batch launcher path only applies to Windows');
    return;
  }
  const runner = await api.createProcessRunner(30_000);
  const result = await runner.run(process.execPath, ['-e', 'process.stdout.write("direct-ok")'], {});
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /direct-ok/);
});

test('windows drive-letter paths produce a valid file URI', async () => {
  const windows = await api.fileUriForPath('C:\\Users\\Example User\\.umc\\cache\\maven');
  assert.equal(windows, 'file:///C:/Users/Example%20User/.umc/cache/maven');
  assert.equal(await api.isValidFileUri(windows), true);
  assert.equal(new URL(windows).host, '', 'a drive letter must not be parsed as the authority');
});

test('posix paths produce a valid file URI', async () => {
  const posix = process.platform === 'win32' ? 'C:\\home\\user\\.umc\\cache\\maven' : '/home/user/.umc/cache/maven';
  const uri = await api.fileUriForPath(posix);
  assert.equal(await api.isValidFileUri(uri), true);
  const decoded = decodeURIComponent(new URL(uri).pathname);
  assert.match(decoded, /home\/user\/\.umc\/cache\/maven$/);
  if (process.platform !== 'win32') {
    assert.equal(uri, 'file:///home/user/.umc/cache/maven');
  }
});

test('a malformed file URI is rejected', async () => {
  assert.equal(await api.isValidFileUri('file://C:/cache/maven'), false);
  assert.equal(await api.isValidFileUri('https://example.invalid/repo'), false);
  assert.equal(await api.isValidFileUri('not a uri'), false);
});
test('temporary workspace style paths containing spaces round-trip through the file URI', async () => {
  const directory = spaceDirectory('jmc space uri');
  const uri = await api.fileUriForPath(directory);
  assert.equal(await api.isValidFileUri(uri), true);
  const decoded = decodeURIComponent(new URL(uri).pathname).replace(/^\//, '').replace(/\//g, path.sep);
  assert.equal(decoded, directory);
});

test('a directory that does not exist still yields a well-formed file URI', async () => {
  const missing = path.join(os.tmpdir(), 'kilo', 'does not exist here');
  const uri = await api.fileUriForPath(missing);
  assert.equal(await api.isValidFileUri(uri), true);
  assert.match(uri, /does%20not%20exist%20here$/);
});

test('the harness temporary directory used by the space fixture is unique per test', () => {
  const first = spaceDirectory('jmc space unique a');
  const second = spaceDirectory('jmc space unique b');
  assert.notEqual(first, second);
  const third = tempDir('space-unique-c');
  assert.equal(fs.existsSync(third), true);
});
