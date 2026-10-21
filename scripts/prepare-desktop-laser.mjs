import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

// Packaged apps intentionally disable file:// fetch privileges. A classic
// script keeps the isolated desktop surface independent of file ES modules.
await build({
  entryPoints: [fileURLToPath(new URL('../electron/desktop-laser-renderer.mjs', import.meta.url))],
  outfile: fileURLToPath(new URL('../electron/desktop-laser-renderer.js', import.meta.url)),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  legalComments: 'none',
});
