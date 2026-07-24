import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateDown, migrateUp } from '../src/db/migrate.js';

const { Client, Pool } = pg;

describe.sequential('008 accounting intake migration', () => {
  const sourceUrl = new URL(process.env.DATABASE_URL!);
  const databaseName = `aphub_schema_${process.pid}_${Date.now()}`;
  const adminUrl = new URL(sourceUrl);
  adminUrl.pathname = '/postgres';
  const disposableUrl = new URL(sourceUrl);
  disposableUrl.pathname = `/${databaseName}`;
  let pool: pg.Pool;

  beforeAll(async () => {
    const admin = new Client({ connectionString: adminUrl.toString() });
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`);
    } finally {
      await admin.end();
    }
    await migrateUp(disposableUrl.toString());
    pool = new Pool({ connectionString: disposableUrl.toString() });
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    const admin = new Client({ connectionString: adminUrl.toString() });
    await admin.connect();
    try {
      await admin.query(
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
        [databaseName],
      );
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    } finally {
      await admin.end();
    }
  });

  it('enforces tenant scope, statuses, idempotency, and UP → DOWN → UP safety', async () => {
    const { rows: tables } = await pool.query<{ table_name: string }>(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN (
          'accounting_documents', 'bank_statements', 'bank_statement_lines',
          'provider_jobs', 'reply_drafts'
        )
      ORDER BY table_name
    `);
    expect(tables.map((row) => row.table_name)).toEqual([
      'accounting_documents',
      'bank_statement_lines',
      'bank_statements',
      'provider_jobs',
      'reply_drafts',
    ]);

    const tenant1 = (await pool.query<{ id: string }>(
      `INSERT INTO tenants (name) VALUES ('Tenant One') RETURNING id`,
    )).rows[0]!.id;
    const tenant2 = (await pool.query<{ id: string }>(
      `INSERT INTO tenants (name) VALUES ('Tenant Two') RETURNING id`,
    )).rows[0]!.id;
    const message1 = (await pool.query<{ id: string }>(
      `INSERT INTO messages (tenant_id, gmail_message_id) VALUES ($1, 'message-1') RETURNING id`,
      [tenant1],
    )).rows[0]!.id;
    const message2 = (await pool.query<{ id: string }>(
      `INSERT INTO messages (tenant_id, gmail_message_id) VALUES ($1, 'message-2') RETURNING id`,
      [tenant2],
    )).rows[0]!.id;
    const user1 = (await pool.query<{ id: string }>(
      `INSERT INTO users (tenant_id, email, role, status)
       VALUES ($1, 'owner@example.test', 'owner_controller', 'active') RETURNING id`,
      [tenant1],
    )).rows[0]!.id;
    const connection1 = (await pool.query<{ id: string }>(
      `INSERT INTO connections (tenant_id, provider, connection_class, external_company)
       VALUES ($1, 'qbo', 'cloud', 'sandbox-1') RETURNING id`,
      [tenant1],
    )).rows[0]!.id;
    const document1 = (await pool.query<{ id: string }>(
      `INSERT INTO accounting_documents
         (tenant_id, message_id, kind, sha256, status, classification_confidence)
       VALUES ($1, $2, 'bank_statement', 'hash-1', 'review', 0.95) RETURNING id`,
      [tenant1, message1],
    )).rows[0]!.id;
    const statement1 = (await pool.query<{ id: string }>(
      `INSERT INTO bank_statements
         (tenant_id, document_id, period_start, period_end, opening_balance, closing_balance, status)
       VALUES ($1, $2, '2026-06-01', '2026-06-30', 1000, 900, 'review') RETURNING id`,
      [tenant1, document1],
    )).rows[0]!.id;

    await pool.query(
      `INSERT INTO bank_statement_lines
         (tenant_id, statement_id, line_no, posted_on, description, amount, balance, fingerprint)
       VALUES ($1, $2, 1, '2026-06-02', 'Vendor', -100, 900, 'line-hash-1')`,
      [tenant1, statement1],
    );
    await pool.query(
      `INSERT INTO provider_jobs
         (tenant_id, connection_id, operation, request_payload, idempotency_key)
       VALUES ($1, $2, 'post_bill', '{}', 'stable-key-1')`,
      [tenant1, connection1],
    );
    await pool.query(
      `INSERT INTO reply_drafts
         (tenant_id, message_id, thread_id, to_addr, subject, body_text, created_by)
       VALUES ($1, $2, 'thread-1', 'vendor@example.test', 'Question', 'Please clarify', $3)`,
      [tenant1, message1, user1],
    );

    await expect(pool.query(
      `INSERT INTO accounting_documents
         (tenant_id, message_id, kind, sha256, status)
       VALUES ($1, $2, 'invoice', 'foreign-message', 'received')`,
      [tenant1, message2],
    )).rejects.toMatchObject({ code: '23503' });
    await expect(pool.query(
      `INSERT INTO accounting_documents
         (tenant_id, message_id, kind, sha256, status)
       VALUES ($1, $2, 'receipt', 'bad-kind', 'received')`,
      [tenant1, message1],
    )).rejects.toMatchObject({ code: '23514' });
    await expect(pool.query(
      `INSERT INTO provider_jobs
         (tenant_id, connection_id, operation, request_payload, idempotency_key)
       VALUES ($1, $2, 'post_bill', '{}', 'stable-key-1')`,
      [tenant1, connection1],
    )).rejects.toMatchObject({ code: '23505' });
    await expect(pool.query(
      `INSERT INTO reply_drafts
         (tenant_id, message_id, thread_id, to_addr, subject, body_text, created_by)
       VALUES ($1, $2, 'thread-1', 'vendor@example.test', 'Again', 'Again', $3)`,
      [tenant1, message1, user1],
    )).rejects.toMatchObject({ code: '23505' });

    await expect(migrateDown(disposableUrl.toString())).rejects.toThrow(
      'refusing DOWN for 008_accounting_intake: retained rows exist',
    );
    expect((await pool.query(
      `SELECT count(*)::int AS count FROM _migrations WHERE name = '008_accounting_intake.sql'`,
    )).rows[0].count).toBe(1);

    await pool.query(`
      TRUNCATE reply_drafts, provider_jobs, bank_statement_lines,
               bank_statements, accounting_documents
    `);
    await expect(migrateDown(disposableUrl.toString())).resolves.toBe('008_accounting_intake.sql');
    expect((await pool.query(
      `SELECT to_regclass('public.accounting_documents') AS relation`,
    )).rows[0].relation).toBeNull();

    await expect(migrateUp(disposableUrl.toString())).resolves.toContain('008_accounting_intake.sql');
    expect((await pool.query(
      `SELECT to_regclass('public.accounting_documents') AS relation`,
    )).rows[0].relation).toBe('accounting_documents');
  }, 60_000);
});
