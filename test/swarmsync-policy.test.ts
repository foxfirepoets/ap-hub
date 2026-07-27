import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { query } from '../src/db/pool.js';
import { postOnce } from '../src/pipeline/posting.js';
import { gatekeepHandler } from '../src/pipeline/gatekeep.js';
import { recordProofRef } from '../src/swarmsync/proof.js';
import { resetConfigCache } from '../src/config.js';
import {
  resetTables, createTenant, createConnection,
  insertMessage, insertAttachment, insertExtraction, countRows, closeAll,
} from './helpers.js';
import { mockConnector } from './connector-mock.js';

/**
 * CHUNK_6_SWARMSYNC_POLICY (architecture-decision-packet §5): with SWARMSYNC_ENABLED
 * defaulting to false (CHUNK_6), the disabled/unavailable rules are distinguished by
 * the company's own swarmSyncPolicy (connections.metadata.swarmSyncPolicy), not by
 * SwarmSync's availability alone:
 *   - 'optional' (default/absent) -> proceed exactly as if the check passed (rule 1, noop).
 *   - 'required' -> hold and raise a typed exception, never proceed silently (rule 2).
 */

vi.mock('../src/gmail/adapter.js', () => ({
  getGmailClient: vi.fn(async () => ({
    listHistory: vi.fn(),
    getMessage: vi.fn(),
    sendForward: vi.fn().mockResolvedValue({ sendId: 'send-1', to: 'co@qbodocs.com' }),
    findSentBySubjectTag: vi.fn().mockResolvedValue(null),
  })),
}));

async function seedReadyProposal(t: number) {
  const realm = 'sandbox-realm';
  await createConnection(t, { provider: 'qbo', connectionClass: 'cloud', externalCompany: realm });
  const m = await insertMessage(t);
  const a = await insertAttachment(t, m, { sha256: `sha-pol-${t}-${Math.floor(performance.now() * 1000)}` });
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

async function setPolicy(t: number, policy: 'optional' | 'required') {
  await query(`UPDATE connections SET metadata = metadata || $1::jsonb WHERE tenant_id=$2`, [
    JSON.stringify({ swarmSyncPolicy: policy }),
    t,
  ]);
}

const loadPdf = async () => Buffer.from('%PDF');
const okAnchor = vi.fn().mockResolvedValue({ proof_id: 'ap1', chain_hash: 'ch1', verification_status: 'passed', confidence: 1, raw: {} });

describe('postOnce - SwarmSync off, policy-aware (rule 1 + rule 2)', () => {
  beforeEach(resetTables);
  afterAll(closeAll);

  it('optional policy (default) + SwarmSync off -> proceeds normally, posts (rule 1, noop)', async () => {
    const t = await createTenant();
    const pid = await seedReadyProposal(t);
    // No setPolicy call: metadata has no swarmSyncPolicy key, so it must default to 'optional'.
    const connector = mockConnector();
    const out = await postOnce(t, pid, {
      connector, anchor: okAnchor, loadPdf, amountCeiling: 10000, autoThreshold: 0.9,
      swarmSyncMode: 'off_review', swarmSyncEnabled: false,
    });
    expect(out.status).toBe('posted');
    expect(await countRows('postings', 'tenant_id=$1', [t])).toBe(1);
    expect(await countRows('exceptions', "tenant_id=$1 AND reason_code='swarmsync_required_unavailable'", [t])).toBe(0);
  });

  it('required policy + SwarmSync off -> holds, raises a typed exception, never posts (rule 2)', async () => {
    const t = await createTenant();
    const pid = await seedReadyProposal(t);
    await setPolicy(t, 'required');
    const connector = mockConnector();
    const out = await postOnce(t, pid, {
      connector, anchor: okAnchor, loadPdf, amountCeiling: 10000, autoThreshold: 0.9,
      swarmSyncMode: 'off_review', swarmSyncEnabled: false,
    });
    expect(out).toEqual({ status: 'held', reason: 'swarmsync_required_unavailable' });
    expect(connector.postBill).not.toHaveBeenCalled();
    expect(await countRows('postings', 'tenant_id=$1', [t])).toBe(0);
    expect(await countRows('exceptions', "tenant_id=$1 AND reason_code='swarmsync_required_unavailable'", [t])).toBe(1);
  });

  it('required policy + SwarmSync ON -> unaffected (the policy gate only applies to off_review mode)', async () => {
    const t = await createTenant();
    const pid = await seedReadyProposal(t);
    await setPolicy(t, 'required');
    const connector = mockConnector();
    const out = await postOnce(t, pid, {
      connector, anchor: okAnchor, loadPdf, amountCeiling: 10000, autoThreshold: 0.9,
      swarmSyncMode: 'on', swarmSyncEnabled: true,
    });
    expect(out.status).toBe('posted');
  });
});

describe('gatekeepHandler (pipeline) - SwarmSync off, policy-aware (rule 1 + rule 2)', () => {
  beforeEach(async () => {
    await resetTables();
    resetConfigCache();
    process.env.GATEKEEPER_ENABLED = 'true';
    process.env.SWARMSYNC_ENABLED = 'false';
    process.env.QBO_FORWARDING_ADDRESS = 'co@qbodocs.com';
    process.env.TELEGRAM_BOT_TOKEN = '123:abc';
    process.env.TELEGRAM_CHAT_ID = '999';
  });

  afterEach(() => {
    delete process.env.GATEKEEPER_ENABLED;
    delete process.env.SWARMSYNC_ENABLED;
    delete process.env.QBO_FORWARDING_ADDRESS;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    resetConfigCache();
  });

  afterAll(closeAll);

  it('optional policy (default) + SwarmSync off -> noop, no hold, no forward (rule 1)', async () => {
    const t = await createTenant();
    await createConnection(t, { provider: 'qbo', externalCompany: 'sandbox-realm' }); // metadata has no swarmSyncPolicy -> optional
    const m = await insertMessage(t);
    await insertAttachment(t, m);

    const out = await gatekeepHandler({ data: { tenantId: t, messageId: m } });
    expect(out).toEqual({ action: 'noop' });
    expect(await countRows('forwards', 'tenant_id=$1', [t])).toBe(0);
  });

  it('required policy + SwarmSync off -> holds via the scan-unavailable path, raises proof_scan_unavailable (rule 2)', async () => {
    const t = await createTenant();
    await createConnection(t, { provider: 'qbo', externalCompany: 'sandbox-realm' });
    await setPolicy(t, 'required');
    const m = await insertMessage(t);
    await insertAttachment(t, m);

    const out = await gatekeepHandler({ data: { tenantId: t, messageId: m } });
    expect(out.action).toBe('held');
    expect(out.reason).toBe('proof_scan_unavailable');
    expect(await countRows('exceptions', "tenant_id=$1 AND reason_code='proof_scan_unavailable'", [t])).toBe(1);
  });
});
