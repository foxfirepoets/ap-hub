import { randomBytes } from 'node:crypto';
import type { SecretStore } from '../host/types.js';

/**
 * CHUNK_7_BACKUP — the backup encryption key, held only in the OS credential store.
 *
 * Follows the exact pattern `src/db/local-database.ts` already uses for
 * `DATABASE_PASSWORD_TARGET`: generate once, store via `SecretStore`, never write it to disk,
 * `install.json`, the `backups` table, or a log line. Unlike the database password, this key
 * is not derived from anything guessable — it is 256 bits from the platform CSPRNG.
 */

export const BACKUP_ENCRYPTION_KEY_TARGET = 'APHub/backup/encryption-key';

const KEY_BYTES = 32;

/** Generate a real 256-bit key. Not derived from any other secret, password or seed. */
export function generateBackupKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

/**
 * Fetch the backup key from the credential store, generating and storing one on first use.
 * Returns raw key bytes; callers must never log, persist, or otherwise let this value escape
 * the current process.
 */
export async function getOrCreateBackupKey(secretStore: SecretStore): Promise<Buffer> {
  const stored = await secretStore.get(BACKUP_ENCRYPTION_KEY_TARGET);
  if (stored !== null) {
    const key = Buffer.from(stored, 'base64url');
    if (key.length !== KEY_BYTES) {
      throw new Error('BACKUP_KEY_INVALID: stored backup key is not 32 bytes');
    }
    return key;
  }
  const key = generateBackupKey();
  await secretStore.put(BACKUP_ENCRYPTION_KEY_TARGET, key.toString('base64url'));
  return key;
}
