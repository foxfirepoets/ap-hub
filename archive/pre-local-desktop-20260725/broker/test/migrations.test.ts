import { describe, it, expect, afterAll } from 'vitest';
import pg from 'pg';
import { migrateUp, migrateDown } from '../src/db.js';

/**
 * Migrations UP → DOWN → UP is clean on a scratch DB, and the SPEC §13-B
 * verification query returns 3. Runs against its OWN throwaway database so it
 * never disturbs the shared broker test DB.
 */

const { Pool } = pg;
const ADMIN_URL = (process.env.DATABASE_URL ?? 'postgres://aphub:aphub@127.0.0.1:5432/aphub_broker')
  .replace(/\/[^/]+$/, '/postgres');
const SCRATCH_DB = 'aphub_broker_migtest';
const SCRATCH_URL = (process.env.DATABASE_URL ?? 'postgres://aphub:aphub@127.0.0.1:5432/aphub_broker')
  .replace(/\/[^/]+$/, `/${SCRATCH_DB}`);

const VERIFY_SQL = `SELECT count(*)::int AS n FROM information_schema.tables
  WHERE table_schema='public' AND table_name IN ('installs','heartbeats','spend_ledger')`;

async function tableCount(): Promise<number> {
  const p = new Pool({ connectionString: SCRATCH_URL });
  try {
    const { rows } = await p.query<{ n: number }>(VERIFY_SQL);
    return rows[0]!.n;
  } finally {
    await p.end();
  }
}

async function recreateScratch(): Promise<void> {
  const admin = new Pool({ connectionString: ADMIN_URL });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
    await admin.query(`CREATE DATABASE ${SCRATCH_DB}`);
  } finally {
    await admin.end();
  }
}

async function dropScratch(): Promise<void> {
  const admin = new Pool({ connectionString: ADMIN_URL });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
  } finally {
    await admin.end();
  }
}

describe('broker migrations', () => {
  afterAll(dropScratch);

  it('UP → DOWN → UP is clean and the verification query returns 3', async () => {
    await recreateScratch();

    // UP
    const up1 = await migrateUp(SCRATCH_URL);
    expect(up1).toContain('001_init.sql');
    expect(await tableCount()).toBe(3);

    // DOWN — all three tables gone
    const down = await migrateDown(SCRATCH_URL);
    expect(down).toContain('001_init.sql');
    expect(await tableCount()).toBe(0);

    // UP again — clean, back to 3
    const up2 = await migrateUp(SCRATCH_URL);
    expect(up2).toContain('001_init.sql');
    expect(await tableCount()).toBe(3);
  });

  it('the event CHECK constraint rejects a value outside the closed enum', async () => {
    const p = new Pool({ connectionString: SCRATCH_URL });
    try {
      const { rows } = await p.query<{ id: string }>(
        `INSERT INTO installs (label, token_sha256) VALUES ('mig-enum', 'deadbeef') RETURNING id`,
      );
      const installId = rows[0]!.id;
      await expect(
        p.query(`INSERT INTO heartbeats (install_id, event) VALUES ($1, 'invoice_seen')`, [installId]),
      ).rejects.toThrow();
    } finally {
      await p.end();
    }
  });
});
