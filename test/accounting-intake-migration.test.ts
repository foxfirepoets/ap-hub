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
      // Every test-owned pool is closed above. A direct drop both avoids
      // requiring pg_signal_backend and catches any leaked connection.
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    } finally {
      await admin.end();
    }
  }, 60_000);

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

    const { rows: credentialSchema } = await pool.query<{ table_name: string }>(`
      SELECT table_name FROM information_schema.tables
       WHERE table_schema='public' AND table_name='credential_refs'
    `);
    expect(credentialSchema.map((row) => row.table_name)).toEqual(['credential_refs']);
    const { rows: transportColumns } = await pool.query<{ column_name: string }>(`
      SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name='connections'
         AND column_name IN ('transport_mode','transport_config')
       ORDER BY column_name
    `);
    expect(transportColumns.map((row) => row.column_name)).toEqual([
      'transport_config', 'transport_mode',
    ]);
    await expect(pool.query(
      `INSERT INTO credential_refs
        (tenant_id,provider,purpose,credential_target)
       VALUES ($1,'gmail','oauth_refresh','not-a-valid-target')`,
      [tenant1],
    )).rejects.toMatchObject({ code: '23514' });
    await pool.query(
      `UPDATE connections SET transport_mode='mcp_adapter',transport_config='{}' WHERE id=$1`,
      [connection1],
    );
    const hostileWords = [
      'bearer', 'authorization', 'oauth', 'clientKey', 'signingKey', 'passphrase',
      'pwd', 'auth', 'key', 'refresh', 'session', 'certificate',
      'refreshToken', 'clientSecret', 'apiKey', 'accessToken', 'privateKey',
    ];
    const punctuate = (word: string) => word
      .split('')
      .map((char, index) => `${index % 2 ? char.toUpperCase() : char.toLowerCase()}${index % 3 === 1 ? '.-_' : ''}`)
      .join('');
    const hostileKeys = [...hostileWords, ...hostileWords.map(punctuate)];
    let hostileIndex = 0;
    for (const hostileKey of hostileKeys) {
      const payloads = [
        { [hostileKey]: 'plaintext' },
        { last_refresh_status: { [hostileKey]: 'plaintext' } },
        { scope: [{ [hostileKey]: 'plaintext' }] },
      ];
      for (const hostilePayload of payloads) {
        await expect(pool.query(
          `INSERT INTO credential_refs
            (tenant_id,provider,purpose,credential_target,metadata)
           VALUES ($1,'gmail',$2,$3,$4)`,
          [tenant1, `hostile-${hostileIndex}`, `APHub/INSTALL_1/hostile-${hostileIndex}`,
            hostilePayload],
        )).rejects.toMatchObject({ code: '23514' });
        await expect(pool.query(
          `UPDATE connections SET transport_config=$2 WHERE id=$1`,
          [connection1, hostilePayload],
        )).rejects.toMatchObject({ code: '23514' });
        hostileIndex += 1;
      }
    }
    const secretValues = [
      'Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
      'sk-live_51AbCdEf0123456789abcdefghijklmnopqrstuv',
      'Sk-LiVe_51AbCdEf0123456789abcdefghijklmnopqrstuv',
      'aIzA0123456789AbCdEfGhIjKlMnOpQrStUvWxYz',
      'GhP_0123456789AbCdEfGhIjKlMnOpQrStUvWxYz',
      '-----BEGIN PRIVATE KEY-----MIIEvQIBADANBgkqhkiG9w0BAQ',
      'AbCDefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUV',
      '  Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature  ',
      '\tSk-LiVe_51AbCdEf0123456789abcdefghijklmnopqrstuv\n',
    ];
    let secretValueIndex = 0;
    for (const secretValue of secretValues) {
      const metadataPayloads = [
        { scope: [secretValue] },
        { expires_at: secretValue },
        { provider_account_id: secretValue },
        { last_refresh_status: { state: secretValue } },
        { last_refresh_status: { checked_at: secretValue } },
      ];
      for (const metadataPayload of metadataPayloads) {
        await expect(pool.query(
          `INSERT INTO credential_refs
            (tenant_id,provider,purpose,credential_target,metadata)
           VALUES ($1,'gmail',$2,$3,$4)`,
          [tenant1, `secret-value-${secretValueIndex}`,
            `APHub/INSTALL_1/secret-value-${secretValueIndex}`, metadataPayload],
        )).rejects.toMatchObject({ code: '23514' });
        secretValueIndex += 1;
      }

      const transportPayloads = [
        ['api_adapter', { endpoint_id: secretValue }],
        ['mcp_adapter', { command_id: secretValue }],
        ['mcp_adapter', { allowed_tools: [secretValue] }],
        ['direct_local_oauth', { expected_company_id: secretValue }],
        ['qb_desktop', { company_file_id: secretValue }],
        ['mcp_adapter', { transport: secretValue }],
      ] as const;
      for (const [mode, transportPayload] of transportPayloads) {
        await expect(pool.query(
          `UPDATE connections SET transport_mode=$2,transport_config=$3 WHERE id=$1`,
          [connection1, mode, transportPayload],
        )).rejects.toMatchObject({ code: '23514' });
      }
    }
    const whitespaceMetadataPayloads = [
      { scope: [' gmail.readonly'] },
      { scope: ['gmail.compose\t'] },
      { expires_at: '2026-07-25T20:00:00Z ' },
      { provider_account_id: '\towner@example.com' },
      { provider_account_id: '1234567890\n' },
      { last_refresh_status: { state: 'healthy ' } },
      { last_refresh_status: { checked_at: '\n2026-07-25T20:00:00Z' } },
    ];
    for (const [index, metadataPayload] of whitespaceMetadataPayloads.entries()) {
      await expect(pool.query(
        `INSERT INTO credential_refs
          (tenant_id,provider,purpose,credential_target,metadata)
         VALUES ($1,'gmail',$2,$3,$4)`,
        [tenant1, `whitespace-${index}`, `APHub/INSTALL_1/whitespace-${index}`,
          metadataPayload],
      )).rejects.toMatchObject({ code: '23514' });
    }
    await expect(pool.query(
      `INSERT INTO credential_refs
        (tenant_id,provider,purpose,credential_target,metadata)
       VALUES ($1,'gmail','allowed_metadata','APHub/INSTALL_1/gmail-metadata',$2)`,
      [tenant1, {
        scope: ['gmail.readonly', 'gmail.compose'],
        expires_at: '2026-07-25T20:00:00Z',
        provider_account_id: 'account-1',
        last_refresh_status: {
          state: 'healthy', attempts: 2,
          checked_at: '2026-07-25T20:00:00Z',
        },
      }],
    )).resolves.toMatchObject({ rowCount: 1 });
    await expect(pool.query(
      `INSERT INTO credential_refs
        (tenant_id,provider,purpose,credential_target,metadata)
       VALUES ($1,'qbo','allowed_numeric_realm','APHub/INSTALL_1/qbo-realm',$2)`,
      [tenant1, { provider_account_id: '1234567890123456789' }],
    )).resolves.toMatchObject({ rowCount: 1 });
    await expect(pool.query(
      `INSERT INTO credential_refs
        (tenant_id,provider,purpose,credential_target,metadata)
       VALUES ($1,'gmail','allowed_email_account','APHub/INSTALL_1/gmail-account',$2)`,
      [tenant1, { provider_account_id: 'owner+ap@example.com' }],
    )).resolves.toMatchObject({ rowCount: 1 });
    const allowedTransportConfigs = [
      ['direct_local_oauth', { expected_company_id: 'realm-1', timeout_ms: 30000 }],
      ['api_adapter', {
        endpoint_id: 'registered-qbo-api', expected_company_id: 'realm-1', timeout_ms: 30000,
      }],
      ['mcp_adapter', {
        transport: 'stdio', command_id: 'registered-qbo-mcp',
        allowed_tools: ['company_info', 'find_bill'], expected_company_id: 'realm-1',
        timeout_ms: 30000,
      }],
      ['qb_desktop', {
        expected_company_id: 'desktop-company', company_file_id: 'company-file-1',
        timeout_ms: 30000,
      }],
    ] as const;
    for (const [mode, transportConfig] of allowedTransportConfigs) {
      await expect(pool.query(
        `UPDATE connections SET transport_mode=$2,transport_config=$3 WHERE id=$1`,
        [connection1, mode, transportConfig],
      )).resolves.toMatchObject({ rowCount: 1 });
    }
    await expect(pool.query(
      `UPDATE connections SET transport_mode='web_scrape' WHERE id=$1`,
      [connection1],
    )).rejects.toMatchObject({ code: '23514' });
    await pool.query(
      `INSERT INTO credential_refs
        (tenant_id,provider,purpose,credential_target,metadata)
       VALUES ($1,'gmail','oauth_refresh','APHub/INSTALL_1/gmail-refresh',
         '{"scope":["gmail.readonly","gmail.compose"]}')`,
      [tenant1],
    );
    // CHUNK_2_DATABASE layers 014/015 above 013, the same way 009-013 are layered above 008
    // below. Revert them first so this test can still exercise 013's retained-credential
    // refusal. Neither carries a refusal guard: 014 holds only this install's own identity
    // row and 015 only backup bookkeeping, so both roll back cleanly.
    await expect(migrateDown(disposableUrl.toString())).resolves.toBe('015_backups.sql');
    await expect(migrateDown(disposableUrl.toString())).resolves.toBe('014_local_install.sql');
    await expect(migrateDown(disposableUrl.toString())).rejects.toThrow(
      'refusing DOWN for 013_local_runtime_credentials: retained rows exist',
    );
    expect((await pool.query(
      `SELECT count(*)::int AS count FROM _migrations
        WHERE name='013_local_runtime_credentials.sql'`,
    )).rows[0].count).toBe(1);
    await pool.query('DELETE FROM credential_refs');
    await pool.query(
      `UPDATE connections SET transport_mode='direct_local_oauth',
        transport_config='{"timeout_ms":30000}' WHERE id=$1`,
      [connection1],
    );
    await expect(migrateDown(disposableUrl.toString())).rejects.toThrow(
      'refusing DOWN for 013_local_runtime_credentials: retained rows exist',
    );
    await pool.query(
      `UPDATE connections SET transport_mode=NULL,transport_config='{}' WHERE id=$1`,
      [connection1],
    );
    await expect(migrateDown(disposableUrl.toString())).resolves.toBe(
      '013_local_runtime_credentials.sql',
    );
    expect((await pool.query(
      `SELECT to_regclass('public.credential_refs') AS relation`,
    )).rows[0].relation).toBeNull();
    await expect(migrateUp(disposableUrl.toString())).resolves.toEqual([
      '013_local_runtime_credentials.sql',
      '014_local_install.sql',
      '015_backups.sql',
    ]);
    // 014 UP -> DOWN -> UP has now completed a full cycle. Prove the singleton it exists to
    // guarantee actually holds, per spec §13.
    expect((await pool.query(
      `SELECT to_regclass('public.local_install') AS relation`,
    )).rows[0].relation).toBe('local_install');
    await pool.query(
      `INSERT INTO local_install (install_id, os_account_id, platform, app_version, db_port)
       VALUES (gen_random_uuid(), 'S-1-5-21-0-0-0-1001', 'win32', '0.1.0', 55433)`,
    );
    await expect(pool.query(
      `INSERT INTO local_install (id, install_id, os_account_id, platform, app_version, db_port)
       VALUES (2, gen_random_uuid(), 'S-1-5-21-0-0-0-1002', 'win32', '0.1.0', 55434)`,
    )).rejects.toMatchObject({ code: '23514' });
    // 015: an unverified backup must remain distinguishable from a verified one, because
    // rotation counts only the verified ones.
    await pool.query(
      `INSERT INTO backups (kind, path, size_bytes, manifest_hash, row_counts, verified_at)
       VALUES ('scheduled', '/b/unverified.enc', 10, 'h1', '{}'::jsonb, NULL),
              ('scheduled', '/b/verified.enc',   10, 'h2', '{}'::jsonb, now())`,
    );
    expect((await pool.query(
      `SELECT count(*)::int AS count FROM backups WHERE verified_at IS NOT NULL`,
    )).rows[0].count).toBe(1);
    await pool.query('TRUNCATE backups, local_install');
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

    // Later additive migrations are layered above 008. Revert them first so
    // this test can exercise 008's retained-accounting-data refusal.
    await expect(migrateDown(disposableUrl.toString())).resolves.toBe('015_backups.sql');
    await expect(migrateDown(disposableUrl.toString())).resolves.toBe('014_local_install.sql');
    await expect(migrateDown(disposableUrl.toString())).resolves.toBe(
      '013_local_runtime_credentials.sql',
    );
    await expect(migrateDown(disposableUrl.toString())).resolves.toBe(
      '012_classification_dispatches.sql',
    );
    await expect(migrateDown(disposableUrl.toString())).resolves.toBe(
      '011_sso_login_states.sql',
    );
    await expect(migrateDown(disposableUrl.toString())).resolves.toBe(
      '010_reply_draft_result_unknown.sql',
    );
    await expect(migrateDown(disposableUrl.toString())).resolves.toBe(
      '009_oauth_connect_states.sql',
    );
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

    await expect(migrateUp(disposableUrl.toString())).resolves.toEqual([
      '008_accounting_intake.sql',
      '009_oauth_connect_states.sql',
      '010_reply_draft_result_unknown.sql',
      '011_sso_login_states.sql',
      '012_classification_dispatches.sql',
      '013_local_runtime_credentials.sql',
      '014_local_install.sql',
      '015_backups.sql',
    ]);
    expect((await pool.query(
      `SELECT to_regclass('public.accounting_documents') AS relation`,
    )).rows[0].relation).toBe('accounting_documents');
    // Full stack, including the two migrations this phase adds, reaches head from empty.
    expect((await pool.query(
      `SELECT to_regclass('public.local_install') AS relation`,
    )).rows[0].relation).toBe('local_install');
    expect((await pool.query(
      `SELECT to_regclass('public.backups') AS relation`,
    )).rows[0].relation).toBe('backups');
  }, 60_000);
});
