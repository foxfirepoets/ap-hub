import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { query } from '../src/db/pool.js';
import { createSession, SESSION_COOKIE_NAME, signSessionValue } from '../src/auth/session.js';
import {
  getToday,
  getTodayCounts,
  listExceptions,
  getExceptionById,
  listTransactions,
  getTransactionById,
  getEvidence,
  listAudit,
  runRead,
} from '../src/services/read/index.js';
import {
  resetTables,
  createTenant,
  createUser,
  insertMessage,
  insertAttachment,
  insertExtraction,
  countRows,
  closeAll,
} from './helpers.js';

// --- local seed helpers (read layer owns no writers; we seed rows directly) --------------

async function insertProposal(
  tenantId: number,
  opts: {
    attachmentId?: number | null;
    extractionId?: number | null;
    status?: string;
    txn?: Record<string, unknown>;
    idempotencyKey?: string;
    confidence?: number;
  } = {},
): Promise<number> {
  const txn =
    opts.txn ??
    ({ txnType: 'Bill', vendorRef: { value: 'V1', name: 'Acme' }, DocNumber: 'INV-1', TxnDate: '2026-07-01', TotalAmt: 100 } as Record<string, unknown>);
  const { rows } = await query<{ id: number }>(
    `INSERT INTO proposals (tenant_id, attachment_id, extraction_id, proposed_txn, idempotency_key, confidence, status, flags)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'{}') RETURNING id`,
    [
      tenantId,
      opts.attachmentId ?? null,
      opts.extractionId ?? null,
      JSON.stringify(txn),
      opts.idempotencyKey ?? `key-${Math.floor(performance.now() * 1000)}`,
      opts.confidence ?? 0.95,
      opts.status ?? 'ready',
    ],
  );
  return rows[0]!.id;
}

async function insertPosting(
  tenantId: number,
  proposalId: number,
  attachmentId: number | null,
  opts: { qboType?: string; qboId?: string; realm?: string; status?: string; key?: string } = {},
): Promise<number> {
  const { rows } = await query<{ id: number }>(
    `INSERT INTO postings (tenant_id, attachment_id, proposal_id, qbo_type, qbo_id, sync_token, realm, mode, idempotency_key, status, posted_at)
     VALUES ($1,$2,$3,$4,$5,'0',$6,'sandbox',$7,$8, now()) RETURNING id`,
    [
      tenantId,
      attachmentId,
      proposalId,
      opts.qboType ?? 'Bill',
      opts.qboId ?? 'q1',
      opts.realm ?? 'sandbox-realm',
      opts.key ?? `pkey-${Math.floor(performance.now() * 1000)}`,
      opts.status ?? 'posted_sandbox',
    ],
  );
  return rows[0]!.id;
}

async function insertException(
  tenantId: number,
  opts: { reasonCode?: string; status?: string; entityRef?: string; detail?: string } = {},
): Promise<number> {
  const { rows } = await query<{ id: number }>(
    `INSERT INTO exceptions (tenant_id, entity_ref, reason_code, detail, status)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [tenantId, opts.entityRef ?? 'proposal:1', opts.reasonCode ?? 'total_mismatch', opts.detail ?? 'd', opts.status ?? 'open'],
  );
  return rows[0]!.id;
}

async function insertMapping(tenantId: number, sourceKey = 'acme'): Promise<number> {
  const { rows } = await query<{ id: number }>(
    `INSERT INTO mappings (tenant_id, kind, source_key, target_qbo_type, target_qbo_id, target_name, learned_from)
     VALUES ($1,'vendor',$2,'Vendor','V9','Acme Inc','human') RETURNING id`,
    [tenantId, sourceKey],
  );
  return rows[0]!.id;
}

async function insertProofRef(tenantId: number, entityKind: string, entityId: string, product: string): Promise<void> {
  await query(
    `INSERT INTO proof_refs (tenant_id, entity_kind, entity_id, product, proof_id, chain_hash, verdict)
     VALUES ($1,$2,$3,$4,'pf','ch','clean')`,
    [tenantId, entityKind, entityId, product],
  );
}

async function insertReconMatched(tenantId: number, proposalId: number): Promise<void> {
  await query(
    `INSERT INTO reconciliation (tenant_id, kind, left_ref, right_ref, match_status)
     VALUES ($1,'proposal_vs_created',$2,'qbo:q1','matched')`,
    [tenantId, `proposal:${proposalId}`],
  );
}

async function insertAudit(tenantId: number, action: string, actor = 'owner@example.com'): Promise<void> {
  await query(`INSERT INTO audit_log (tenant_id, actor, action, entity) VALUES ($1,$2,$3,'e')`, [tenantId, actor, action]);
}

function bearer(token: string): Request {
  return new Request('http://localhost/api/x', { headers: { authorization: `Bearer ${token}` } });
}

// -----------------------------------------------------------------------------------------

describe('CHUNK_3 read — today counts', () => {
  beforeEach(resetTables);
  afterAll(closeAll);

  it('counts equal the SELECT-derived counts on the tenant rows', async () => {
    const t = await createTenant();
    // held (review) x2, failed (exception) x1, ready x1
    await insertProposal(t, { status: 'review' });
    await insertProposal(t, { status: 'review' });
    await insertProposal(t, { status: 'exception' });
    const ready = await insertProposal(t, { status: 'ready' });
    // posted x1
    await insertPosting(t, ready, null);
    // open exceptions x2, resolved x1
    await insertException(t, { status: 'open' });
    await insertException(t, { status: 'open' });
    await insertException(t, { status: 'resolved' });

    const counts = await getTodayCounts(t);
    expect(counts.held).toBe(await countRows('proposals', "tenant_id=$1 AND status='review'", [t]));
    expect(counts.failed).toBe(await countRows('proposals', "tenant_id=$1 AND status='exception'", [t]));
    expect(counts.posted).toBe(await countRows('postings', "tenant_id=$1 AND status='posted_sandbox'", [t]));
    expect(counts.exceptions).toBe(await countRows('exceptions', "tenant_id=$1 AND status='open'", [t]));
    expect(counts).toEqual({ exceptions: 2, posted: 1, held: 2, failed: 1 });
  });

  it('items and counts are tenant-scoped — never another tenant\'s rows', async () => {
    const a = await createTenant('A');
    const b = await createTenant('B');
    const pa = await insertProposal(a, { status: 'review' });
    await insertProposal(b, { status: 'review' });
    await insertProposal(b, { status: 'review' });

    const today = await getToday(a);
    expect(today.counts.held).toBe(1);
    expect(today.items.map((i) => i.proposalId)).toEqual([pa]);
  });
});

describe('CHUNK_3 read — exceptions', () => {
  beforeEach(resetTables);
  afterAll(closeAll);

  it('filters by status and returns only tenant rows', async () => {
    const t = await createTenant();
    await insertException(t, { status: 'open', reasonCode: 'unknown_vendor' });
    await insertException(t, { status: 'resolved', reasonCode: 'duplicate' });
    const open = await listExceptions(t, { status: 'open' });
    expect(open).toHaveLength(1);
    expect(open[0]!.reasonCode).toBe('unknown_vendor');
    expect(await listExceptions(t)).toHaveLength(2);
  });

  it('cross-tenant getExceptionById returns null (404), never a foreign row', async () => {
    const a = await createTenant('A');
    const b = await createTenant('B');
    const exB = await insertException(b, { status: 'open' });
    expect(await getExceptionById(a, exB)).toBeNull();
    expect(await getExceptionById(b, exB)).not.toBeNull();
  });
});

describe('CHUNK_3 read — transactions', () => {
  beforeEach(resetTables);
  afterAll(closeAll);

  it('maps proposal status to UX status and attaches the QBO link + reconciled flag', async () => {
    const t = await createTenant();
    const prepared = await insertProposal(t, { status: 'ready' });
    const held = await insertProposal(t, { status: 'review' });
    const posted = await insertProposal(t, { status: 'posted_sandbox' });
    await insertPosting(t, posted, null, { qboType: 'Bill', qboId: 'q42', realm: 'realm-x' });
    const productionPosted = await insertProposal(t, { status: 'posted' });
    await insertPosting(t, productionPosted, null, {
      qboType: 'Bill',
      qboId: 'q-production',
      realm: 'realm-production',
      status: 'posted',
    });
    const reconciled = await insertProposal(t, { status: 'posted_sandbox' });
    await insertPosting(t, reconciled, null, { qboId: 'q43' });
    await insertReconMatched(t, reconciled);

    const list = await listTransactions(t);
    const byId = new Map(list.map((r) => [r.proposalId, r]));
    expect(byId.get(prepared)!.status).toBe('prepared');
    expect(byId.get(held)!.status).toBe('held');
    expect(byId.get(posted)!.status).toBe('posted');
    expect(byId.get(posted)!.qboLink).toContain('sandbox');
    expect(byId.get(posted)!.qboLink).toContain('q42');
    expect(byId.get(productionPosted)!.qboLink).toContain('https://app.qbo.intuit.com/');
    expect(byId.get(productionPosted)!.qboLink).not.toContain('sandbox');
    expect(byId.get(reconciled)!.status).toBe('reconciled');

    expect((await listTransactions(t, { status: 'posted' })).map((r) => r.proposalId)).toEqual([
      productionPosted,
      posted,
    ]);
  });

  it('cross-tenant getTransactionById returns null', async () => {
    const a = await createTenant('A');
    const b = await createTenant('B');
    const pb = await insertProposal(b, { status: 'ready' });
    expect(await getTransactionById(a, pb)).toBeNull();
    expect(await getTransactionById(b, pb)).not.toBeNull();
  });
});

describe('CHUNK_3 read — evidence', () => {
  beforeEach(resetTables);
  afterAll(closeAll);

  it('returns every present-in-DB field: email, attachment+sha256, fields, prior rule, proofs, QBO link', async () => {
    const t = await createTenant();
    const m = await insertMessage(t, { subject: 'Invoice 7', from: 'billing@acme.com' });
    const a = await insertAttachment(t, m, { sha256: 'sha-evidence-1', filename: 'inv7.pdf' });
    const e = await insertExtraction(t, m, a, { vendor_name: 'Acme' }, 0.91);
    await insertMapping(t, 'acme');
    const p = await insertProposal(t, { attachmentId: a, extractionId: e, status: 'posted_sandbox' });
    const posting = await insertPosting(t, p, a, { qboType: 'Bill', qboId: 'q7', realm: 'realm-7' });
    await insertProofRef(t, 'extraction', String(e), 'verify_api');
    await insertProofRef(t, 'proposal', String(p), 'invoiceproof');
    await insertProofRef(t, 'posting', String(posting), 'auditproof');

    const ev = await getEvidence(t, p);
    expect(ev).not.toBeNull();
    expect(ev!.missing).toEqual([]);
    expect(ev!.email!.subject).toBe('Invoice 7');
    expect(ev!.email!.from).toBe('billing@acme.com');
    expect(ev!.attachment!.sha256).toBe('sha-evidence-1');
    expect(ev!.attachment!.filename).toBe('inv7.pdf');
    expect(ev!.extraction!.confidence).toBeCloseTo(0.91, 3);
    expect(ev!.extraction!.fields.vendor_name).toBe('Acme');
    expect(ev!.priorRule!.targetQboId).toBe('V9');
    expect(ev!.proofs.map((x) => x.product).sort()).toEqual(['auditproof', 'invoiceproof', 'verify_api']);
    expect(ev!.posting!.qboId).toBe('q7');
    expect(ev!.qboLink).toContain('q7');
    expect(ev!.qboLink).toContain('sandbox');
  });

  it('uses the production QBO host for a production posting', async () => {
    const t = await createTenant();
    const p = await insertProposal(t, { status: 'posted' });
    await insertPosting(t, p, null, {
      qboType: 'Bill',
      qboId: 'q-production',
      realm: 'realm-production',
      status: 'posted',
    });

    const ev = await getEvidence(t, p);
    expect(ev!.qboLink).toContain('https://app.qbo.intuit.com/');
    expect(ev!.qboLink).not.toContain('sandbox');
  });

  it('missing attachment → "attachment" marker, other fields still returned', async () => {
    const t = await createTenant();
    const m = await insertMessage(t, { subject: 'Body-only invoice' });
    const e = await insertExtraction(t, m, null, { vendor_name: 'Acme' }, 0.8);
    const p = await insertProposal(t, { attachmentId: null, extractionId: e, status: 'review' });

    const ev = await getEvidence(t, p);
    expect(ev).not.toBeNull();
    expect(ev!.attachment).toBeNull();
    expect(ev!.missing).toContain('attachment');
    expect(ev!.email!.subject).toBe('Body-only invoice');
    expect(ev!.extraction!.fields.vendor_name).toBe('Acme');
  });

  it('cross-tenant evidence returns null (404)', async () => {
    const a = await createTenant('A');
    const b = await createTenant('B');
    const mB = await insertMessage(b);
    const aB = await insertAttachment(b, mB, { sha256: 'sha-b' });
    const eB = await insertExtraction(b, mB, aB, {}, 0.9);
    const pB = await insertProposal(b, { attachmentId: aB, extractionId: eB, status: 'ready' });
    expect(await getEvidence(a, pB)).toBeNull();
  });
});

describe('CHUNK_3 read — audit', () => {
  beforeEach(resetTables);
  afterAll(closeAll);

  it('lists tenant audit rows newest-first, scoped to the tenant', async () => {
    const a = await createTenant('A');
    const b = await createTenant('B');
    await insertAudit(a, 'proposal.approve');
    await insertAudit(a, 'proposal.reject');
    await insertAudit(b, 'proposal.approve');
    const rowsA = await listAudit(a);
    expect(rowsA).toHaveLength(2);
    expect(await listAudit(a, { action: 'proposal.approve' })).toHaveLength(1);
    expect((await listAudit(b)).every((r) => r.action === 'proposal.approve')).toBe(true);
  });
});

describe('CHUNK_3 read — runRead wrapper', () => {
  beforeEach(resetTables);
  afterAll(closeAll);

  it('no session → 401 UNAUTHENTICATED', async () => {
    const req = new Request('http://localhost/api/today');
    const res = await runRead(req, async () => ({ ok: true }));
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('UNAUTHENTICATED');
  });

  it('handler returning null → 404 NOT_FOUND; a value → 200 { data }', async () => {
    const t = await createTenant();
    const uid = await createUser(t, { email: 'owner@example.com', role: 'owner_controller' });
    const session = await createSession(uid);
    const req = bearer(session.token);

    const notFound = await runRead(req, async () => null);
    expect(notFound.status).toBe(404);
    expect(((await notFound.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND');

    const ok = await runRead(bearer(session.token), async (ctx) => ({ tenantId: ctx.tenantId }));
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { data: { tenantId: number } }).data.tenantId).toBe(t);
  });

  it('cookie-based session also resolves (end-to-end 404 for a foreign id)', async () => {
    const a = await createTenant('A');
    const b = await createTenant('B');
    const uid = await createUser(a, { email: 'a@example.com' });
    const session = await createSession(uid);
    const exB = await insertException(b, { status: 'open' });
    const req = new Request('http://localhost/api/exceptions/' + exB, {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${signSessionValue(session.token)}` },
    });
    const res = await runRead(req, (ctx) => getExceptionById(ctx.tenantId, exB));
    expect(res.status).toBe(404);
  });
});
