#!/usr/bin/env node
/**
 * lint:noleak (CHUNK_5) — keeps the narrow pilot from rotting into a QBO/Windows monolith.
 *
 * The seam is only durable if the provider-neutral core stays provider-neutral and the
 * OS-neutral core stays OS-neutral. This checker enforces three boundaries:
 *
 *  1. STRICT (src/canonical/**): the canonical AP model must contain NO provider identifier
 *     at all — including QBO's. Any leak here corrupts the neutral model at its source.
 *
 *  2. CORE (all of src/** except src/connectors/** and src/qbo/**): no OTHER-provider
 *     identifier (Xero / Intacct / Sage / .QBW / qbXML / QBXMLRP2) may appear. This is the
 *     check that blocks a future Xero/Sage/QBD adapter from leaking logic into core.
 *     (src/qbo/** is the pre-existing QBO reference implementation the QBO connector wraps;
 *     its QBO-specific terms are grandfathered — purging them is a full rewrite, out of
 *     scope for an extraction. The lowercase provider *enum* values in src/auth/tokens.ts
 *     are the one legitimate registry of provider ids and are allowed.)
 *
 *  3. OS (all of src/** except src/host/**): no OS-specific identifier (process.platform,
 *     win32, DPAPI, CryptProtectData, %LOCALAPPDATA%, LaunchAgent, drive-letter paths).
 *     Core is OS-neutral today; this keeps it that way so the macOS host adapter is a thin
 *     addition, not a core rewrite.
 *
 * Exit non-zero (with file:line) on any leak.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SRC = join(ROOT, 'src');

/** Case-sensitive provider-object tokens (PascalCase) that must not appear in core. */
const OTHER_PROVIDER = [
  /\bXero\b/,
  /\bIntacct\b/,
  /\bSageIntacct\b/,
  /\bQBXMLRP2\b/,
  /\bqbXML\b/,
  /\.QBW\b/i,
];

/** Everything provider-specific — banned entirely inside src/canonical/**. */
const ANY_PROVIDER = [
  /\bqbo\b/i,
  /\bSyncToken\b/,
  /\bRealm\b/i,
  ...OTHER_PROVIDER,
];

const OS_TOKENS = [
  /process\.platform/,
  /\bwin32\b/,
  /\bDPAPI\b/,
  /\bCryptProtectData\b/,
  /%LOCALAPPDATA%/i,
  /\bLaunchAgent\b/,
  /[A-Za-z]:\\\\/, // drive-letter path in a string literal
];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

function inDir(rel, ...parts) {
  const prefix = parts.join(sep) + sep;
  return rel === parts.join(sep) || rel.startsWith(prefix);
}

const violations = [];
for (const file of walk(SRC)) {
  const rel = relative(ROOT, file);
  const relSrc = relative(SRC, file);
  const text = readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/);

  const isConnector = inDir(relSrc, 'connectors');
  const isQboImpl = inDir(relSrc, 'qbo');
  const isCanonical = inDir(relSrc, 'canonical');
  const isHost = inDir(relSrc, 'host');

  let providerRules = null;
  if (isCanonical) providerRules = ANY_PROVIDER;
  else if (!isConnector && !isQboImpl) providerRules = OTHER_PROVIDER;

  lines.forEach((line, i) => {
    if (providerRules) {
      for (const re of providerRules) {
        if (re.test(line)) violations.push(`${rel}:${i + 1}  provider leak (${re}) -> ${line.trim()}`);
      }
    }
    if (!isHost) {
      for (const re of OS_TOKENS) {
        if (re.test(line)) violations.push(`${rel}:${i + 1}  OS leak (${re}) -> ${line.trim()}`);
      }
    }
  });
}

if (violations.length) {
  console.error(`lint:noleak FAILED — ${violations.length} boundary leak(s):`);
  for (const v of violations) console.error('  ' + v);
  process.exit(1);
}
console.log('lint:noleak OK — no provider/OS boundary leaks.');
