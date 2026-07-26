import { describe, it, expect, beforeEach, afterAll } from 'vitest';

import { READ_CHANNELS } from '../desktop/ipc/read/channels.js';
import { READ_ENTRIES } from '../desktop/ipc/read/index.js';
import { CHANNEL_PATTERN } from '../desktop/channels.js';
import { buildRegistry, type RegistryEntry, type ChannelContribution } from '../desktop/ipc/registry.js';
import { createDispatcher } from '../desktop/ipc/dispatcher.js';
import { clearSessionToken, setSessionToken } from '../desktop/ipc/context.js';
import { plainMessage } from '../desktop/ipc/errors.js';

import { createSession } from '../src/auth/session.js';
import { query } from '../src/db/pool.js';
import {
  closeAll,
  createConnection,
  createTenant,
  createUser,
  insertAttachment,
  insertDimensionMapping,
  insertExtraction,
  insertMessage,
  insertProposal,
  resetTables,
} from './helpers.js';

/**
 * B3 — contract tests for the 21 read-domain channels. `test/ipc-foundation.test.ts` already
 * covers the shared machinery (synthesis, decoding, code normalization, token custody); these
 * tests cover THIS agent's wiring: every route listed for B3 has exactly one channel, the two
 * owner-only read wrappers (`runTaxMappingRead` / `runDimensionMappingRead`) are not
 * accidentally widened to bookkeeper/cpa, a malformed payload never reaches a service, a
 * cross-tenant id never leaks a foreign row, and response schemas accept real rows out of
 * Postgres (the persistedId/bigint trap the packet called out).
 */

const OWNER_ONLY_CHANNELS = [
  'aphub:provider-jobs:list',
  'aphub:dimension-mappings:list',
  'aphub:tax-mappings:list',
  'aphub:tax-mappings:get',
  'aphub:tax-mappings:discover',
  'aphub:tax-mappings:audit',
] as const;

function entryFor(channel: string): RegistryEntry {
  const entry = READ_ENTRIES.find((e) => e.channel === channel);
  if (!entry) throw new Error(`test setup: no entry for ${channel}`);
  return entry;
}

/** Minimal payload that satisfies an entry's required path/query params, for role/auth probes
 * that never need to reach real data (owner-only channels answer FORBIDDEN before any query). */
function minimalPayloadFor(channel: string): Record<string, unknown> {
  switch (channel) {
    case 'aphub:tax-mappings:get':
    case 'aphub:tax-mappings:audit':
      return { id: 1 };
    default:
      return {};
  }
}

/** Dispatches an entry through the REAL pipeline (schema, DB gate, decode) under a name
 * borrowed from `SHELL_CHANNELS`, exactly as `test/ipc-foundation.test.ts` does — this agent
 * does not own `desktop/channels.ts`, so a not-yet-integrated channel name cannot pass the
 * live allowlist gate. The borrowed name changes nothing about `request`/`response`/`role`/
 * `invoke`, which are the real, unmodified production values. */
function viaDispatch(entry: RegistryEntry, databaseState: () => 'ready' | 'starting' | 'failed' = () => 'ready') {
  const borrowed: RegistryEntry = { ...entry, channel: 'aphub:shell:version' };
  const contribution: ChannelContribution = { channels: [borrowed.channel], entries: [borrowed] };
  const { dispatch } = createDispatcher({ contributions: [contribution], databaseState });
  return (payload?: unknown) => dispatch(borrowed.channel, payload);
}

/** Same as `viaDispatch`, but counts real invocations of the entry's own `invoke`, so a test
 * can assert the service was never reached. */
function viaDispatchWithSpy(entry: RegistryEntry) {
  let calls = 0;
  const spying: RegistryEntry = {
    ...entry,
    channel: 'aphub:shell:version',
    invoke: async (request, payload) => {
      calls += 1;
      return entry.invoke(request, payload);
    },
  };
  const contribution: ChannelContribution = { channels: [spying.channel], entries: [spying] };
  const { dispatch } = createDispatcher({ contributions: [contribution], databaseState: () => 'ready' });
  return { dispatch: (payload?: unknown) => dispatch(spying.channel, payload), callCount: () => calls };
}

async function sessionFor(tenantId: number, role: string): Promise<string> {
  const userId = await createUser(tenantId, { role, email: `${role}-${tenantId}-${Math.random()}@example.com` });
  return (await createSession(userId)).token;
}

// --- registry shape: every listed route has exactly one channel, both directions ----------

describe('the 21 read channels are registered exactly once, symmetrically', () => {
  it('builds without throwing: READ_CHANNELS and READ_ENTRIES are set-equal', () => {
    expect(() => buildRegistry([{ channels: READ_CHANNELS, entries: READ_ENTRIES }])).not.toThrow();
    expect(READ_ENTRIES).toHaveLength(READ_CHANNELS.length);
    const declared = new Set<string>(READ_CHANNELS);
    const registered = new Set(READ_ENTRIES.map((e) => e.channel));
    expect(registered.size).toBe(READ_ENTRIES.length); // no duplicate channel across entries
    for (const channel of declared) expect(registered.has(channel)).toBe(true);
    for (const channel of registered) expect(declared.has(channel)).toBe(true);
  });

  it('names every channel aphub:<domain>:<action>, matching the shell allowlist pattern', () => {
    for (const channel of READ_CHANNELS) expect(channel).toMatch(CHANNEL_PATTERN);
  });

  it('declares every read channel as GET with no body keys', () => {
    for (const entry of READ_ENTRIES) {
      expect(entry.method).toBe('GET');
      expect(entry.bodyKeys ?? []).toHaveLength(0);
    }
  });

  it('covers every route this agent was assigned, by pathTemplate', () => {
    const paths = new Set(READ_ENTRIES.map((e) => e.pathTemplate));
    for (const expected of [
      '/api/today',
      '/api/transactions',
      '/api/transactions/:id',
      '/api/exceptions',
      '/api/exceptions/:id',
      '/api/items/:id/evidence',
      '/api/audit',
      '/api/notifications',
      '/api/me',
      '/api/accounting-documents/review',
      '/api/statements',
      '/api/statements/:id',
      '/api/reply-drafts',
      '/api/provider-capabilities',
      '/api/provider-jobs',
      '/api/dimension-mappings',
      '/api/tax-mappings',
      '/api/tax-mappings/:id',
      '/api/tax-mappings/discover',
      '/api/tax-mappings/:id/audit',
      '/api/onboarding',
    ]) {
      expect(paths.has(expected)).toBe(true);
    }
  });
});

// --- a malformed payload never reaches the service, across every channel ------------------

describe('a malformed payload never reaches the service, on every one of the 21 channels', () => {
  for (const entry of READ_ENTRIES) {
    it(`${entry.channel}: an unrecognized field is rejected and the service is never called`, async () => {
      const { dispatch, callCount } = viaDispatchWithSpy(entry);
      const result = await dispatch({ __bogus_field_no_channel_ever_declares__: 'x' });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('VALIDATION');
      expect(callCount()).toBe(0);
    });
  }
});

// --- owner-only channels: exhaustive bookkeeper/cpa FORBIDDEN ------------------------------

describe('every owner-only read channel refuses bookkeeper and cpa, exhaustively', () => {
  beforeEach(async () => {
    await resetTables();
    clearSessionToken();
  });
  afterAll(async () => {
    clearSessionToken();
    await closeAll();
  });

  it('lists exactly the 6 owner-only channels this packet flagged', () => {
    expect(new Set(OWNER_ONLY_CHANNELS).size).toBe(6);
    for (const channel of OWNER_ONLY_CHANNELS) {
      expect(entryFor(channel).role).toEqual(['owner_controller']);
    }
  });

  for (const channel of OWNER_ONLY_CHANNELS) {
    it(`${channel}: bookkeeper and cpa both get FORBIDDEN, owner does not`, async () => {
      const tenant = await createTenant('Owner-Only Tenant');
      const entry = entryFor(channel);
      const dispatch = viaDispatch(entry);
      const payload = minimalPayloadFor(channel);

      for (const role of ['bookkeeper', 'cpa']) {
        setSessionToken(await sessionFor(tenant, role));
        const result = await dispatch(payload);
        expect(result).toEqual({
          ok: false,
          status: 403,
          code: 'FORBIDDEN',
          message: plainMessage('FORBIDDEN'),
        });
        expect(result.data).toBeUndefined();
      }

      setSessionToken(await sessionFor(tenant, 'owner_controller'));
      const asOwner = await dispatch(payload);
      expect(asOwner.code).not.toBe('FORBIDDEN');
    });
  }
});

// --- cross-tenant reads turn into NOT_FOUND, never a foreign row ---------------------------

describe('cross-tenant by-id reads answer NOT_FOUND with no foreign content', () => {
  beforeEach(async () => {
    await resetTables();
    clearSessionToken();
  });
  afterAll(async () => {
    clearSessionToken();
    await closeAll();
  });

  it('aphub:exceptions:get never leaks another tenant\'s row', async () => {
    const tenantA = await createTenant('Tenant A');
    const tenantB = await createTenant('Tenant B');
    const { rows } = await query<{ id: number }>(
      `INSERT INTO exceptions (tenant_id, entity_ref, reason_code, status)
       VALUES ($1, 'secret-tenant-a-entity-ref', 'no_vendor_match', 'open') RETURNING id`,
      [tenantA],
    );
    const exceptionId = Number(rows[0]!.id);

    setSessionToken(await sessionFor(tenantB, 'owner_controller'));
    const dispatch = viaDispatch(entryFor('aphub:exceptions:get'));
    const result = await dispatch({ id: exceptionId });

    expect(result).toEqual({ ok: false, status: 404, code: 'NOT_FOUND', message: plainMessage('NOT_FOUND') });
    expect(JSON.stringify(result)).not.toContain('secret-tenant-a-entity-ref');
  });

  it('aphub:tax-mappings:get (the owner-only flagged wrapper) never leaks another tenant\'s row', async () => {
    const tenantA = await createTenant('Tenant A');
    const tenantB = await createTenant('Tenant B');
    const connectionA = await createConnection(tenantA);
    const { rows } = await query<{ id: number }>(
      `INSERT INTO tax_mappings (tenant_id, connection_id, provider, provider_tax_code, internal_tax_treatment, tax_mode)
       VALUES ($1, $2, 'qbo', 'SECRET-TAX-CODE-A', 'standard', 'exclusive') RETURNING id`,
      [tenantA, connectionA],
    );
    const taxMappingId = Number(rows[0]!.id);

    setSessionToken(await sessionFor(tenantB, 'owner_controller'));
    const dispatch = viaDispatch(entryFor('aphub:tax-mappings:get'));
    const result = await dispatch({ id: taxMappingId });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('NOT_FOUND');
    expect(JSON.stringify(result)).not.toContain('SECRET-TAX-CODE-A');
  });

  it('aphub:transactions:get never leaks another tenant\'s row', async () => {
    const tenantA = await createTenant('Tenant A');
    const tenantB = await createTenant('Tenant B');
    const proposalId = Number(await insertProposal(tenantA, { status: 'review' }));

    setSessionToken(await sessionFor(tenantB, 'owner_controller'));
    const dispatch = viaDispatch(entryFor('aphub:transactions:get'));
    const result = await dispatch({ id: proposalId });

    expect(result).toEqual({ ok: false, status: 404, code: 'NOT_FOUND', message: plainMessage('NOT_FOUND') });
  });
});

// --- response schemas accept REAL rows from Postgres (the persistedId/bigint trap) ---------

describe('response schemas accept real Postgres rows, across every response-shape family', () => {
  beforeEach(async () => {
    await resetTables();
    clearSessionToken();
  });
  afterAll(async () => {
    clearSessionToken();
    await closeAll();
  });

  it('aphub:today:get and aphub:transactions:list accept a real proposal row (bigint proposalId)', async () => {
    const tenant = await createTenant('Real Data Tenant');
    await insertProposal(tenant, { status: 'review' });
    setSessionToken(await sessionFor(tenant, 'owner_controller'));

    const today = await viaDispatch(entryFor('aphub:today:get'))({});
    expect(today).toMatchObject({ ok: true, status: 200 });

    const transactions = await viaDispatch(entryFor('aphub:transactions:list'))({});
    expect(transactions).toMatchObject({ ok: true, status: 200 });
  });

  it('aphub:exceptions:list accepts a real exception row (bigint id)', async () => {
    const tenant = await createTenant('Real Data Tenant');
    await query(`INSERT INTO exceptions (tenant_id, reason_code, status) VALUES ($1, 'no_vendor_match', 'open')`, [
      tenant,
    ]);
    setSessionToken(await sessionFor(tenant, 'owner_controller'));
    const result = await viaDispatch(entryFor('aphub:exceptions:list'))({});
    expect(result).toMatchObject({ ok: true, status: 200 });
  });

  it('aphub:evidence:get accepts a real, fully-populated evidence chain', async () => {
    const tenant = await createTenant('Real Data Tenant');
    const messageId = await insertMessage(tenant);
    const attachmentId = await insertAttachment(tenant, messageId);
    const extractionId = await insertExtraction(tenant, messageId, attachmentId, {});
    const proposalId = Number(await insertProposal(tenant, { attachmentId, extractionId, status: 'review' }));
    setSessionToken(await sessionFor(tenant, 'owner_controller'));

    const result = await viaDispatch(entryFor('aphub:evidence:get'))({ id: proposalId });
    expect(result).toMatchObject({ ok: true, status: 200 });
  });

  it('aphub:audit:list and aphub:notifications:list accept real rows (bigint id)', async () => {
    const tenant = await createTenant('Real Data Tenant');
    await query(`INSERT INTO audit_log (tenant_id, actor, action) VALUES ($1, 'system', 'test.event')`, [tenant]);
    await query(`INSERT INTO notifications (tenant_id, kind, severity, payload) VALUES ($1, 'daily_digest', 'info', '{}')`, [
      tenant,
    ]);
    setSessionToken(await sessionFor(tenant, 'owner_controller'));

    expect(await viaDispatch(entryFor('aphub:audit:list'))({})).toMatchObject({ ok: true, status: 200 });
    expect(await viaDispatch(entryFor('aphub:notifications:list'))({})).toMatchObject({ ok: true, status: 200 });
  });

  it('aphub:me:get returns tenantId as a real bigint-string, not a number', async () => {
    const tenant = await createTenant('Real Data Tenant');
    setSessionToken(await sessionFor(tenant, 'owner_controller'));
    const result = await viaDispatch(entryFor('aphub:me:get'))({});
    expect(result.ok).toBe(true);
  });

  it('aphub:dimension-mappings:list accepts a real dimension_mappings row (bigint ids)', async () => {
    const tenant = await createTenant('Real Data Tenant');
    const connectionId = await createConnection(tenant);
    const proposalId = await insertProposal(tenant, { status: 'review' });
    await insertDimensionMapping(tenant, connectionId, proposalId);
    setSessionToken(await sessionFor(tenant, 'owner_controller'));

    const result = await viaDispatch(entryFor('aphub:dimension-mappings:list'))({});
    expect(result).toMatchObject({ ok: true, status: 200 });
  });

  it('aphub:tax-mappings:list and :audit accept real tax_mappings/tax_mapping_audit rows', async () => {
    const tenant = await createTenant('Real Data Tenant');
    const connectionId = await createConnection(tenant);
    const { rows } = await query<{ id: number }>(
      `INSERT INTO tax_mappings (tenant_id, connection_id, provider, provider_tax_code, internal_tax_treatment, tax_mode)
       VALUES ($1, $2, 'qbo', 'TAX8', 'standard', 'exclusive') RETURNING id`,
      [tenant, connectionId],
    );
    const taxMappingId = Number(rows[0]!.id);
    await query(
      `INSERT INTO tax_mapping_audit (tenant_id, tax_mapping_id, connection_id, provider, action)
       VALUES ($1, $2, $3, 'qbo', 'create')`,
      [tenant, taxMappingId, connectionId],
    );
    setSessionToken(await sessionFor(tenant, 'owner_controller'));

    const list = await viaDispatch(entryFor('aphub:tax-mappings:list'))({});
    expect(list).toMatchObject({ ok: true, status: 200 });
    const audit = await viaDispatch(entryFor('aphub:tax-mappings:audit'))({ id: taxMappingId });
    expect(audit).toMatchObject({ ok: true, status: 200 });
  });

  it('aphub:provider-capabilities:list accepts a real connections row', async () => {
    const tenant = await createTenant('Real Data Tenant');
    await createConnection(tenant, { provider: 'qbo' });
    setSessionToken(await sessionFor(tenant, 'owner_controller'));
    const result = await viaDispatch(entryFor('aphub:provider-capabilities:list'))({});
    expect(result).toMatchObject({ ok: true, status: 200 });
  });

  it('aphub:provider-jobs:list succeeds with a real (empty) query', async () => {
    const tenant = await createTenant('Real Data Tenant');
    setSessionToken(await sessionFor(tenant, 'owner_controller'));
    const result = await viaDispatch(entryFor('aphub:provider-jobs:list'))({});
    expect(result).toMatchObject({ ok: true, status: 200 });
  });

  it('aphub:onboarding:get succeeds with defaults (no onboarding_state row yet)', async () => {
    const tenant = await createTenant('Real Data Tenant');
    setSessionToken(await sessionFor(tenant, 'owner_controller'));
    const result = await viaDispatch(entryFor('aphub:onboarding:get'))({});
    expect(result).toMatchObject({ ok: true, status: 200 });
  });

  it('aphub:statements:list and :get accept a real bank_statements row', async () => {
    const tenant = await createTenant('Real Data Tenant');
    const messageId = await insertMessage(tenant);
    const { rows: docRows } = await query<{ id: number }>(
      `INSERT INTO accounting_documents (tenant_id, message_id, kind, sha256, status)
       VALUES ($1, $2, 'bank_statement', 'sha-stmt-1', 'review') RETURNING id`,
      [tenant, messageId],
    );
    const documentId = docRows[0]!.id;
    const { rows: stmtRows } = await query<{ id: number }>(
      `INSERT INTO bank_statements (tenant_id, document_id, institution_name, status)
       VALUES ($1, $2, 'Test Bank', 'review') RETURNING id`,
      [tenant, documentId],
    );
    const statementId = Number(stmtRows[0]!.id);
    setSessionToken(await sessionFor(tenant, 'owner_controller'));

    const list = await viaDispatch(entryFor('aphub:statements:list'))({});
    expect(list).toMatchObject({ ok: true, status: 200 });
    const get = await viaDispatch(entryFor('aphub:statements:get'))({ id: statementId });
    expect(get).toMatchObject({ ok: true, status: 200 });
  });

  it('aphub:accounting-documents:review accepts a real held document', async () => {
    const tenant = await createTenant('Real Data Tenant');
    const messageId = await insertMessage(tenant);
    await query(
      `INSERT INTO accounting_documents (tenant_id, message_id, kind, sha256, status)
       VALUES ($1, $2, 'unknown', 'sha-review-1', 'held')`,
      [tenant, messageId],
    );
    setSessionToken(await sessionFor(tenant, 'owner_controller'));
    const result = await viaDispatch(entryFor('aphub:accounting-documents:review'))({});
    expect(result).toMatchObject({ ok: true, status: 200 });
  });

  it('aphub:reply-drafts:get accepts a real reply_drafts row', async () => {
    const tenant = await createTenant('Real Data Tenant');
    const owner = await createUser(tenant, { role: 'owner_controller' });
    const messageId = await insertMessage(tenant);
    await query(
      `INSERT INTO reply_drafts (tenant_id, message_id, thread_id, to_addr, subject, body_text, created_by)
       VALUES ($1, $2, 'thread-1', 'vendor@example.com', 'Re: invoice', 'body', $3)`,
      [tenant, messageId, owner],
    );
    setSessionToken(await sessionFor(tenant, 'owner_controller'));
    const result = await viaDispatch(entryFor('aphub:reply-drafts:get'))({ messageId: Number(messageId) });
    expect(result).toMatchObject({ ok: true, status: 200 });
  });
});
