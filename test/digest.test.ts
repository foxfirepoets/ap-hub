import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { generateDailyDigest } from '../src/services/digest.js';
import { raiseException } from '../src/exceptions.js';
import { getTodayCounts, listNotifications } from '../src/services/read/index.js';
import { runMarkNotificationRead } from '../src/services/action/index.js';
import { gatekeepOnce } from '../src/gatekeeper/gatekeep.js';
import { createLockedForwarder } from '../src/gatekeeper/forwarder.js';
import { createSession } from '../src/auth/session.js';
import {
  resetTables, createTenant, createUser, insertMessage, insertAttachment, countRows, closeAll,
} from './helpers.js';
import type { GmailClient } from '../src/gmail/client.js';

/**
 * CHUNK_7_DIGEST — one daily_digest batch/tenant/day (counts sourced from the SAME
 * getTodayCounts query CHUNK_3 uses — no separate risk list), immediate risk_alert
 * notifications for material-risk reason codes only, and fail-safe deferral when the
 * counts source is unavailable.
 */

function gmail(): GmailClient {
  return {
    listHistory: vi.fn(),
    getMessage: vi.fn(),
    sendForward: vi.fn().mockResolvedValue({ sendId: 's1', to: 'co@qbodocs.com' }),
    findSentBySubjectTag: vi.fn().mockResolvedValue(null),
  } as any;
}

async function tokenFor(t: number, role = 'owner_controller', email = 'owner@example.com'): Promise<string> {
  const uid = await createUser(t, { role, email });
  return (await createSession(uid)).token;
}

describe('CHUNK_7 digest — daily batch', () => {
  beforeEach(resetTables);
  afterAll(closeAll);

  it('writes exactly one daily_digest with counts matching the same source as Today', async () => {
    const t = await createTenant();
    await raiseException({ tenantId: t, reasonCode: 'low_confidence', entityRef: 'extraction:1' });
    const day = '2026-07-15';

    const res = await generateDailyDigest(t, day);
    expect(res.status).toBe('created');
    const expected = await getTodayCounts(t);
    if (res.status === 'created') expect(res.counts).toEqual(expected);

    expect(await countRows('notifications', "tenant_id=$1 AND kind='daily_digest' AND digest_batch=$2", [t, day])).toBe(1);
  });

  it('is idempotent: a second run for the same tenant/day writes no second row', async () => {
    const t = await createTenant();
    const day = '2026-07-15';
    await generateDailyDigest(t, day);
    const second = await generateDailyDigest(t, day);
    expect(second.status).toBe('exists');
    expect(await countRows('notifications', "tenant_id=$1 AND kind='daily_digest'", [t])).toBe(1);
  });

  it('a different day produces a second, independent batch', async () => {
    const t = await createTenant();
    await generateDailyDigest(t, '2026-07-14');
    await generateDailyDigest(t, '2026-07-15');
    expect(await countRows('notifications', "tenant_id=$1 AND kind='daily_digest'", [t])).toBe(2);
  });

  it('proof_fail_safe (mirrored): counts source unavailable → defers, never writes zero/guessed counts', async () => {
    const t = await createTenant();
    const day = '2026-07-15';
    const failing = async () => {
      throw new Error('exceptions source unavailable');
    };
    const res = await generateDailyDigest(t, day, failing);
    expect(res.status).toBe('deferred');
    expect(await countRows('notifications', 'tenant_id=$1', [t])).toBe(0);

    // A later, healthy run still produces exactly one batch — deferral does not block retry.
    const retry = await generateDailyDigest(t, day);
    expect(retry.status).toBe('created');
    expect(await countRows('notifications', "tenant_id=$1 AND kind='daily_digest'", [t])).toBe(1);
  });
});

describe('CHUNK_7 digest — risk_alert (reuses the severity classifier, no fork)', () => {
  beforeEach(resetTables);
  afterAll(closeAll);

  it('routine reason codes create NO notification (earned, not automatic)', async () => {
    const t = await createTenant();
    await raiseException({ tenantId: t, reasonCode: 'low_confidence', entityRef: 'a' });
    await raiseException({ tenantId: t, reasonCode: 'unmapped_account', entityRef: 'b' });
    await raiseException({ tenantId: t, reasonCode: 'no_attachment', entityRef: 'c' });
    await raiseException({ tenantId: t, reasonCode: 'proof_scan_unavailable', entityRef: 'd' });
    expect(await countRows('notifications', 'tenant_id=$1', [t])).toBe(0);
  });

  it('bank_change_warning (critical) raises an immediate risk_alert', async () => {
    const t = await createTenant();
    await raiseException({ tenantId: t, reasonCode: 'bank_change_warning', entityRef: 'extraction:1', detail: 'bank changed' });
    expect(
      await countRows('notifications', "tenant_id=$1 AND kind='risk_alert' AND severity='critical'", [t]),
    ).toBe(1);
  });

  it('fraud_flag (high) raises an immediate risk_alert at high severity', async () => {
    const t = await createTenant();
    await raiseException({ tenantId: t, reasonCode: 'fraud_flag', entityRef: 'extraction:1' });
    expect(await countRows('notifications', "tenant_id=$1 AND kind='risk_alert' AND severity='high'", [t])).toBe(1);
  });

  it('integration: gatekeeper bank-change hold produces exactly one risk_alert (same classifier, no second list)', async () => {
    const t = await createTenant();
    const m = await insertMessage(t);
    await insertAttachment(t, m);
    const out = await gatekeepOnce(t, m, {
      scan: async () => ({ findings: [{ severity: 'critical', pattern: 'BANK_ACCOUNT_CHANGE_DETECTED' }], raw: {} }),
      forwarder: createLockedForwarder('co@qbodocs.com', gmail()),
      telegram: { send: vi.fn().mockResolvedValue(undefined) },
    });
    expect(out.action).toBe('held');
    expect(await countRows('notifications', "tenant_id=$1 AND kind='risk_alert'", [t])).toBe(1);
  });

  it('integration: a clean, routine gatekeeper forward raises no notification', async () => {
    const t = await createTenant();
    const m = await insertMessage(t);
    await insertAttachment(t, m);
    const out = await gatekeepOnce(t, m, {
      scan: async () => ({ findings: [], raw: {} }),
      forwarder: createLockedForwarder('co@qbodocs.com', gmail()),
      telegram: { send: vi.fn().mockResolvedValue(undefined) },
    });
    expect(out.action).toBe('forwarded');
    expect(await countRows('notifications', 'tenant_id=$1', [t])).toBe(0);
  });
});

describe('CHUNK_7 digest — API surface', () => {
  beforeEach(resetTables);
  afterAll(closeAll);

  it('GET /api/notifications (via listNotifications) returns the tenant feed, newest first', async () => {
    const t = await createTenant();
    await raiseException({ tenantId: t, reasonCode: 'fraud_flag', entityRef: 'e1' });
    await generateDailyDigest(t, '2026-07-15');
    const rows = await listNotifications(t);
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.kind).sort()).toEqual(['daily_digest', 'risk_alert']);
  });

  it('POST /api/notifications/:id/read marks it read and writes one human audit row', async () => {
    const t = await createTenant();
    const token = await tokenFor(t);
    await raiseException({ tenantId: t, reasonCode: 'bank_change_warning', entityRef: 'e1' });
    const [row] = await listNotifications(t);

    const req = new Request(`http://localhost/api/notifications/${row!.id}/read`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    const res = await runMarkNotificationRead(req, row!.id);
    expect(res.status).toBe(200);

    const [after] = await listNotifications(t);
    expect(after!.readAt).not.toBeNull();
    expect(
      await countRows('audit_log', "tenant_id=$1 AND action='notification.read' AND actor<>'system'", [t]),
    ).toBe(1);
  });

  it('marking read is tenant-scoped: a foreign tenant id 404s and changes nothing', async () => {
    const a = await createTenant('A');
    const b = await createTenant('B');
    const tokenB = await tokenFor(b, 'owner_controller', 'ownerb@example.com');
    await raiseException({ tenantId: a, reasonCode: 'bank_change_warning', entityRef: 'e1' });
    const [row] = await listNotifications(a);

    const req = new Request(`http://localhost/api/notifications/${row!.id}/read`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenB}` },
    });
    const res = await runMarkNotificationRead(req, row!.id);
    expect(res.status).toBe(404);
    const [stillUnread] = await listNotifications(a);
    expect(stillUnread!.readAt).toBeNull();
  });
});
