#!/usr/bin/env node
/**
 * CHUNK_1_SHELL — build the Electron shell.
 *
 * Two different module formats, for two different reasons:
 *
 *   main    → ESM (.mjs). It uses `import.meta.url` to resolve its own directory, and
 *             Electron 28+ supports an ESM entry point.
 *   preload → CJS (.cjs), BUNDLED. A sandboxed preload cannot `require` a relative module —
 *             only a small polyfilled subset of Node is available to it — so the channel
 *             allowlist has to be inlined at build time rather than imported at runtime.
 *             Bundling is what keeps `desktop/channels.ts` the single source of truth
 *             instead of a list re-typed into the preload and left to drift.
 *
 * `electron` is external in both: it is provided by the runtime, never bundled.
 */

import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'desktop');
const OUT = join(ROOT, 'dist-desktop');

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  external: ['electron'],
  logLevel: 'info',
  // The shell is not shipped to a browser; keep it readable in a crash report.
  minify: false,
  sourcemap: false,
};

await build({
  ...common,
  entryPoints: [join(SRC, 'main.ts')],
  outfile: join(OUT, 'main.mjs'),
  format: 'esm',
});

await build({
  ...common,
  entryPoints: [join(SRC, 'preload.ts')],
  outfile: join(OUT, 'preload.cjs'),
  format: 'cjs',
});

// Static assets the main process resolves relative to its own directory.
cpSync(join(SRC, 'boot.html'), join(OUT, 'boot.html'));
cpSync(join(SRC, 'assets'), join(OUT, 'assets'), { recursive: true });

console.log('desktop shell built → dist-desktop/');
