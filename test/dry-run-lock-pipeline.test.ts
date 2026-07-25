import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { query } from '../src/db/pool.js';
import { recordProofRef } from '../src/swarmsync/proof.js';
import { guardedPostSandboxHandler } from '../src/pipeline/register.js';
import {
  resetTables,
  createTenant,
  createConnection,
  insertMessage,
  insertAttachment,
  insertExtraction,
  countRows,
  closeAll,
} from './helpers.js';

/**
 * HKO-audit HIGH finding (2026-07-15): the automatic propose->post_sandbox pipeline
 * path bypassed CHUNK_6's DRY_RUN_LOCKED guard (which was wired only into the manual
 * approveProposal/retryProposal service calls). guardedPostSandboxHandler closes that
 * gap — this suite proves the automatic path now respects the same lock and that
 * unlocked/pre-onboarding tenants still post exactly as before (backward compat).
 */

// F4: postSandboxHandler now builds the provider-neutral connector via the factory, which
// wraps BOTH the QBO write and read clients — so both are mocked here (moving the DI to the
// connector boundary; the lock/post assertions below are unchanged). The read client's
// company name matches QBO_SANDBOX_COMPANY_NAME so the wrong-company identity guard passes.
vi.mock('../src/qbo/write.js', () => ({
  getQboWriteClient: vi.fn(async () => ({
    realm: 'sandbox-realm',
    createEntity: vi.fn().mockResolvedValue({ id: 'q1', syncToken: '0', entity: { Id: 'q1' } }),
    readEntity: vi.fn().mockResolvedValue({ TotalAmt: 100, DocNumber: 'INV-1' }),
    queryExisting: vi.fn().mockResolvedValue([]),
    attach: vi.fn().mockResolvedValue(undefined),
  })),
}));
vi.mock('../src/qbo/client.js', () => ({
  getQboReadClient: vi.fn(async () => ({
    getCompanyInfo: vi.fn().mockResolvedValue({ CompanyName: 'Sandbox Company_US_1' }),
    queryEntity: vi.fn().mockResolvedValue([]),
  })),
}));

async function seedReadyProposal(t: number): Promise<number> {
  const realm = process.env.QBO_SANDBOX_REALM_ID ?? 'sandbox-realm';
  const connectionId = await createConnection(t, {
    provider: 'qbo',
    connectionClass: 'cloud',
    externalCompany: realm,
  });
  await query('UPDATE connections SET metadata=$1 WHERE tenant_id=$2 AND id=$3', [{
    ownerWriteGate: {
      enabled: true,
      confirmedCompanyId: realm,
      backupConfirmedAt: new Date().toISOString(),
    },
  }, t, connectionId]);
  const m = await insertMessage(t);
  const a = await insertAttachment(t, m, { sha256: `sha-lock-${t}-${Math.floor(performance.now() * 1000)}` });
  const sha = (await query<{ sha256: string }>('SELECT sha256 FROM attachments WHERE id=$1', [a])).rows[0]!.sha256;
  const e = await insertExtraction(t, m, a, {}, 0.95);
  await recordProofRef({ tenantId: t, entityKind: 'extraction', entityId: String(e), product: 'verify_api', proofId: 'p', chainHash: 'h' });
  const txn = { txnType: 'Bill', vendorRef: { value: 'V1', name: 'Acme' }, DocNumber: 'INV-1', TxnDate: '2026-07-01', TotalAmt: 100, lines: [{ Amount: 100, description: 'work', accountRef: { value: '60' } }], tax: 0 };
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

describe('guardedPostSandboxHandler — automatic pipeline respects DRY_RUN_LOCKED', () => {
  beforeEach(resetTables);
  afterAll(closeAll);

  it('locked tenant (onboarding started, automation_level=off) → automatic post_sandbox job posts NOTHING', async () => {
    const t = await createTenant();
    await query('INSERT INTO onboarding_state (tenant_id) VALUES ($1)', [t]);
    const pid = await seedReadyProposal(t);

    await guardedPostSandboxHandler({ data: { tenantId: t, proposalId: pid } });

    expect(await countRows('postings', 'tenant_id=$1', [t])).toBe(0);
    expect(await countRows('proposals', "id=$1 AND status='ready'", [pid])).toBe(1); // untouched, still ready
    expect(await countRows('exceptions', "tenant_id=$1 AND reason_code='dry_run_locked'", [t])).toBe(1);
  });

  it('unlocked tenant (automation_level set away from off) → automatic post_sandbox job posts normally', async () => {
    const t = await createTenant();
    await query("INSERT INTO onboarding_state (tenant_id, automation_level) VALUES ($1, 'assisted')", [t]);
    const pid = await seedReadyProposal(t);

    await guardedPostSandboxHandler({ data: { tenantId: t, proposalId: pid } });

    expect(await countRows('postings', 'tenant_id=$1', [t])).toBe(1);
    expect(await countRows('proposals', "id=$1 AND status='posted_sandbox'", [pid])).toBe(1);
  });

  it('tenant with NO onboarding_state row (pre-CHUNK_6 / freshly bootstrapped) → posts normally (backward compat)', async () => {
    const t = await createTenant();
    const pid = await seedReadyProposal(t);

    await guardedPostSandboxHandler({ data: { tenantId: t, proposalId: pid } });

    expect(await countRows('postings', 'tenant_id=$1', [t])).toBe(1);
  });
});
