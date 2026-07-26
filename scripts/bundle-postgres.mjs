#!/usr/bin/env node
/**
 * CHUNK_2_DATABASE — produce the bundled PostgreSQL runtime, reproducibly.
 *
 * `docs/audits/postgres-bundling-spike-2026-07-25.md` chose the official PostgreSQL Windows
 * binaries trimmed to `bin` + `lib` + `share`. That decision is only worth anything if the
 * 120 MB it ships can be REGENERATED rather than hand-curated — otherwise nobody can say what
 * is in the installer, and CHUNK_9 cannot sign a set it cannot rebuild.
 *
 * So this script is the definition of the bundle, and `vendor/postgres.lock.json` is its
 * fingerprint:
 *
 *   - The download URL and its SHA-256 are PINNED. A changed archive fails rather than
 *     silently shipping different binaries.
 *   - The trim rule is declarative (`KEEP_TOP_LEVEL`), not a list of files someone curated.
 *   - The output is fingerprinted by hashing the sorted (relative path, content hash) pairs,
 *     so two machines running this script can prove they produced the same tree.
 *
 * Usage:
 *   node scripts/bundle-postgres.mjs                # build + verify against the lock
 *   node scripts/bundle-postgres.mjs --update-lock  # record a new pin (deliberate upgrade)
 *   node scripts/bundle-postgres.mjs --verify-only  # fingerprint an existing vendor tree
 */

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync, renameSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const VENDOR = join(ROOT, 'vendor');
const OUT = join(VENDOR, 'pgsql');
const LOCK = join(VENDOR, 'postgres.lock.json');
const CACHE = join(VENDOR, '.cache');

/**
 * The pinned source. PostgreSQL 16 is the line the schema targets; the patch level is the
 * current 16.x at pin time, per the spike's "ship the current patch release" note.
 */
const SOURCE = {
  version: '16.10-1',
  url: 'https://get.enterprisedb.com/postgresql/postgresql-16.10-1-windows-x64-binaries.zip',
  archive: 'postgresql-16.10-1-windows-x64-binaries.zip',
};

/**
 * The trim rule. Everything else in the archive — `pgAdmin 4` (616 MB), `symbols` (156 MB),
 * `doc`, `include`, `StackBuilder` — is 87% of the download and is not needed to RUN a server.
 * Stated as a keep-list rather than a delete-list so a new top-level directory in a future
 * release is excluded by default instead of silently shipped.
 */
const KEEP_TOP_LEVEL = ['bin', 'lib', 'share'];

/** Files inside the kept directories that a bundled server still never needs. */
const DROP_SUFFIXES = ['.pdb'];

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

function sha256File(path) {
  const hash = createHash('sha256');
  hash.update(readFileSync(path));
  return hash.digest('hex');
}

async function sha256Stream(path) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

async function download(url, dest) {
  mkdirSync(dirname(dest), { recursive: true });
  log(`Downloading ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || res.body === null) throw new Error(`Download failed: HTTP ${res.status}`);
  const tmp = `${dest}.part`;
  await pipeline(res.body, createWriteStream(tmp));
  renameSync(tmp, dest);
  log(`Downloaded ${(statSync(dest).size / 1048576).toFixed(1)} MB`);
}

/**
 * Walk a tree and return sorted `{ path, sha256, bytes }`. Sorting with a fixed separator
 * makes the fingerprint independent of directory-read order and of the host OS.
 */
function fingerprintTree(root) {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else files.push(p);
    }
  };
  walk(root);
  const entries = files
    .map((p) => ({
      path: relative(root, p).split(sep).join('/'),
      sha256: sha256File(p),
      bytes: statSync(p).size,
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const roll = createHash('sha256');
  for (const e of entries) roll.update(`${e.path}\0${e.sha256}\0`);
  return {
    treeSha256: roll.digest('hex'),
    fileCount: entries.length,
    totalBytes: entries.reduce((n, e) => n + e.bytes, 0),
  };
}

function extract(archive, into) {
  rmSync(into, { recursive: true, force: true });
  mkdirSync(into, { recursive: true });
  log('Extracting…');
  // tar ships with Windows 10+ and every supported macOS; it handles zip and avoids a
  // PowerShell dependency in what is otherwise a plain Node script.
  execFileSync('tar', ['-xf', archive, '-C', into], { stdio: 'inherit' });
}

function trim(extractedRoot, out) {
  // The archive contains a single top-level `pgsql/` directory.
  const inner = join(extractedRoot, 'pgsql');
  const base = existsSync(inner) ? inner : extractedRoot;

  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  const copyDir = (from, to) => {
    mkdirSync(to, { recursive: true });
    for (const name of readdirSync(from)) {
      const src = join(from, name);
      const dst = join(to, name);
      if (statSync(src).isDirectory()) copyDir(src, dst);
      else if (!DROP_SUFFIXES.some((s) => name.endsWith(s))) writeFileSync(dst, readFileSync(src));
    }
  };

  for (const keep of KEEP_TOP_LEVEL) {
    const from = join(base, keep);
    if (!existsSync(from)) throw new Error(`Archive is missing expected directory: ${keep}`);
    copyDir(from, join(out, keep));
  }
}

function readLock() {
  return existsSync(LOCK) ? JSON.parse(readFileSync(LOCK, 'utf8')) : null;
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const updateLock = args.has('--update-lock');
  const verifyOnly = args.has('--verify-only');
  const lock = readLock();

  if (verifyOnly) {
    if (!existsSync(OUT)) throw new Error(`No bundled runtime at ${OUT} — run without --verify-only first.`);
    const print = fingerprintTree(OUT);
    log(`tree sha256 : ${print.treeSha256}`);
    log(`files       : ${print.fileCount}`);
    log(`bytes       : ${print.totalBytes} (${(print.totalBytes / 1048576).toFixed(1)} MB)`);
    if (lock && lock.tree.treeSha256 !== print.treeSha256) {
      throw new Error('Bundled runtime does not match vendor/postgres.lock.json');
    }
    log(lock ? 'Matches the lock.' : 'No lock file to compare against.');
    return;
  }

  const archive = join(CACHE, SOURCE.archive);
  if (!existsSync(archive)) await download(SOURCE.url, archive);

  const archiveSha = await sha256Stream(archive);
  log(`archive sha256: ${archiveSha}`);
  if (lock && !updateLock) {
    if (lock.source.url !== SOURCE.url) throw new Error('Pinned URL changed without --update-lock');
    if (lock.source.sha256 !== archiveSha) {
      throw new Error(
        `Archive SHA-256 does not match the pin.\n  expected ${lock.source.sha256}\n  actual   ${archiveSha}`,
      );
    }
  }

  const staging = join(CACHE, 'extracted');
  extract(archive, staging);
  trim(staging, OUT);
  rmSync(staging, { recursive: true, force: true });

  const tree = fingerprintTree(OUT);
  log(`kept        : ${KEEP_TOP_LEVEL.join(', ')}`);
  log(`files       : ${tree.fileCount}`);
  log(`bytes       : ${tree.totalBytes} (${(tree.totalBytes / 1048576).toFixed(1)} MB)`);
  log(`tree sha256 : ${tree.treeSha256}`);

  if (lock && !updateLock && lock.tree.treeSha256 !== tree.treeSha256) {
    throw new Error('Trimmed tree does not match the lock — the trim rule or the archive changed.');
  }

  if (updateLock || !lock) {
    writeFileSync(
      LOCK,
      `${JSON.stringify(
        {
          note: 'Pinned PostgreSQL bundle. Regenerate with: node scripts/bundle-postgres.mjs --update-lock',
          source: { ...SOURCE, sha256: archiveSha },
          keepTopLevel: KEEP_TOP_LEVEL,
          dropSuffixes: DROP_SUFFIXES,
          tree,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    log(`Wrote ${relative(ROOT, LOCK)}`);
  } else {
    log('Matches the lock.');
  }
}

main().catch((err) => {
  console.error(String(err.message ?? err));
  process.exit(1);
});
