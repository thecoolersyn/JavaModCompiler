import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const bundle = path.join(root, 'dist', 'bin', 'jmc.mjs');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;

const home = process.argv[2] ?? os.homedir();
const platform = process.platform;
const homeDir = platform === 'win32' ? process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local') : home;
const installRoot = path.join(homeDir, '.umc');
const binDir = path.join(installRoot, 'bin');

const entries = ['jmc', 'jmc.sh', 'jmc.cmd', 'jmc.ps1', 'jmc.mjs'];

function copyBundle() {
  fs.mkdirSync(binDir, { recursive: true });
  for (const name of entries) {
    const from = path.join(root, 'dist', 'bin', name);
    if (!fs.existsSync(from)) continue;
    fs.copyFileSync(from, path.join(binDir, name));
  }
  if (platform !== 'win32') {
    fs.chmodSync(path.join(binDir, 'jmc'), 0o755);
    fs.chmodSync(path.join(binDir, 'jmc.sh'), 0o755);
  }
}

function pathKey(platformOs, value) {
  return platformOs === 'win32' ? value.replace(/\//g, '\\').toLowerCase() : value;
}

function addToPathUnix() {
  const profileFiles = [
    path.join(home, '.zshrc'),
    path.join(home, '.bashrc'),
    path.join(home, '.bash_profile'),
    path.join(home, '.profile'),
  ];
  const managedFiles = [
    path.join(home, '.config', 'jmc', 'env.sh'),
    path.join(home, '.config', 'fish', 'conf.d', 'jmc.fish'),
  ];
  fs.mkdirSync(path.dirname(managedFiles[0]), { recursive: true });
  fs.mkdirSync(path.dirname(managedFiles[1]), { recursive: true });
  fs.writeFileSync(
    managedFiles[0],
    `export JMC_HOME="${installRoot}"\nexport PATH="${binDir}:$PATH"\n`,
    'utf8',
  );
  fs.writeFileSync(managedFiles[1], `set -gx JMC_HOME "${installRoot}"\nset -gx PATH "${binDir}" $PATH\n`, 'utf8');
  const line = `export PATH="${binDir}:$PATH"`;
  for (const file of profileFiles) {
    if (!fs.existsSync(file)) continue;
    const content = fs.readFileSync(file, 'utf8');
    if (content.includes(binDir)) continue;
    fs.appendFileSync(file, `\n${line}\n`, 'utf8');
    process.stdout.write(`updated ${file}\n`);
  }
  process.stdout.write(`wrote ${managedFiles[0]}\nwrote ${managedFiles[1]}\n`);
  process.stdout.write('open a new shell or source the file above to use jmc\n');
}

function addToPathWindows() {
  const key = pathKey('win32', process.env.Path ?? process.env.PATH ?? '');
  if (key.includes(pathKey('win32', binDir))) {
    process.stdout.write(`${binDir} is already on PATH\n`);
    return;
  }
  process.stdout.write('To add JMC to PATH on Windows, run the following in an elevated or user PowerShell session:\n');
  process.stdout.write(
    `[Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path','User') + ';${binDir}', 'User')\n`,
  );
  process.stdout.write('Then open a new terminal so the change takes effect.\n');
}

function verify() {
  const isWindows = platform === 'win32';
  const probe = isWindows
    ? spawnSyncProbe(path.join(binDir, 'jmc.cmd'), ['--version'])
    : spawnSyncProbe(path.join(binDir, 'jmc'), ['--version']);
  if (probe.status !== 0) {
    process.stderr.write(`installation verification failed: ${probe.stderr || probe.stdout}\n`);
    process.exit(1);
  }
  process.stdout.write(`verified: ${probe.stdout.trim()}\n`);
  process.stdout.write(`JMC home: ${installRoot}\n`);
  process.stdout.write(`cache: ${path.join(installRoot, 'cache')}\n`);
  process.stdout.write('run "jmc doctor" to verify the environment\n');
}

function spawnSyncProbe(command, args) {
  const result = spawnSyncCompat(command, args);
  return result;
}

import { spawnSync } from 'node:child_process';

function spawnSyncCompat(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

if (!fs.existsSync(bundle)) {
  process.stderr.write(`bundle missing at ${bundle}; run npm run build first\n`);
  process.exit(1);
}

process.stdout.write(`Installing JMC ${version}\n`);
process.stdout.write(`install root: ${installRoot}\n`);
copyBundle();
if (platform === 'win32') addToPathWindows();
else addToPathUnix();
verify();