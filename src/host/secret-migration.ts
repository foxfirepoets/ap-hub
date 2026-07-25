import type pg from 'pg';
import { withTransaction } from '../db/pool.js';
import { verifySecretMaterial } from '../crypto.js';
import { assertCredentialTarget, type SecretStore } from './types.js';

export interface LegacySecretMigration {
  lockKey: string;
  target: string;
  store: SecretStore;
  readLegacy(client: pg.PoolClient): Promise<string | null>;
  persistReference(client: pg.PoolClient): Promise<void>;
  deleteLegacy(client: pg.PoolClient): Promise<void>;
  verify?: (expected: string, actual: string) => boolean | Promise<boolean>;
}

/**
 * Copy -> read back -> exact/cryptographic verify -> persist reference -> delete
 * legacy. A transaction-scoped advisory lock serializes retries for the same
 * secret. Any failure keeps the legacy transactionally intact and removes only
 * a target created by this attempt.
 */
export async function migrateLegacySecret(input: LegacySecretMigration): Promise<'migrated' | 'absent'> {
  assertCredentialTarget(input.target);
  let writeAttempted = false;
  let legacyForCleanup: string | null = null;
  let targetWasAbsent = false;
  try {
    return await withTransaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [input.lockKey]);
      const legacy = await input.readLegacy(client);
      if (legacy === null) return 'absent';
      legacyForCleanup = legacy;

      const prior = await input.store.get(input.target);
      if (prior !== null && !verifySecretMaterial(legacy, prior)) {
        throw new Error('SECRET_MIGRATION_TARGET_CONFLICT');
      }
      if (prior === null) {
        targetWasAbsent = true;
        // Set before put: an exception can mean either no write or a lost ack.
        writeAttempted = true;
        await input.store.put(input.target, legacy);
      }

      const readBack = await input.store.get(input.target);
      const valid =
        readBack !== null &&
        verifySecretMaterial(legacy, readBack) &&
        (input.verify ? await input.verify(legacy, readBack) : true);
      if (!valid) throw new Error('SECRET_MIGRATION_VERIFICATION_FAILED');

      await input.persistReference(client);
      await input.deleteLegacy(client);
      return 'migrated';
    });
  } catch {
    if (writeAttempted && targetWasAbsent && legacyForCleanup !== null) {
      try {
        const current = await input.store.get(input.target);
        // Delete only the exact value written by this attempt. A concurrent or
        // operator-created replacement is never attempt-owned.
        if (current !== null && verifySecretMaterial(legacyForCleanup, current)) {
          await input.store.delete(input.target);
        }
      } catch {
        throw new Error('SECRET_MIGRATION_CLEANUP_FAILED');
      }
    }
    throw new Error('SECRET_MIGRATION_FAILED');
  }
}
