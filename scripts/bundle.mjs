import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const outDir = path.join(root, 'dist');
const binDir = path.join(outDir, 'bin');

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(binDir, { recursive: true });

const result = await build({
  entryPoints: [path.join(root, 'src', 'bin', 'jmc.ts')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: path.join(binDir, 'jmc.mjs'),
  banner: {
    js: `import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);`,
  },
  legalComments: 'none',
  minify: false,
  sourcemap: false,
  logLevel: 'info',
});

if (result.errors.length > 0) {
  process.exitCode = 1;
}

const unixLauncher = `#!/bin/sh
JMC_BIN_DIR="\$(CDPATH= cd -- "\$(dirname -- "\$0")" && pwd)"
NODE_BIN="\${JMC_NODE:-node}"
if ! command -v "\$NODE_BIN" >/dev/null 2>&1; then
  printf '[FAILED] JMC requires Node.js 20 or newer on PATH or JMC_NODE set\\n' >&2
  exit 1
fi
exec "\$NODE_BIN" "\$JMC_BIN_DIR/jmc.mjs" "\$@"
`;

const windowsLauncher = `@echo off
setlocal
set "JMC_BIN_DIR=%~dp0"
if defined JMC_NODE (set "NODE_BIN=%JMC_NODE%") else (set "NODE_BIN=node")
where "%NODE_BIN%" >nul 2>nul
if errorlevel 1 (
  echo [FAILED] JMC requires Node.js 20 or newer on PATH or JMC_NODE set 1>&2
  exit /b 1
)
"%NODE_BIN%" "%JMC_BIN_DIR%jmc.mjs" %*
exit /b %ERRORLEVEL%
`;

fs.writeFileSync(path.join(binDir, 'jmc'), unixLauncher, { mode: 0o755 });
fs.writeFileSync(path.join(binDir, 'jmc.sh'), unixLauncher, { mode: 0o755 });
fs.writeFileSync(path.join(binDir, 'jmc.cmd'), windowsLauncher);
fs.writeFileSync(path.join(binDir, 'jmc.ps1'), `$ErrorActionPreference = 'Stop'\n$nodeBin = if ($env:JMC_NODE) { $env:JMC_NODE } else { 'node' }\n& $nodeBin (Join-Path $PSScriptRoot 'jmc.mjs') @args\nexit $LASTEXITCODE\n`);

fs.writeFileSync(
  path.join(outDir, 'package.json'),
  `${JSON.stringify(
    {
      name: 'jmc-bundle',
      version: readVersion(root),
      type: 'module',
      bin: { jmc: './bin/jmc' },
    },
    null,
    2,
  )}\n`,
);

console.log(`Bundled JMC into ${path.relative(root, binDir)}`);

function readVersion(projectRoot) {
  try {
    return JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
}