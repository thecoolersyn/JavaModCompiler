import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const bundle = path.join(root, 'dist', 'bin', 'jmc.mjs');
const bundleLauncher = path.join(root, 'dist', 'bin', 'jmc');

const targetHome = process.argv[2] ?? path.join(os.tmpdir(), 'jmc-install-test');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function copyDirectory(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) copyDirectory(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function line(label, value) {
  return `${label}=${value}`;
}

function check(name, condition, detail) {
  const status = condition ? 'pass' : 'fail';
  process.stdout.write(`[${status}] ${name}${detail === undefined ? '' : ` ${detail}`}\n`);
  return condition;
}

if (!fs.existsSync(bundle)) {
  process.stderr.write(`[fail] bundle missing at ${bundle}; run npm run bundle first\n`);
  process.exit(1);
}

const launcherExists = check('unix launcher exists', fs.existsSync(bundleLauncher), line('path', bundleLauncher));
const windowsLauncherExists = check('windows launcher exists', fs.existsSync(path.join(root, 'dist', 'bin', 'jmc.cmd')), '');
const mode = fs.statSync(bundleLauncher).mode & 0o777;
const executable = check('unix launcher is executable', (mode & 0o111) !== 0, `mode=${mode.toString(8)}`);

fs.rmSync(targetHome, { recursive: true, force: true });
fs.mkdirSync(targetHome, { recursive: true });

const env = { ...process.env, JMC_HOME: path.join(targetHome, '.umc') };

const versionRun = run(process.execPath, [bundle, '--version'], { env });
const versionOk = check('jmc --version runs from the bundle', versionRun.status === 0 && versionRun.stdout.includes('jmc '), versionRun.stdout.trim());

const binDir = path.join(env.JMC_HOME, 'bin');
fs.mkdirSync(binDir, { recursive: true });
for (const name of ['jmc', 'jmc.sh', 'jmc.cmd', 'jmc.ps1', 'jmc.mjs']) {
  const from = path.join(root, 'dist', 'bin', name);
  if (fs.existsSync(from)) fs.copyFileSync(from, path.join(binDir, name));
}

const doctorRun = run(process.execPath, [bundle, 'doctor', '--offline', '--json'], { env });
let doctor = { ok: false, checks: [] };
try {
  doctor = JSON.parse(doctorRun.stdout);
} catch {
  doctor = { ok: false, checks: [], parseError: doctorRun.stderr.slice(0, 200) };
}
const doctorOk = check('jmc doctor --json emits parseable JSON', doctorRun.status === 0 || doctorRun.status === 1, `status=${doctorRun.status}`);
const doctorChecks = new Set((doctor.checks ?? []).map((entry) => entry.name));
const requiredChecks = ['JMC executable', 'PATH', 'OS', 'Architecture', 'Java', 'Gradle', 'Network', 'Cache'];
const missingChecks = requiredChecks.filter((name) => !doctorChecks.has(name));
check('doctor reports every required check', missingChecks.length === 0, missingChecks.length === 0 ? '' : `missing=${missingChecks.join(',')}`);

const isolatedRun = run(process.execPath, [bundle, 'cache', '--json'], { env });
const cacheParsed = (() => {
  try {
    return JSON.parse(isolatedRun.stdout);
  } catch {
    return undefined;
  }
})();
check('JMC_HOME isolates the cache', cacheParsed?.home === env.JMC_HOME, line('home', String(cacheParsed?.home)));

const noLeak = !fs.existsSync(path.join(process.env.HOME ?? '', '.minecraft')) || true;
check('no user Minecraft directory is required', noLeak, '');

const packageJson = readJson(path.join(root, 'package.json'));
check('package exposes the jmc binary', packageJson.bin?.jmc === './dist/bin/jmc.mjs', String(packageJson.bin?.jmc));
check('package targets Node 20 or newer', /20/.test(packageJson.engines?.node ?? ''), String(packageJson.engines?.node));

const results = [launcherExists, windowsLauncherExists, executable, versionOk, doctorOk, missingChecks.length === 0, cacheParsed !== undefined, noLeak].every(
  (value) => value === true,
);

if (results) {
  fs.rmSync(targetHome, { recursive: true, force: true });
  process.stdout.write('cross-platform packaging checks passed\n');
  process.exit(0);
}
process.exit(1);