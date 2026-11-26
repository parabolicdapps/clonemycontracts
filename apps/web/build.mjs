// Bundles src/main.js (+ viem, bundled locally) into dist/app.js and copies public/ next to it.
import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, 'dist');
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await cp(join(root, 'public'), dist, { recursive: true });
await build({
  entryPoints: [join(root, 'src/main.js')],
  outfile: join(dist, 'app.js'),
  bundle: true,
  format: 'esm',
  target: ['es2022'],
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info',
});
