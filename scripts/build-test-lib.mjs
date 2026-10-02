import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const outDir = path.join(root, 'dist');

fs.mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [path.join(root, 'src', 'index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: path.join(outDir, 'test-lib.mjs'),
  banner: { js: `import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);` },
  legalComments: 'none',
  logLevel: 'info',
  sourcemap: false,
});

process.stdout.write(`test library written to ${path.join(outDir, 'test-lib.mjs')}\n`);