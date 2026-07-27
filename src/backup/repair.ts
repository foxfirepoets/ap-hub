import pg from 'pg';
import { readInstallFile } from '../db/local-database.js';
import { migrateUp } from '../db/migrate.js';
import type { SecretStore } from '../host/types.js';
import { childLogger } from '../logger.js';
import { BACKUP_ENCRYPTION_KEY_TARGET } from './key.js';

const { Pool } = pg;

const log = childLogger({ module: 'backup-repair' });

/**
 * CHUNK_7_BACKUP — repair mode, data-safety half only.
 *
 * "Reinstalls program components" (binary/installer-level reinstallation) is CHUNK_9_PACKAGE's
 * concern and is not attempted here. What this module actually rebuilds/re-confirms is
 * everything this codebase treats as re-derivable rather than source-of-truth user data:
 *
 *   1. Schema at head — `migrateUp` is already idempotent (src/db/migrate.ts): every migration
 *      file it has already applied is skipped, so re-running it against an up-to-date database
 *      performs zero writes to any user-data table. This IS the "rebuild derived state" step;
 *      there is no materialized view, cache table or other denormalized store anywhere in
 *      `migrations/*.sql` today — `postings`/`v_postings_qbo`/`v_proposal_review` are plain SQL
 *      views (see 001_init.sql, 006_provider_neutral.sql), which Postgres always computes live
 *      and which therefore have nothing to "rebuild".
 *   2. Referential-integrity self-check — a handful of anti-join queries that mirror FOREIGN
 *      KEY constraints Postgres already enforces (see `ORPHAN_CHECKS` below). Under a healthy
 *      install these always return zero; a non-zero count means a constraint was bypassed
 *      (stale-schema restore, manual SQL with constraints disabled, on-disk corruption) —
 *      exactly what repair mode exists to surface. No check here corresponds to a rule that
 *      doesn't already exist as a real schema constraint.
 *   3. Install identity linkage — `install.json` (read-only via `readInstallFile`) must still
 *      name the same `install_id`/`os_account_id` as the `local_install` singleton row.
 *   4. Backup key presence — a read-only credential-store lookup (never a create-if-missing),
 *      so repair reports a missing key rather than silently minting a new one that could not
 *      decrypt existing backups.
 *
 * Nothing here writes to messages, attachments, attachment_blobs, proposals, postings_ap or any
 * other user-data table — see test/backup-repair.int.test.ts for the row-level proof.
 */

export interface RepairOptions {
  connectionString: string;
  /** Defaults to migrateUp's own DEFAULT_MIGRATIONS_DIR when omitted. */
  migrationsDir?: string;
  installFilePath: string;
  secretStore: SecretStore;
}

export interface IntegrityCheckResult {
  name: string;
  ok: boolean;
  orphanCount: number;
}

export interface RepairResult {
  migrationsApplied: string[];
  installLinkageOk: boolean;
  installLinkageDetail?: string;
  backupKeyPresent: boolean;
  integrityChecks: IntegrityCheckResult[];
  /** True only when the schema is at head, install linkage holds and every integrity check passes. */
  ok: boolean;
}

interface OrphanCheckSpec {
  name: string;
  sql: string;
}

/**
 * Each query mirrors a FOREIGN KEY already declared in migrations/001_init.sql or
 * migrations/006_provider_neutral.sql — see the module doc comment above.
 */
const ORPHAN_CHECKS: OrphanCheckSpec[] = [
  {
    name: 'attachments.message_id -> messages',
    sql: `SELECT count(*)::text AS n FROM attachments a
          WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = a.message_id)`,
  },
  {
    name: 'proposals.attachment_id -> attachments',
    sql: `SELECT count(*)::text AS n FROM proposals p
          WHERE p.attachment_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM attachments a WHERE a.id = p.attachment_id)`,
  },
  {
    name: 'postings_ap.proposal_id -> proposals',
    sql: `SELECT count(*)::text AS n FROM postings_ap po
          WHERE po.proposal_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM proposals p WHERE p.id = po.proposal_id)`,
  },
];

async function runIntegrityChecks(pool: pg.Pool): Promise<IntegrityCheckResult[]> {
  const results: IntegrityCheckResult[] = [];
  for (const check of ORPHAN_CHECKS) {
    const { rows } = await pool.query<{ n: string }>(check.sql);
    const orphanCount = Number(rows[0]!.n);
    results.push({ name: check.name, ok: orphanCount === 0, orphanCount });
  }
  return results;
}

async function checkInstallLinkage(
  pool: pg.Pool,
  installFilePath: string,
): Promise<{ ok: boolean; detail?: string }> {
  let file;
  try {
    file = readInstallFile(installFilePath);
  } catch (err) {
    return { ok: false, detail: `install.json invalid: ${(err as Error).message}` };
  }
  if (!file) return { ok: false, detail: 'install.json missing' };

  const { rows } = await pool.query<{ install_id: string; os_account_id: string }>(
    'SELECT install_id, os_account_id FROM local_install WHERE id = 1',
  );
  const row = rows[0];
  if (!row) return { ok: false, detail: 'local_install row missing' };
  if (row.install_id !== file.installId) {
    return { ok: false, detail: 'install.json installId does not match the local_install row' };
  }
  if (row.os_account_id !== file.osAccountId) {
    return { ok: false, detail: 'install.json osAccountId does not match the local_install row' };
  }
  return { ok: true };
}

/**
 * Run repair mode: bring schema to head (idempotent no-op when already there), self-check the
 * referential invariants above, and re-confirm install/credential-store linkage. Never writes
 * to a user-data table.
 */
export async function runRepair(opts: RepairOptions): Promise<RepairResult> {
  const migrationsApplied = await migrateUp(opts.connectionString, opts.migrationsDir);

  const pool = new Pool({ connectionString: opts.connectionString });
  let integrityChecks: IntegrityCheckResult[];
  let linkage: { ok: boolean; detail?: string };
  try {
    integrityChecks = await runIntegrityChecks(pool);
    linkage = await checkInstallLinkage(pool, opts.installFilePath);
  } finally {
    await pool.end();
  }

  const backupKeyPresent = (await opts.secretStore.get(BACKUP_ENCRYPTION_KEY_TARGET)) !== null;
  const ok = linkage.ok && integrityChecks.every((c) => c.ok);

  if (ok) {
    log.info(
      { migrationsApplied: migrationsApplied.length, backupKeyPresent },
      'repair completed: schema at head, invariants hold',
    );
  } else {
    log.error(
      { integrityChecks, installLinkageOk: linkage.ok, installLinkageDetail: linkage.detail },
      'repair found an integrity problem',
    );
  }

  return {
    migrationsApplied,
    installLinkageOk: linkage.ok,
    installLinkageDetail: linkage.detail,
    backupKeyPresent,
    integrityChecks,
    ok,
  };
}
