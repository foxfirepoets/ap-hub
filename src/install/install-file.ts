import { z } from 'zod';
import { SUPPORTED_PLATFORMS } from '../host/types.js';

/**
 * CHUNK_2_DATABASE / CHUNK_4_IDENTITY — `install.json`, the non-secret runtime facts.
 *
 * Spec §6: install id, OS account id, platform, app version, database port, data directory and
 * log directory live here. **No secret, token, password or key may appear in this file** —
 * those live only in the OS credential store.
 *
 * That rule is enforced in BOTH directions and at LOAD time, not only at write time, because
 * the threat is a file that arrived some other way: hand-edited, restored from an old backup,
 * or written by a previous version that was less careful. A loader that trusts its own writer
 * is not a control.
 *
 * OS-neutral by construction — the caller supplies the paths, so `lint:noleak` stays green and
 * this module is identical on any platform.
 */

/** Rejected outright as a key name, however it is cased or separated. */
const CREDENTIAL_KEY_WORDS = [
  'secret', 'token', 'password', 'passwd', 'pwd', 'credential', 'apikey', 'accesskey',
  'privatekey', 'clientsecret', 'refresh', 'bearer', 'auth', 'signature', 'certificate',
  'passphrase', 'sessionkey', 'encryptionkey',
];

/** Normalise a key so `client-secret`, `client_secret`, `clientSecret` and `ClientSecret` collide. */
export function normalizeKey(key: string): string {
  return key.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

export function isCredentialShapedKey(key: string): boolean {
  const n = normalizeKey(key);
  return CREDENTIAL_KEY_WORDS.some((w) => n.includes(w));
}

/**
 * Value-shape detection. Catches material that is a credential regardless of what it was
 * called — a JWT stored under `note`, a PEM block under `comment`, a long high-entropy blob
 * under `id`. Deliberately conservative about what counts as high entropy so that a UUID,
 * a Windows SID and a file path all pass.
 */
export function isCredentialShapedValue(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (v.length === 0) return false;
  if (/^Bearer\s+\S+/i.test(v)) return true;
  if (/^e[yj][A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./.test(v)) return true;        // JWT
  if (/-----BEGIN [A-Z ]*(PRIVATE KEY|CERTIFICATE)-----/.test(v)) return true;    // PEM
  if (/^(sk|pk|rk|ghp|gho|ghs|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{10,}/i.test(v)) return true;
  if (/^ya29\.[A-Za-z0-9._-]{10,}/.test(v)) return true;                          // Google OAuth
  if (/^AIza[A-Za-z0-9_-]{20,}/.test(v)) return true;                             // Google API key
  // Long, unbroken, mixed-case+digit string with no path/URL/UUID structure.
  if (v.length >= 40 && !/[\s/\\:.]/.test(v) && /[A-Z]/.test(v) && /[a-z]/.test(v) && /\d/.test(v)) {
    return true;
  }
  return false;
}

/** Walk the parsed object and refuse anything credential-shaped, at any depth. */
export function findCredentialShapedEntry(
  value: unknown,
  path: string[] = [],
): { path: string; reason: 'key' | 'value' } | null {
  if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) {
      const hit = findCredentialShapedEntry(item, [...path, String(i)]);
      if (hit) return hit;
    }
    return null;
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isCredentialShapedKey(k)) return { path: [...path, k].join('.'), reason: 'key' };
      const hit = findCredentialShapedEntry(v, [...path, k]);
      if (hit) return hit;
    }
    return null;
  }
  if (isCredentialShapedValue(value)) return { path: path.join('.'), reason: 'value' };
  return null;
}

/**
 * `strict()` is load-bearing, not stylistic: an unknown key is REJECTED rather than ignored.
 * Ignoring unknown keys would let a credential ride along in the file untouched and unnoticed,
 * which is exactly what the spec forbids.
 */
export const installFileSchema = z
  .object({
    installId: z.string().uuid(),
    osAccountId: z.string().min(1).max(256),
    // Version 1 accepts one platform. The identifier itself lives in src/host/types.ts so this
    // module names no operating system — the OS-boundary scan enforces that.
    platform: z.enum(SUPPORTED_PLATFORMS),
    appVersion: z.string().min(1).max(64),
    dbPort: z.number().int().min(1024).max(65535),
    dataDir: z.string().min(1),
    logDir: z.string().min(1),
  })
  .strict();

export type InstallFile = z.infer<typeof installFileSchema>;

export class InstallFileInvalid extends Error {
  readonly code = 'INSTALL_FILE_INVALID';
  constructor(readonly reason: string) {
    super(`install.json rejected: ${reason}`);
    this.name = 'InstallFileInvalid';
  }
}

/**
 * Parse and validate `install.json` content.
 *
 * The credential sweep runs BEFORE schema validation. If the file smuggles a token under an
 * unexpected key, the caller must learn "this file contains a credential" — not the less
 * useful "unrecognized key". Order matters for the diagnosis, and the diagnosis is what tells
 * an operator that something wrote a secret to disk.
 */
export function parseInstallFile(raw: string): InstallFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new InstallFileInvalid('not valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new InstallFileInvalid('not an object');
  }
  const hit = findCredentialShapedEntry(parsed);
  if (hit) {
    // The offending VALUE is never echoed — reporting it would copy the secret into a log.
    throw new InstallFileInvalid(
      `credential-shaped ${hit.reason} at "${hit.path}"; secrets belong in the credential store`,
    );
  }
  const result = installFileSchema.safeParse(parsed);
  if (!result.success) {
    const first = result.error.issues[0];
    throw new InstallFileInvalid(first ? `${first.path.join('.') || '(root)'}: ${first.message}` : 'invalid');
  }
  return result.data;
}

/** Serialize. Runs the same sweep on the way out, so a bug upstream cannot write a secret. */
export function serializeInstallFile(file: InstallFile): string {
  const validated = installFileSchema.parse(file);
  const hit = findCredentialShapedEntry(validated);
  if (hit) throw new InstallFileInvalid(`refusing to write credential-shaped ${hit.reason} at "${hit.path}"`);
  return `${JSON.stringify(validated, null, 2)}\n`;
}
