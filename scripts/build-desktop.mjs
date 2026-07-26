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
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
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
};

/**
 * MAIN — ESM, with every third-party package left external.
 *
 * `packages: 'external'` is load-bearing, not an optimisation. Bundling a CommonJS
 * dependency into an ESM output rewrites its internal `require()` calls into a shim that
 * throws `Dynamic require of "events" is not supported` the moment the module is actually
 * used. `pg` is CommonJS and reaches for Node built-ins that way, so bundling it produced a
 * main process that died on its first database call.
 *
 * The Electron main process is a full Node environment and can load `pg` itself. Relative
 * imports — the AP-Hub source tree — are still bundled; only bare specifiers are externalised,
 * which is why `pg` must stay in `dependencies` and be shipped by electron-builder.
 */
await build({
  ...common,
  entryPoints: [join(SRC, 'main.ts')],
  outfile: join(OUT, 'main.mjs'),
  format: 'esm',
  packages: 'external',
  sourcemap: true,
});

/**
 * PRELOAD — CJS, still fully bundled. Deliberately NOT given the same treatment: a sandboxed
 * preload has no module resolution at all, so anything left external there is unreachable at
 * runtime. Bundling is what keeps `desktop/channels.ts` the single source of truth.
 */
await build({
  ...common,
  entryPoints: [join(SRC, 'preload.ts')],
  outfile: join(OUT, 'preload.cjs'),
  format: 'cjs',
  sourcemap: false,
});

// Static assets the main process resolves relative to its own directory.
cpSync(join(SRC, 'boot.html'), join(OUT, 'boot.html'));
cpSync(join(SRC, 'boot.js'), join(OUT, 'boot.js'));
cpSync(join(SRC, 'assets'), join(OUT, 'assets'), { recursive: true });

/**
 * Fail the build if a Node package got embedded in the ESM main bundle again.
 *
 * The symptom of that mistake is a runtime crash on a code path that may not run until the
 * user's first launch, so it must be caught here rather than discovered later. Checking for
 * esbuild's own dynamic-require shim catches the whole class, not just `pg`.
 */
const mainSource = readFileSync(join(OUT, 'main.mjs'), 'utf8');
const packagingDefects = [];
if (/Dynamic require of/.test(mainSource)) {
  packagingDefects.push(
    'main.mjs contains esbuild\'s dynamic-require shim — a CommonJS package was bundled into ESM output.',
  );
}
for (const marker of ['node_modules/pg/lib/client.js', 'node_modules/pg-pool', 'node_modules/pg-protocol']) {
  if (mainSource.includes(marker)) packagingDefects.push(`main.mjs embeds ${marker}; it must stay external.`);
}
if (packagingDefects.length) {
  console.error('desktop build FAILED — ESM packaging defect:');
  for (const d of packagingDefects) console.error(`  ${d}`);
  process.exit(1);
}

console.log('desktop shell built → dist-desktop/');
