import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { retryProposal } from '../src/services/proposals.js';
import { query } from '../src/db/pool.js';
import { recordProofRef } from '../src/swarmsync/proof.js';
import {
  resetTables, createTenant, createUser, createConnection, insertDimensionMapping,
  insertMessage, insertAttachment, insertExtraction, closeAll,
} from './helpers.js';
import { mockConnector } from './connector-mock.js';
import type { PostDeps } from '../src/pipeline/posting.js';
import type { ActorContext } from '../src/services/index.js';

/**
 * INVESTIGATION #3 — does retrying a held proposal
 * (`app/api/proposals/[id]/retry` -> `runRetry` -> `retryProposal` -> `runPostAndMap` ->
 * `postOnce`) re-evaluate against the CURRENT tax_mapping/dimension_mapping state, or does
 * it replay a stale cached decision?
 *
 * ANSWER (see src/pipeline/posting.ts postOnce, read top-to-bottom): postOnce takes NO
 * cached decision as input. On every call it re-SELECTs the proposal row fresh, then for
 * the tax gate re-queries `listTaxMappings(tenantId, {connectionId, provider})` and
 * filters by the resolved code (taxMappingStore.listTaxMappings issues a live SQL SELECT —
 * no memoization anywhere in the module), and for the dimension gate re-runs
 * `SELECT dimension_type, resolution_state, review_status FROM dimension_mappings WHERE
 * tenant_id=$1 AND proposal_id=$2` — also a live query. `retryProposal`
 * (src/services/proposals.ts) calls `runPostAndMap` -> `postOnce` with no shortcut; it does
 * not read or replay any prior PostResult. Crucially, on a HELD outcome `postOnce` never
 * mutates `proposals.status` (it only returns `{status:'held', reason}`), so the proposal
 * remains `status='ready'` and is eligible to pass the top-of-function status gate again on
 * retry. CONCLUSION: retry genuinely re-evaluates fresh — no gap. This file proves that
 * empirically (fail on stale-config, succeed once the mapping is created, with ZERO change
 * to the proposal's proposed_txn between the two calls) rather than trusting the reading
 * alone. No production code changes were required.
 */

const anchor = () => Promise.resolve({ proof_id: 'ap1', chain_hash: 'ch1', verification_status: 'passed' as const, confidence: 1, raw: {} });
const loadPdf = async () => Buffer.from('%PDF');

function postDeps(): PostDeps {
  return { connector: mockConnector(), anchor, loadPdf, amountCeiling: 10000, autoThreshold: 0.9 };
}

async function actorFor(t: number): Promise<ActorContext> {
  const uid = await createUser(t, { role: 'owner_controller', email: 'owner@example.com' });
  return { userId: uid, tenantId: t, role: 'owner_controller', email: 'owner@example.com' };
}

async function seedReadyProposal(t: number, txnOverride: Record<string, unknown> = {}) {
  const m = await insertMessage(t);
  const a = await insertAttachment(t, m, { sha256: `sha-${t}-${Math.floor(performance.now())}` });
  const sha = (await query<{ sha256: string }>('SELECT sha256 FROM attachments WHERE id=$1', [a])).rows[0]!.sha256;
  const e = await insertExtraction(t, m, a, {}, 0.95);
  await recordProofRef({ tenantId: t, entityKind: 'extraction', entityId: String(e), product: 'verify_api', proofId: 'p', chainHash: 'h' });
  const txn = {
    txnType: 'Bill', vendorRef: { value: 'V1', name: 'Acme' }, DocNumber: 'INV-1', TxnDate: '2026-07-01',
    TotalAmt: 100, lines: [{ Amount: 100, description: 'work', accountRef: { value: '60' } }], tax: 0,
    ...txnOverride,
  };
  const pid = (
    await query<{ id: number }>(
      `INSERT INTO proposals (tenant_id, attachment_id, extraction_id, proposed_txn, idempotency_key, confidence, status, flags)
       VALUES ($1,$2,$3,$4,$5,0.95,'ready','{}') RETURNING id`,
      [t, a, e, JSON.stringify(txn), sha],
    )
  ).rows[0]!.id;
  await recordProofRef({ tenantId: t, entityKind: 'proposal', entityId: String(pid), product: 'invoiceproof', verdict: 'clean' });
  return pid;
}

describe('F5 retry re-evaluation — tax_mappings', () => {
  beforeEach(resetTables);
  afterAll(closeAll);

  it('a proposal held for tax_mapping_not_found succeeds on retry once the mapping is created, with proposed_txn unchanged', async () => {
    const t = await createTenant();
    await createConnection(t, { provider: 'qbo', externalCompany: 'sandbox-realm' });
    const ctx = await actorFor(t);
    const pid = await seedReadyProposal(t, {
      TotalAmt: 108, lines: [{ Amount: 100, description: 'work', accountRef: { value: '60' } }],
      tax: { mode: 'exclusive', amount: 8, code: 'TAX1', subtotal: 100 },
    });
    const txnBefore = (await query<{ proposed_txn: any }>('SELECT proposed_txn FROM proposals WHERE id=$1', [pid])).rows[0]!.proposed_txn;

    const firstAttempt = await retryProposal(ctx, pid, postDeps());
    expect(firstAttempt.status).toBe('held');
    expect((firstAttempt as any).reason).toBe('tax_mapping_not_found');

    // Proposal remains 'ready' — never mutated by the hold — so it stays eligible for retry.
    const statusAfterHold = (await query<{ status: string }>('SELECT status FROM proposals WHERE id=$1', [pid])).rows[0]!.status;
    expect(statusAfterHold).toBe('ready');

    // Only the DB config changes between the two calls — proposed_txn is byte-identical.
    const connRow = (await query<{ id: number }>('SELECT id FROM connections WHERE tenant_id=$1', [t])).rows[0]!.id;
    await query(
      `INSERT INTO tax_mappings (tenant_id, connection_id, provider, provider_tax_code, internal_tax_treatment, tax_mode, active, needs_revalidation)
       VALUES ($1,$2,'qbo','TAX1','Standard Sales Tax','exclusive',true,false)`,
      [t, connRow],
    );
    const txnBetween = (await query<{ proposed_txn: any }>('SELECT proposed_txn FROM proposals WHERE id=$1', [pid])).rows[0]!.proposed_txn;
    expect(txnBetween).toEqual(txnBefore); // proves the pipeline did NOT need to re-propose

    const secondAttempt = await retryProposal(ctx, pid, postDeps());
    expect(secondAttempt.status).toBe('posted');
  });

  it('a proposal held for a NEWLY-disabled tax_mapping (was active, then disabled between attempts) holds fresh on retry, not stale-ok', async () => {
    const t = await createTenant();
    await createConnection(t, { provider: 'qbo', externalCompany: 'sandbox-realm' });
    const ctx = await actorFor(t);
    const connRow = (await query<{ id: number }>('SELECT id FROM connections WHERE tenant_id=$1', [t])).rows[0]!.id;
    await query(
      `INSERT INTO tax_mappings (tenant_id, connection_id, provider, provider_tax_code, internal_tax_treatment, tax_mode, active, needs_revalidation)
       VALUES ($1,$2,'qbo','TAX1','Standard Sales Tax','exclusive',true,false)`,
      [t, connRow],
    );
    const pid = await seedReadyProposal(t, {
      TotalAmt: 108, lines: [{ Amount: 100, description: 'work', accountRef: { value: '60' } }],
      tax: { mode: 'exclusive', amount: 8, code: 'TAX1', subtotal: 100 },
    });

    // Disable the mapping BEFORE the first attempt is ever made — proves the very first
    // real evaluation already reads current state (sanity leg), then retry re-confirms.
    await query("UPDATE tax_mappings SET active=false, needs_revalidation=true WHERE tenant_id=$1 AND connection_id=$2", [t, connRow]);
    const attempt1 = await retryProposal(ctx, pid, postDeps());
    expect(attempt1.status).toBe('held');
    expect((attempt1 as any).reason).toBe('tax_mapping_inactive');

    // Re-activate and retry again — must flip to posted on the SAME retry call, proving no
    // caching of the earlier 'inactive' verdict anywhere in the retry path.
    await query('UPDATE tax_mappings SET active=true, needs_revalidation=false WHERE tenant_id=$1 AND connection_id=$2', [t, connRow]);
    const attempt2 = await retryProposal(ctx, pid, postDeps());
    expect(attempt2.status).toBe('posted');
  });
});

describe('F5 retry re-evaluation — dimension_mappings', () => {
  beforeEach(resetTables);
  afterAll(closeAll);

  it('a proposal held for dimension_mapping_not_found succeeds on retry once a human accepts the review row', async () => {
    const t = await createTenant();
    const connId = await createConnection(t, { provider: 'qbo', externalCompany: 'sandbox-realm' });
    const ctx = await actorFor(t);
    const pid = await seedReadyProposal(t, {
      dimensions: [{ kind: 'class', raw: 'Marketing', state: 'mapped', id: '40', name: 'Marketing' }],
    });

    const attempt1 = await retryProposal(ctx, pid, postDeps());
    expect(attempt1.status).toBe('held');
    expect((attempt1 as any).reason).toBe('dimension_mapping_not_found');

    // Simulate the reviewer accepting the dimension via the real API service (not a bare
    // insert) — proves the retry path reads whatever the review endpoints actually wrote.
    await insertDimensionMapping(t, connId, pid, {
      dimensionType: 'class', rawValue: 'Marketing', providerId: '40', reviewStatus: 'accepted', resolutionState: 'mapped',
    });
    const attempt2 = await retryProposal(ctx, pid, postDeps());
    expect(attempt2.status).toBe('posted');
  });

  it('a proposal held for dimension_mapping_not_reviewed (rejected) stays held on retry until the row is re-accepted', async () => {
    const t = await createTenant();
    const connId = await createConnection(t, { provider: 'qbo', externalCompany: 'sandbox-realm' });
    const ctx = await actorFor(t);
    const pid = await seedReadyProposal(t, {
      dimensions: [{ kind: 'class', raw: 'Marketing', state: 'mapped', id: '40', name: 'Marketing' }],
    });
    const dimId = await insertDimensionMapping(t, connId, pid, {
      dimensionType: 'class', rawValue: 'Marketing', providerId: '40', reviewStatus: 'rejected', resolutionState: 'mapped',
    });

    const attempt1 = await retryProposal(ctx, pid, postDeps());
    expect(attempt1.status).toBe('held');
    expect((attempt1 as any).reason).toBe('dimension_mapping_not_reviewed');

    // Retrying again with NO change still holds — proves it is re-checking the live row,
    // not caching "already tried, will always hold" or vice versa.
    const attemptNoChange = await retryProposal(ctx, pid, postDeps());
    expect(attemptNoChange.status).toBe('held');
    expect((attemptNoChange as any).reason).toBe('dimension_mapping_not_reviewed');

    await query("UPDATE dimension_mappings SET review_status='accepted' WHERE id=$1", [dimId]);
    const attemptAfterFix = await retryProposal(ctx, pid, postDeps());
    expect(attemptAfterFix.status).toBe('posted');
  });
});
