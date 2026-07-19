import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { query } from '../src/db/pool.js';
import { recordProofRef } from '../src/swarmsync/proof.js';
import { createSession } from '../src/auth/session.js';
import { mockConnector } from './connector-mock.js';
import type { AccountingConnector } from '../src/connectors/types.js';
import type { PostDeps } from '../src/pipeline/posting.js';
import type { DryRunDeps } from '../src/services/onboarding.js';
import { advanceOnboardingStep } from '../src/services/onboarding.js';
import {
  runOnboardingGet,
  runOnboardingStep,
  runOnboardingDryRunAction,
  runApprove,
  runLearn,
} from '../src/services/action/index.js';
import {
  resetTables, createTenant, createUser, insertMessage, insertAttachment, insertExtraction, countRows, closeAll,
} from './helpers.js';

/**
 * CHUNK_6_ONBOARDING — the first-run wizard: state persistence, discovery + setup
 * blockers, the propose-only dry-run scan, the DRY_RUN_LOCKED guard on posting, and
 * "approve initial rules" via the existing CHUNK_2 `learnCorrection` service path.
 */

const mockWriter = mockConnector;
const okAnchor = vi.fn().mockResolvedValue({ proof_id: 'ap1', chain_hash: 'ch1', verification_status: 'passed', confidence: 1, raw: {} });
const postDeps = (writer: AccountingConnector): PostDeps => ({ connector: writer, anchor: okAnchor, loadPdf: async () => Buffer.from('%PDF'), amountCeiling: 10000, autoThreshold: 0.9 });
const cleanScan: DryRunDeps = { scan: async () => ({ findings: [], raw: {} }) };

async function seedVendorAndAccount(t: number) {
  await query(
    `INSERT INTO mappings (tenant_id, kind, source_key, target_qbo_id, target_name)
     VALUES ($1,'vendor','acme','V1','Acme'), ($1,'account','work','60','Subcontractors')`,
    [t],
  );
}

async function seedUnproposedExtraction(t: number, opts: { withProofs?: boolean } = {}) {
  const withProofs = opts.withProofs ?? true;
  const m = await insertMessage(t);
  const a = await insertAttachment(t, m);
  const e = await insertExtraction(t, m, a, {}, 0.95);
  if (withProofs) await recordProofRef({ tenantId: t, entityKind: 'extraction', entityId: String(e), product: 'verify_api', proofId: 'p', chainHash: 'h' });
  return { m, a, e };
}

async function tokenFor(t: number, role: string, email: string): Promise<string> {
  const uid = await createUser(t, { role, email });
  return (await createSession(uid)).token;
}
const ownerToken = (t: number) => tokenFor(t, 'owner_controller', 'owner@example.com');
const bookkeeperToken = (t: number) => tokenFor(t, 'bookkeeper', 'book@example.com');

function req(method: 'GET' | 'POST', token: string | null, body?: unknown): Request {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (method === 'POST') headers['content-type'] = 'application/json';
  return new Request('http://localhost/api/onboarding', {
    method,
    headers,
    body: method === 'POST' ? (body === undefined ? undefined : JSON.stringify(body)) : undefined,
  });
}

describe('CHUNK_6 onboarding — state + discovery', () => {
  beforeEach(resetTables);
  afterAll(closeAll);

  it('GET with no prior row → default state, blockers for unconnected Gmail + QBO', async () => {
    const t = await createTenant();
    const token = await ownerToken(t);
    const res = await runOnboardingGet(req('GET', token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { step: string; automationLevel: string; dryRunComplete: boolean; blockers: { code: string }[] } };
    expect(body.data.step).toBe('connect_gmail');
    expect(body.data.automationLevel).toBe('off');
    expect(body.data.dryRunComplete).toBe(false);
    const codes = body.data.blockers.map((b) => b.code);
    expect(codes).toContain('gmail_not_connected');
    expect(codes).toContain('qbo_not_connected');
  });

  it('no session → 401 UNAUTHENTICATED', async () => {
    const res = await runOnboardingGet(req('GET', null));
    expect(res.status).toBe(401);
  });

  it('connected Gmail + QBO clears their blockers', async () => {
    const t = await createTenant();
    const token = await ownerToken(t);
    await query(
      `INSERT INTO oauth_tokens (tenant_id, provider, access_token_enc, refresh_token_enc, scope, realm)
       VALUES ($1,'gmail','enc','enc','https://www.googleapis.com/auth/gmail.readonly',NULL),
              ($1,'qbo','enc','enc',NULL,'realm-123')`,
      [t],
    );
    const res = await runOnboardingGet(req('GET', token));
    const body = (await res.json()) as { data: { blockers: { code: string }[] } };
    const codes = body.data.blockers.map((b) => b.code);
    expect(codes).not.toContain('gmail_not_connected');
    expect(codes).not.toContain('gmail_scope_denied');
    expect(codes).not.toContain('qbo_not_connected');
    expect(codes).not.toContain('qbo_company_unselected');
  });
});

describe('CHUNK_6 onboarding — step persistence', () => {
  beforeEach(resetTables);
  afterAll(closeAll);

  it('POST step persists progress in onboarding_state', async () => {
    const t = await createTenant();
    const token = await ownerToken(t);
    const res = await runOnboardingStep(req('POST', token, { step: 'connect_qbo' }));
    expect(res.status).toBe(200);
    expect(await countRows('onboarding_state', "tenant_id=$1 AND step='connect_qbo'", [t])).toBe(1);
  });

  it('unknown step → 400 VALIDATION', async () => {
    const t = await createTenant();
    const token = await ownerToken(t);
    const res = await runOnboardingStep(req('POST', token, { step: 'not_a_step' }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('VALIDATION');
  });

  it('bookkeeper cannot advance onboarding → 403', async () => {
    const t = await createTenant();
    const token = await bookkeeperToken(t);
    const res = await runOnboardingStep(req('POST', token, { step: 'connect_qbo' }));
    expect(res.status).toBe(403);
  });
});

describe('CHUNK_6 onboarding — dry-run scan', () => {
  beforeEach(resetTables);
  afterAll(closeAll);

  it('produces ≥1 proposals row, exactly 0 postings, and a business-specific summary', async () => {
    const t = await createTenant();
    const token = await ownerToken(t);
    await seedVendorAndAccount(t);
    await seedUnproposedExtraction(t);
    await seedUnproposedExtraction(t);

    const res = await runOnboardingDryRunAction(req('POST', token, {}), cleanScan);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { emailsScanned: number; invoicesFound: number; vendorsMatched: number; proposalsCreated: number } };
    expect(body.data.proposalsCreated).toBeGreaterThanOrEqual(1);
    expect(body.data.emailsScanned).toBeGreaterThanOrEqual(2);
    expect(body.data.invoicesFound).toBeGreaterThanOrEqual(1);

    expect(await countRows('proposals', 'tenant_id=$1', [t])).toBeGreaterThanOrEqual(1);
    expect(await countRows('postings', 'tenant_id=$1', [t])).toBe(0); // NEVER posts (guarantee 1)
    expect(await countRows('onboarding_state', 'tenant_id=$1 AND dry_run_complete=true', [t])).toBe(1);
  });

  it('bookkeeper cannot trigger a dry-run → 403', async () => {
    const t = await createTenant();
    const token = await bookkeeperToken(t);
    const res = await runOnboardingDryRunAction(req('POST', token, {}), cleanScan);
    expect(res.status).toBe(403);
  });
});

describe('CHUNK_6 onboarding — DRY_RUN_LOCKED guard', () => {
  beforeEach(resetTables);
  afterAll(closeAll);

  it('post attempt during setup (automation_level still off) → 403 DRY_RUN_LOCKED, zero postings', async () => {
    const t = await createTenant();
    const token = await ownerToken(t);
    await seedVendorAndAccount(t);
    const { a, e } = await seedUnproposedExtraction(t);
    // Start onboarding (row exists, automation_level defaults to 'off').
    await runOnboardingStep(req('POST', token, { step: 'connect_qbo' }));

    const txn = { txnType: 'Bill', vendorRef: { value: 'V1', name: 'Acme' }, DocNumber: 'INV-1', TxnDate: '2026-07-01', TotalAmt: 100, lines: [{ Amount: 100, description: 'work', accountRef: { value: '60' } }], tax: 0 };
    const sha = (await query<{ sha256: string }>('SELECT sha256 FROM attachments WHERE id=$1', [a])).rows[0]!.sha256;
    const pid = (
      await query<{ id: number }>(
        `INSERT INTO proposals (tenant_id, attachment_id, extraction_id, proposed_txn, idempotency_key, confidence, status, flags)
         VALUES ($1,$2,$3,$4,$5,0.95,'ready','{}') RETURNING id`,
        [t, a, e, JSON.stringify(txn), sha],
      )
    ).rows[0]!.id;
    await recordProofRef({ tenantId: t, entityKind: 'proposal', entityId: String(pid), product: 'invoiceproof', verdict: 'clean' });

    const w = mockWriter();
    const res = await runApprove(req('POST', token, {}), pid, postDeps(w));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('DRY_RUN_LOCKED');
    expect(w.postBill).not.toHaveBeenCalled();
    expect(await countRows('postings', 'tenant_id=$1', [t])).toBe(0);
  });

  it('a tenant that never touched onboarding is NOT locked (backward compatible)', async () => {
    const t = await createTenant();
    const token = await ownerToken(t);
    await seedVendorAndAccount(t);
    const { a, e } = await seedUnproposedExtraction(t);
    const txn = { txnType: 'Bill', vendorRef: { value: 'V1', name: 'Acme' }, DocNumber: 'INV-1', TxnDate: '2026-07-01', TotalAmt: 100, lines: [{ Amount: 100, description: 'work', accountRef: { value: '60' } }], tax: 0 };
    const sha = (await query<{ sha256: string }>('SELECT sha256 FROM attachments WHERE id=$1', [a])).rows[0]!.sha256;
    const pid = (
      await query<{ id: number }>(
        `INSERT INTO proposals (tenant_id, attachment_id, extraction_id, proposed_txn, idempotency_key, confidence, status, flags)
         VALUES ($1,$2,$3,$4,$5,0.95,'ready','{}') RETURNING id`,
        [t, a, e, JSON.stringify(txn), sha],
      )
    ).rows[0]!.id;
    await recordProofRef({ tenantId: t, entityKind: 'proposal', entityId: String(pid), product: 'invoiceproof', verdict: 'clean' });

    const w = mockWriter();
    const res = await runApprove(req('POST', token, {}), pid, postDeps(w));
    expect(res.status).toBe(201);
    expect(await countRows('postings', 'tenant_id=$1', [t])).toBe(1);
  });

  it('full wizard: dry-run leaves 0 postings; enabling automation unlocks approve → exactly 1 posting', async () => {
    const t = await createTenant();
    const token = await ownerToken(t);
    await seedVendorAndAccount(t);
    await seedUnproposedExtraction(t);

    await runOnboardingStep(req('POST', token, { step: 'connect_gmail' }));
    await runOnboardingStep(req('POST', token, { step: 'connect_qbo' }));
    await runOnboardingStep(req('POST', token, { step: 'select_company' }));
    await runOnboardingStep(req('POST', token, { step: 'configure_mode' }));

    const dryRunRes = await runOnboardingDryRunAction(req('POST', token, {}), cleanScan);
    expect(dryRunRes.status).toBe(201);
    expect(await countRows('postings', 'tenant_id=$1', [t])).toBe(0);

    const readyPid = (await query<{ id: number }>("SELECT id FROM proposals WHERE tenant_id=$1 AND status='ready' LIMIT 1", [t])).rows[0]?.id;
    expect(readyPid).toBeDefined();

    // Still locked — automation_level is still 'off'.
    const lockedRes = await runApprove(req('POST', token, {}), readyPid!, postDeps(mockWriter()));
    expect(lockedRes.status).toBe(403);
    expect(await countRows('postings', 'tenant_id=$1', [t])).toBe(0);

    // Approve initial rules via the CHUNK_2 service path (learnCorrection), then enable automation.
    const learnRes = await runLearn(req('POST', token, {
      proposalId: readyPid, field: 'vendor', newValue: 'Acme Inc', remember: true,
      mapping: { kind: 'vendor', sourceKey: 'acme', targetQboType: 'Vendor', targetQboId: 'V1', targetName: 'Acme Inc' },
    }));
    expect(learnRes.status).toBe(200);
    expect(await countRows('corrections', 'proposal_id=$1 AND became_rule=true', [readyPid])).toBe(1);

    const enableRes = await runOnboardingStep(req('POST', token, { step: 'complete', automationLevel: 'assisted' }));
    expect(enableRes.status).toBe(200);
    expect(((await enableRes.json()) as { data: { automationLevel: string } }).data.automationLevel).toBe('assisted');

    const unlockedRes = await runApprove(req('POST', token, {}), readyPid!, postDeps(mockWriter()));
    expect(unlockedRes.status).toBe(201);
    expect(await countRows('postings', 'tenant_id=$1', [t])).toBe(1);
  });

  // FIX-F1: regression for the release-blocker — `automation_level` had no human-usable
  // caller, so `assertNotDryRunLocked` always threw and every Approve returned 403. This
  // proves the new operator CLI path (`ap-hub set-automation --tenant <id> --level <level>`,
  // src/cli.ts) — which calls `advanceOnboardingStep` directly, no HTTP layer — actually
  // unlocks `runApprove` for BOTH non-off levels the CLI/Settings UI accept.
  it.each(['assisted', 'auto'] as const)(
    'operator CLI path (advanceOnboardingStep direct call): automation_level=%s unlocks approveProposal',
    async (level) => {
      const t = await createTenant();
      const token = await ownerToken(t);
      await seedVendorAndAccount(t);
      const { a, e } = await seedUnproposedExtraction(t);
      // Touch onboarding so the DRY_RUN_LOCKED guard applies (row exists, automation_level 'off').
      await runOnboardingStep(req('POST', token, { step: 'connect_qbo' }));

      const txn = { txnType: 'Bill', vendorRef: { value: 'V1', name: 'Acme' }, DocNumber: 'INV-1', TxnDate: '2026-07-01', TotalAmt: 100, lines: [{ Amount: 100, description: 'work', accountRef: { value: '60' } }], tax: 0 };
      const sha = (await query<{ sha256: string }>('SELECT sha256 FROM attachments WHERE id=$1', [a])).rows[0]!.sha256;
      const pid = (
        await query<{ id: number }>(
          `INSERT INTO proposals (tenant_id, attachment_id, extraction_id, proposed_txn, idempotency_key, confidence, status, flags)
           VALUES ($1,$2,$3,$4,$5,0.95,'ready','{}') RETURNING id`,
          [t, a, e, JSON.stringify(txn), sha],
        )
      ).rows[0]!.id;
      await recordProofRef({ tenantId: t, entityKind: 'proposal', entityId: String(pid), product: 'invoiceproof', verdict: 'clean' });

      // Locked before the operator sets automation_level (the bug being fixed).
      const before = await runApprove(req('POST', token, {}), pid, postDeps(mockWriter()));
      expect(before.status).toBe(403);
      expect(((await before.json()) as { error: { code: string } }).error.code).toBe('DRY_RUN_LOCKED');
      expect(await countRows('postings', 'tenant_id=$1', [t])).toBe(0);

      const row = await advanceOnboardingStep(
        { userId: 0, tenantId: t, role: 'owner_controller', actor: 'cli:set-automation' },
        { automationLevel: level },
      );
      expect(row.automationLevel).toBe(level);

      const after = await runApprove(req('POST', token, {}), pid, postDeps(mockWriter()));
      expect(after.status).toBe(201);
      expect(await countRows('postings', 'tenant_id=$1', [t])).toBe(1);
    },
  );
});
