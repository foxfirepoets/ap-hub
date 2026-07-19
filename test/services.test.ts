import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { query } from '../src/db/pool.js';
import { recordProofRef } from '../src/swarmsync/proof.js';
import { AuthError } from '../src/auth/guard.js';
import { approveProposal } from '../src/services/approve.js';
import { rejectProposal, retryProposal } from '../src/services/proposals.js';
import { remapMapping, learnCorrection } from '../src/services/mappings.js';
import { sendReply } from '../src/services/reply.js';
import type { ActorContext } from '../src/services/index.js';
import { mockConnector } from './connector-mock.js';
import type { AccountingConnector } from '../src/connectors/types.js';
import type { PostDeps } from '../src/pipeline/posting.js';
import type { LockedForwarder } from '../src/gatekeeper/forwarder.js';
import {
  resetTables, createTenant, createUser, insertMessage, insertAttachment, insertExtraction, countRows, closeAll,
} from './helpers.js';

const mockWriter = mockConnector;
const okAnchor = vi.fn().mockResolvedValue({ proof_id: 'ap1', chain_hash: 'ch1', verification_status: 'passed', confidence: 1, raw: {} });
const postDeps = (writer: AccountingConnector): PostDeps => ({ connector: writer, anchor: okAnchor, loadPdf: async () => Buffer.from('%PDF'), amountCeiling: 10000, autoThreshold: 0.9 });

/** Seed a fully-proofed, ready-to-post proposal. Omit proofs to model a SwarmSync outage. */
async function seedReadyProposal(t: number, opts: { withProofs?: boolean } = {}): Promise<number> {
  const withProofs = opts.withProofs ?? true;
  const m = await insertMessage(t);
  const a = await insertAttachment(t, m, { sha256: `sha-${t}-${Math.floor(performance.now() * 1000)}` });
  const sha = (await query<{ sha256: string }>('SELECT sha256 FROM attachments WHERE id=$1', [a])).rows[0]!.sha256;
  const e = await insertExtraction(t, m, a, {}, 0.95);
  if (withProofs) await recordProofRef({ tenantId: t, entityKind: 'extraction', entityId: String(e), product: 'verify_api', proofId: 'p', chainHash: 'h' });
  const txn = { txnType: 'Bill', vendorRef: { value: 'V1', name: 'Acme' }, DocNumber: 'INV-1', TxnDate: '2026-07-01', TotalAmt: 100, lines: [{ Amount: 100, description: 'work', accountRef: { value: '60' } }], tax: 0 };
  const pid = (
    await query<{ id: number }>(
      `INSERT INTO proposals (tenant_id, attachment_id, extraction_id, proposed_txn, idempotency_key, confidence, status, flags)
       VALUES ($1,$2,$3,$4,$5,0.95,'ready','{}') RETURNING id`,
      [t, a, e, JSON.stringify(txn), sha],
    )
  ).rows[0]!.id;
  if (withProofs) await recordProofRef({ tenantId: t, entityKind: 'proposal', entityId: String(pid), product: 'invoiceproof', verdict: 'clean' });
  return pid;
}

async function owner(t: number): Promise<ActorContext> {
  const uid = await createUser(t, { role: 'owner_controller', email: 'owner@example.com' });
  return { userId: uid, tenantId: t, role: 'owner_controller', email: 'owner@example.com' };
}
async function cpa(t: number): Promise<ActorContext> {
  const uid = await createUser(t, { role: 'cpa', email: 'cpa@example.com' });
  return { userId: uid, tenantId: t, role: 'cpa', email: 'cpa@example.com' };
}

const humanAudit = (t: number, action: string) =>
  countRows('audit_log', "tenant_id=$1 AND action=$2 AND actor<>'system'", [t, action]);

describe('CHUNK_2 services — approve', () => {
  beforeEach(resetTables);
  afterAll(closeAll);

  it('happy path: one sandbox posting via write.ts + one human audit row', async () => {
    const t = await createTenant();
    const ctx = await owner(t);
    const pid = await seedReadyProposal(t);
    const w = mockWriter();
    const res = await approveProposal(ctx, pid, postDeps(w));
    expect(res.status).toBe('posted');
    expect(w.postBill).toHaveBeenCalledTimes(1); // single QBO-write path
    expect(await countRows('postings', "status='posted_sandbox' AND mode='sandbox'")).toBe(1);
    expect(await humanAudit(t, 'proposal.approve')).toBe(1);
    if (res.status === 'posted') {
      expect(res.mode).toBe('sandbox');
      expect(res.qboLink).toContain('sandbox');
      expect(res.qboType).toBe('Bill');
    }
  });

  it('role gate: a CPA (read-only) cannot approve — 403, zero postings', async () => {
    const t = await createTenant();
    const ctx = await cpa(t);
    const pid = await seedReadyProposal(t);
    const w = mockWriter();
    await expect(approveProposal(ctx, pid, postDeps(w))).rejects.toBeInstanceOf(AuthError);
    expect(w.postBill).not.toHaveBeenCalled();
    expect(await countRows('postings')).toBe(0);
  });

  it('fail-safe: missing proof coverage (SwarmSync outage) → held, never fail-open', async () => {
    const t = await createTenant();
    const ctx = await owner(t);
    const pid = await seedReadyProposal(t, { withProofs: false });
    const w = mockWriter();
    const res = await approveProposal(ctx, pid, postDeps(w));
    expect(res.status).toBe('held');
    expect(w.postBill).not.toHaveBeenCalled();
    expect(await countRows('postings')).toBe(0);
  });

  it('retry re-posts idempotently via the same key — no second txn', async () => {
    const t = await createTenant();
    const ctx = await owner(t);
    const pid = await seedReadyProposal(t);
    const w = mockWriter();
    await approveProposal(ctx, pid, postDeps(w));
    // Re-posting an already-posted proposal is refused by the status gate — no second txn.
    const again = await retryProposal(ctx, pid, postDeps(w));
    expect(again.status).toBe('held');
    expect(w.postBill).toHaveBeenCalledTimes(1);
    expect(await countRows('postings')).toBe(1);
    expect(await humanAudit(t, 'proposal.retry')).toBe(1);
  });
});

describe('CHUNK_2 services — reject / remap / learn', () => {
  beforeEach(resetTables);
  afterAll(closeAll);

  it('reject marks the proposal rejected + records a duplicate exception when asked', async () => {
    const t = await createTenant();
    const ctx = await owner(t);
    const pid = await seedReadyProposal(t);
    const res = await rejectProposal(ctx, pid, { reason: 'not ours', markDuplicate: true });
    expect(res.status).toBe('rejected');
    expect(await countRows('proposals', "id=$1 AND status='rejected'", [pid])).toBe(1);
    expect(await countRows('exceptions', "reason_code='duplicate' AND entity_ref=$1", [`proposal:${pid}`])).toBe(1);
    expect(await humanAudit(t, 'proposal.reject')).toBe(1);
  });

  it('remap upserts a reusable mapping rule + audit', async () => {
    const t = await createTenant();
    const ctx = await owner(t);
    const res = await remapMapping(ctx, { kind: 'vendor', sourceKey: 'acme', targetQboId: 'V9', targetName: 'Acme Inc', remember: true });
    expect(res.becameRule).toBe(true);
    expect(await countRows('mappings', "kind='vendor' AND source_key='acme' AND target_qbo_id='V9'")).toBe(1);
    expect(await humanAudit(t, 'mapping.remap')).toBe(1);
  });

  it('learn with remember writes correction.became_rule + upserts the mapping', async () => {
    const t = await createTenant();
    const ctx = await owner(t);
    const pid = await seedReadyProposal(t);
    const res = await learnCorrection(ctx, {
      proposalId: pid, field: 'vendor', newValue: 'Acme Inc', remember: true,
      mapping: { kind: 'vendor', sourceKey: 'acme', targetQboId: 'V9', targetName: 'Acme Inc' },
    });
    expect(res.becameRule).toBe(true);
    expect(res.ruleApplied).toBe(true);
    expect(await countRows('corrections', 'proposal_id=$1 AND became_rule=true', [pid])).toBe(1);
    expect(await countRows('mappings', "kind='vendor' AND source_key='acme'")).toBe(1);
  });

  it('cross-tenant guard: learn on another tenant\'s proposal is refused', async () => {
    const tA = await createTenant('A');
    const tB = await createTenant('B');
    const ctxB = await owner(tB);
    const pidA = await seedReadyProposal(tA);
    await expect(
      learnCorrection(ctxB, { proposalId: pidA, field: 'vendor', newValue: 'x', remember: false }),
    ).rejects.toThrow();
    expect(await countRows('corrections')).toBe(0);
  });
});

describe('CHUNK_2 services — reply send-lockdown', () => {
  beforeEach(resetTables);
  afterAll(closeAll);

  async function seedHeldForward(t: number, gmailId = 'gm-held'): Promise<number> {
    const m = await insertMessage(t, { gmailId });
    const { rows } = await query<{ id: number }>(
      `INSERT INTO forwards (tenant_id, message_id, attachment_id, sha256, subject_tag, status)
       VALUES ($1,$2,NULL,$3,'tag','held') RETURNING id`,
      [t, m, `fsha-${t}`],
    );
    return rows[0]!.id;
  }

  it('sendReply forwards to the single locked address; no recipient is ever passed in', async () => {
    const t = await createTenant();
    const ctx = await owner(t);
    const fid = await seedHeldForward(t, 'gm-abc');
    const LOCKED = 'capture@qbo.example.com';
    const forward = vi.fn().mockResolvedValue({ sendId: 's1', to: LOCKED });
    const forwarder: LockedForwarder = { recipient: LOCKED, forward };
    const res = await sendReply(ctx, fid, { forwarder, resolveGmailMessageId: async () => 'gm-abc' });
    expect(res.to).toBe(LOCKED);
    // The forwarder receives ONLY a messageId — no recipient argument exists.
    expect(forward).toHaveBeenCalledWith('gm-abc');
    expect(await countRows('forwards', "id=$1 AND status='forwarded'", [fid])).toBe(1);
    expect(await humanAudit(t, 'reply.send')).toBe(1);
  });
});

describe('CHUNK_2 services — single code path (CLI ↔ services)', () => {
  it('the CLI delegates to the shared service modules (no parallel path)', () => {
    const cliSrc = readFileSync(fileURLToPath(new URL('../src/cli.ts', import.meta.url)), 'utf8');
    expect(cliSrc).toContain('./services/reply.js');
    expect(cliSrc).toContain('./services/mappings.js');
    // The CLI must NOT re-implement the send path inline.
    expect(cliSrc).not.toContain("action: 'gatekeep.release'");
  });
});
