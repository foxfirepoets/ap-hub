import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { query } from '../src/db/pool.js';
import { recordProofRef } from '../src/swarmsync/proof.js';
import { createSession } from '../src/auth/session.js';
import { resolveVendor } from '../src/mapping/resolve.js';
import { mockConnector } from './connector-mock.js';
import type { AccountingConnector } from '../src/connectors/types.js';
import type { PostDeps } from '../src/pipeline/posting.js';
import type { LockedForwarder } from '../src/gatekeeper/forwarder.js';
import type { ReplyDeps } from '../src/services/reply.js';
import { runApprove, runReject, runRetry, runRemap, runLearn, runSendReply } from '../src/services/action/index.js';
import {
  resetTables, createTenant, createUser, insertMessage, insertAttachment, insertExtraction, countRows, closeAll,
} from './helpers.js';

/**
 * CHUNK_4_ACTION — the role-gated action routes exercised through the exported `run*`
 * functions (which the thin `app/api/**` handlers call verbatim). Deps are injected so
 * the QBO writer and the locked forwarder are mocked; the real guarded paths are never
 * touched. The six-guarantee suite (posting/lockdown/gatekeeper/etc.) runs alongside.
 */

const mockWriter = mockConnector;
const okAnchor = vi.fn().mockResolvedValue({ proof_id: 'ap1', chain_hash: 'ch1', verification_status: 'passed', confidence: 1, raw: {} });
const postDeps = (writer: AccountingConnector): PostDeps => ({ connector: writer, anchor: okAnchor, loadPdf: async () => Buffer.from('%PDF'), amountCeiling: 10000, autoThreshold: 0.9 });

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

async function seedHeldForward(t: number, gmailId = 'gm-held'): Promise<number> {
  const m = await insertMessage(t, { gmailId });
  const { rows } = await query<{ id: number }>(
    `INSERT INTO forwards (tenant_id, message_id, attachment_id, sha256, subject_tag, status)
     VALUES ($1,$2,NULL,$3,'tag','held') RETURNING id`,
    [t, m, `fsha-${t}`],
  );
  return rows[0]!.id;
}

async function tokenFor(t: number, role: string, email: string): Promise<string> {
  const uid = await createUser(t, { role, email });
  return (await createSession(uid)).token;
}
const ownerToken = (t: number) => tokenFor(t, 'owner_controller', 'owner@example.com');
const bookkeeperToken = (t: number) => tokenFor(t, 'bookkeeper', 'book@example.com');

function post(token: string | null, body?: unknown): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  return new Request('http://localhost/api/action', {
    method: 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const humanAudit = (t: number, action: string) =>
  countRows('audit_log', "tenant_id=$1 AND action=$2 AND actor<>'system'", [t, action]);

// -----------------------------------------------------------------------------------------

describe('CHUNK_4 action — approve', () => {
  beforeEach(resetTables);
  afterAll(closeAll);

  it('owner approve → 201, exactly one sandbox posting + one human audit row + QBO link', async () => {
    const t = await createTenant();
    const token = await ownerToken(t);
    const pid = await seedReadyProposal(t);
    const w = mockWriter();
    const res = await runApprove(post(token), pid, postDeps(w));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { posting_id: number; qbo_type: string; qbo_id: string; qbo_link: string; mode: string } };
    expect(body.data.mode).toBe('sandbox');
    expect(body.data.qbo_type).toBe('Bill');
    expect(body.data.qbo_link).toContain('sandbox');
    expect(w.postBill).toHaveBeenCalledTimes(1); // single QBO-write path
    expect(await countRows('postings', "tenant_id=$1 AND status='posted_sandbox' AND mode='sandbox'", [t])).toBe(1);
    expect(await humanAudit(t, 'proposal.approve')).toBe(1);
  });

  it('bookkeeper approve → 403 FORBIDDEN, zero postings, writer never called', async () => {
    const t = await createTenant();
    const token = await bookkeeperToken(t);
    const pid = await seedReadyProposal(t);
    const w = mockWriter();
    const res = await runApprove(post(token), pid, postDeps(w));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN');
    expect(w.postBill).not.toHaveBeenCalled();
    expect(await countRows('postings', 'tenant_id=$1', [t])).toBe(0);
  });

  it('no session → 401 UNAUTHENTICATED', async () => {
    const res = await runApprove(post(null), 1, postDeps(mockWriter()));
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('UNAUTHENTICATED');
  });

  it('concurrent double-approve → exactly one posting (guarantee 4: no double-post)', async () => {
    const t = await createTenant();
    const token = await ownerToken(t);
    const pid = await seedReadyProposal(t);
    const w = mockWriter();
    const [r1, r2] = await Promise.all([
      runApprove(post(token), pid, postDeps(w)),
      runApprove(post(token), pid, postDeps(w)),
    ]);
    expect(await countRows('postings', 'tenant_id=$1', [t])).toBe(1);
    const statuses = [r1.status, r2.status];
    expect(statuses.filter((s) => s === 201).length).toBeGreaterThanOrEqual(1);
    // The loser never creates a second posting: 201 (idempotent upsert), 409 ALREADY_POSTED,
    // or a safe 202 QBO_RETRY if the two writers contend on the same row. Never a 5xx.
    expect(statuses.every((s) => s === 201 || s === 409 || s === 202)).toBe(true);
  });

  it('QBO API ambiguity → 202, durable unknown evidence, and replay never creates again', async () => {
    const t = await createTenant();
    const token = await ownerToken(t);
    const pid = await seedReadyProposal(t);
    const w = mockWriter({ postBill: vi.fn().mockRejectedValue(new Error('boom')) });
    const res = await runApprove(post(token), pid, postDeps(w));
    expect(res.status).toBe(202);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('QBO_RETRY');
    expect(await countRows('postings', "tenant_id=$1 AND status='provider_result_unknown'", [t])).toBe(1);
    expect(await countRows('exceptions', "tenant_id=$1 AND reason_code='qbo_api_error'", [t])).toBe(1);
    const replay = await runApprove(post(token), pid, postDeps(w));
    expect(replay.status).toBe(202);
    expect(w.postBill).toHaveBeenCalledTimes(1);
    expect(await countRows('postings', "tenant_id=$1 AND status='provider_result_unknown'", [t])).toBe(1);
  });
});

describe('CHUNK_4 action — retry', () => {
  beforeEach(resetTables);
  afterAll(closeAll);

  it('owner retry after a successful post → 202 held, no second posting (idempotent)', async () => {
    const t = await createTenant();
    const token = await ownerToken(t);
    const pid = await seedReadyProposal(t);
    const w = mockWriter();
    await runApprove(post(token), pid, postDeps(w));
    const res = await runRetry(post(token), pid, postDeps(w));
    expect(res.status).toBe(202); // status gate: already posted → held
    expect(w.postBill).toHaveBeenCalledTimes(1);
    expect(await countRows('postings', 'tenant_id=$1', [t])).toBe(1);
    expect(await humanAudit(t, 'proposal.retry')).toBe(1);
  });
});

describe('CHUNK_4 action — reject', () => {
  beforeEach(resetTables);
  afterAll(closeAll);

  it('bookkeeper reject with markDuplicate → 200, proposal rejected + duplicate exception + audit', async () => {
    const t = await createTenant();
    const token = await bookkeeperToken(t);
    const pid = await seedReadyProposal(t);
    const res = await runReject(post(token, { reason: 'not ours', markDuplicate: true }), pid);
    expect(res.status).toBe(200);
    expect(await countRows('proposals', "id=$1 AND status='rejected'", [pid])).toBe(1);
    expect(await countRows('exceptions', "reason_code='duplicate' AND entity_ref=$1", [`proposal:${pid}`])).toBe(1);
    expect(await humanAudit(t, 'proposal.reject')).toBe(1);
  });

  it('reject without a reason → 400 VALIDATION', async () => {
    const t = await createTenant();
    const token = await ownerToken(t);
    const pid = await seedReadyProposal(t);
    const res = await runReject(post(token, {}), pid);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('VALIDATION');
  });
});

describe('CHUNK_4 action — remap / learn', () => {
  beforeEach(resetTables);
  afterAll(closeAll);

  it('remap → 200 became_rule + a reusable mapping the resolver reads next', async () => {
    const t = await createTenant();
    const token = await bookkeeperToken(t);
    const res = await runRemap(post(token, { kind: 'vendor', sourceKey: 'acme', targetQboType: 'Vendor', targetQboId: 'V9', targetName: 'Acme Inc', remember: true }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { became_rule: boolean } }).data.became_rule).toBe(true);
    expect(await countRows('mappings', "tenant_id=$1 AND kind='vendor' AND source_key='acme' AND target_qbo_id='V9'", [t])).toBe(1);
    expect(await humanAudit(t, 'mapping.remap')).toBe(1);
  });

  it('remap without kind/sourceKey → 400 VALIDATION', async () => {
    const t = await createTenant();
    const token = await ownerToken(t);
    const res = await runRemap(post(token, { kind: 'vendor' }));
    expect(res.status).toBe(400);
  });

  it('learn with remember → correction.became_rule + mapping applied to the next matching item', async () => {
    const t = await createTenant();
    const token = await ownerToken(t);
    const pid = await seedReadyProposal(t);
    const res = await runLearn(post(token, {
      proposalId: pid, field: 'vendor', newValue: 'Acme Inc', remember: true,
      mapping: { kind: 'vendor', sourceKey: 'acme', targetQboType: 'Vendor', targetQboId: 'V9', targetName: 'Acme Inc' },
    }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { became_rule: boolean; rule_applied: boolean } };
    expect(body.data.became_rule).toBe(true);
    expect(body.data.rule_applied).toBe(true);
    expect(await countRows('corrections', 'proposal_id=$1 AND became_rule=true', [pid])).toBe(1);

    // Prove the learned rule is applied to the NEXT matching item: feed the mappings row
    // to the real resolver as a candidate — it resolves the same vendor to V9 (exact).
    const cand = await query<{ source_key: string; target_qbo_id: string; target_name: string }>(
      "SELECT source_key, target_qbo_id, target_name FROM mappings WHERE tenant_id=$1 AND kind='vendor'", [t],
    );
    const candidates = cand.rows.map((r) => ({ sourceKey: r.source_key, targetId: r.target_qbo_id, targetName: r.target_name }));
    const resolution = resolveVendor('Acme', null, candidates);
    expect(resolution).toMatchObject({ status: 'exact', targetId: 'V9' });
  });
});

describe('CHUNK_4 action — reply send-lockdown (guarantee 2)', () => {
  beforeEach(resetTables);
  afterAll(closeAll);

  it('a recipient field in the body → 400 VALIDATION, forwarder never invoked', async () => {
    const t = await createTenant();
    const token = await ownerToken(t);
    const fid = await seedHeldForward(t, 'gm-1');
    const forward = vi.fn();
    const deps: ReplyDeps = { forwarder: { recipient: 'locked@x', forward } as unknown as LockedForwarder, resolveGmailMessageId: async () => 'gm-1' };
    const res = await runSendReply(post(token, { to: 'evil@example.com' }), fid, deps);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('VALIDATION');
    expect(forward).not.toHaveBeenCalled();
    expect(await countRows('forwards', "id=$1 AND status='held'", [fid])).toBe(1);
  });

  it('no recipient field → invokes the locked forwarder with the messageId only', async () => {
    const t = await createTenant();
    const token = await ownerToken(t);
    const fid = await seedHeldForward(t, 'gm-2');
    const LOCKED = 'capture@qbo.example.com';
    const forward = vi.fn().mockResolvedValue({ sendId: 's1', to: LOCKED });
    const deps: ReplyDeps = { forwarder: { recipient: LOCKED, forward } as unknown as LockedForwarder, resolveGmailMessageId: async () => 'gm-2' };
    const res = await runSendReply(post(token, {}), fid, deps);
    expect(res.status).toBe(200);
    expect(forward).toHaveBeenCalledWith('gm-2'); // only WHICH, never WHERE
    expect(((await res.json()) as { data: { to: string } }).data.to).toBe(LOCKED);
    expect(await countRows('forwards', "id=$1 AND status='forwarded'", [fid])).toBe(1);
    expect(await humanAudit(t, 'reply.send')).toBe(1);
  });

  it('bookkeeper reply-send → 403 (only owner_controller may release a forward)', async () => {
    const t = await createTenant();
    const token = await bookkeeperToken(t);
    const fid = await seedHeldForward(t, 'gm-3');
    const forward = vi.fn();
    const deps: ReplyDeps = { forwarder: { recipient: 'locked@x', forward } as unknown as LockedForwarder, resolveGmailMessageId: async () => 'gm-3' };
    const res = await runSendReply(post(token, {}), fid, deps);
    expect(res.status).toBe(403);
    expect(forward).not.toHaveBeenCalled();
  });
});
