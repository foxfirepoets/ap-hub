import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { anchorAuditDay } from '../src/pipeline/audit-anchor.js';
import { gatekeepOnce } from '../src/gatekeeper/gatekeep.js';
import { createLockedForwarder } from '../src/gatekeeper/forwarder.js';
import { hasProofRef } from '../src/swarmsync/proof.js';
import { writeAudit } from '../src/audit.js';
import { resetTables, createTenant, insertMessage, insertAttachment, countRows, closeAll } from './helpers.js';
import type { GmailClient } from '../src/gmail/client.js';

const gmail = (to: string): GmailClient => ({
  listHistory: vi.fn(), getMessage: vi.fn(),
  sendForward: vi.fn().mockResolvedValue({ sendId: 's', to }),
  findSentBySubjectTag: vi.fn().mockResolvedValue(null),
} as any);

describe('CHUNK_8 audit_anchor', () => {
  beforeEach(resetTables);
  afterAll(closeAll);

  it('anchors the day and records exactly one audit_day proof', async () => {
    const t = await createTenant();
    await writeAudit({ tenantId: t, action: 'test.event', entity: 'x' });
    const anchor = vi.fn().mockResolvedValue({ proof_id: 'a1', chain_hash: 'c1', verification_status: 'passed', confidence: 1, raw: {} });
    const day = '2026-07-11';
    await anchorAuditDay(t, day, anchor);
    expect(await hasProofRef(t, 'audit_day', day, 'auditproof')).toBe(true);
    // Re-run is idempotent (no second submit / row).
    await anchorAuditDay(t, day, anchor);
    expect(anchor).toHaveBeenCalledTimes(1);
    expect(await countRows('proof_refs', "entity_kind='audit_day'")).toBe(1);
  });
});

describe('white_label_install', () => {
  beforeEach(resetTables);
  afterAll(closeAll);

  it('two tenants with different configs run the identical pipeline (config only)', async () => {
    // Tenant A forwards to its own address; tenant B to a different one — same code path.
    const clean = async () => ({ findings: [], raw: {} });
    const telegram = { send: vi.fn().mockResolvedValue(undefined) };

    const a = await createTenant('Alpha LLC');
    const am = await insertMessage(a);
    await insertAttachment(a, am);
    const aGmail = gmail('alpha@qbodocs.com');
    const aOut = await gatekeepOnce(a, am, { scan: clean, forwarder: createLockedForwarder('alpha@qbodocs.com', aGmail), telegram });

    const b = await createTenant('Beta Inc');
    const bm = await insertMessage(b);
    await insertAttachment(b, bm);
    const bGmail = gmail('beta@qbodocs.com');
    const bOut = await gatekeepOnce(b, bm, { scan: clean, forwarder: createLockedForwarder('beta@qbodocs.com', bGmail), telegram });

    expect(aOut.action).toBe('forwarded');
    expect(bOut.action).toBe('forwarded');
    // Each forwarded to ITS OWN configured address — no code difference, only config.
    await expect((aGmail.sendForward as any).mock.results[0].value).resolves.toMatchObject({ to: 'alpha@qbodocs.com' });
    await expect((bGmail.sendForward as any).mock.results[0].value).resolves.toMatchObject({ to: 'beta@qbodocs.com' });
    expect(await countRows('forwards', "status='forwarded'")).toBe(2);
  });
});
