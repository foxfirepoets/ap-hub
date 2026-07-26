#!/usr/bin/env node
/**
 * CHUNK_3_IPC — make the exported renderer satisfy the window's script policy.
 *
 * The renderer runs under `script-src 'self'` (desktop/security.ts): a script may be loaded from
 * the app's own files and nowhere else, and an inline `<script>` is refused outright. That is the
 * control which stops any content AP-Hub renders — an invoice's text, an email subject, a supplier
 * name — from becoming executable.
 *
 * The exported pages, however, carry their startup data in inline `<script>` blocks. Under the
 * policy those are refused, so nothing starts: proved in a real Electron window, where every one
 * of them was blocked and the page stayed dead static markup.
 *
 * There are two ways out and only one of them is acceptable. Permitting inline scripts (or naming
 * their digests in the policy) bends the control to fit the artifacts. This does the reverse: each
 * inline block is written out as an ordinary file named after the hash of its own contents, and the
 * tag becomes a plain reference to it. The policy is untouched, byte for byte, and the artifacts
 * now comply with it. As a side effect the invariant becomes checkable — no exported page contains
 * an inline script at all, which `test/desktop-renderer.test.ts` asserts.
 *
 * Content-addressed on purpose: identical blocks (every page shares several) collapse to one file,
 * and a changed block can never be served from a stale name.
 *
 * Idempotent — running it twice finds nothing left to do.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'out');
/** Under `_next/static` so it inherits the immutable-asset layout the names already assume. */
const INLINE_DIR_SEGMENTS = ['_next', 'static', 'inline'];
const INLINE_URL_PREFIX = `/${INLINE_DIR_SEGMENTS.join('/')}/`;

/**
 * An inline `<script>`: one with no `src`. The body cannot contain the literal `</script`, because
 * HTML forbids it and the exporter escapes it, so a non-greedy match is exact rather than a guess.
 */
const SCRIPT_TAG = /<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g;

function htmlFilesIn(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...htmlFilesIn(path));
    else if (entry.name.endsWith('.html')) found.push(path);
  }
  return found;
}

const pages = htmlFilesIn(OUT);
if (pages.length === 0) {
  console.error('externalize-inline-scripts: out/ holds no exported pages — run `next build` first.');
  process.exit(1);
}

mkdirSync(join(OUT, ...INLINE_DIR_SEGMENTS), { recursive: true });

const written = new Set();
let rewrittenTags = 0;
let rewrittenPages = 0;

for (const page of pages) {
  const html = readFileSync(page, 'utf8');
  let changed = false;

  const next = html.replace(SCRIPT_TAG, (whole, attributes, body) => {
    // An empty block has nothing to run and nothing to refuse; drop it rather than emit a file.
    if (body.trim() === '') return whole;
    const digest = createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 32);
    const name = `${digest}.js`;
    if (!written.has(name)) {
      writeFileSync(join(OUT, ...INLINE_DIR_SEGMENTS, name), body, 'utf8');
      written.add(name);
    }
    changed = true;
    rewrittenTags += 1;
    // `attributes` is carried through verbatim so a `nomodule` or a `type` keeps its meaning. The
    // tag stays a classic, non-async script, so it still runs in document order exactly as the
    // inline block did.
    return `<script${attributes} src="${INLINE_URL_PREFIX}${name}"></script>`;
  });

  if (changed) {
    writeFileSync(page, next, 'utf8');
    rewrittenPages += 1;
  }
}

console.log(
  `externalized ${rewrittenTags} inline script${rewrittenTags === 1 ? '' : 's'} across ` +
    `${rewrittenPages} of ${pages.length} exported page${pages.length === 1 ? '' : 's'} → ` +
    `${written.size} file${written.size === 1 ? '' : 's'} under ${relative(ROOT, join(OUT, ...INLINE_DIR_SEGMENTS))}`,
);
