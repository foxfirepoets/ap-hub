import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { gatekeepOnce } from '../src/gatekeeper/gatekeep.js';
import { createLockedForwarder } from '../src/gatekeeper/forwarder.js';
import { resetTables, createTenant, insertMessage, insertAttachment, countRows, closeAll } from './helpers.js';
import type { GmailClient } from '../src/gmail/client.js';
import type { InvoiceScanResult } from '../src/swarmsync/client.js';

function gmail(sentTo = 'co@qbodocs.com'): GmailClient {
  return {
    listHistory: vi.fn(),
    getMessage: vi.fn(),
    sendForward: vi.fn().mockResolvedValue({ sendId: 'send-1', to: sentTo }),
    findSentBySubjectTag: vi.fn().mockResolvedValue(null),
  } as any;
}
const clean: InvoiceScanResult = { findings: [], raw: {} };
const telegramOk = { send: vi.fn().mockResolvedValue(undefined) };

async function setupInvoice(mime = 'application/pdf') {
  const t = await createTenant();
  const m = await insertMessage(t, {});
  const a = await insertAttachment(t, m, { mime });
  return { t, m, a };
}

describe('CHUNK_4 gatekeeper', () => {
  beforeEach(resetTables);
  afterAll(closeAll);

  it('forwards a clean invoice exactly once to the configured address', async () => {
    const { t, m } = await setupInvoice();
    const g = gmail();
    const out = await gatekeepOnce(t, m, {
      scan: async () => clean,
      forwarder: createLockedForwarder('co@qbodocs.com', g),
      telegram: telegramOk,
    });
    expect(out.action).toBe('forwarded');
    expect(g.sendForward).toHaveBeenCalledTimes(1);
    expect(await countRows('forwards', "status='forwarded'")).toBe(1);
    expect(await countRows('proof_refs', "entity_kind='attachment' AND product='invoiceproof'")).toBe(1);
  });

  it('gatekeeper_hold: bank-change critical → held, alerted, never forwarded', async () => {
    const { t, m } = await setupInvoice();
    const g = gmail();
    const telegram = { send: vi.fn().mockResolvedValue(undefined) };
    const out = await gatekeepOnce(t, m, {
      scan: async () => ({ findings: [{ severity: 'critical', pattern: 'BANK_ACCOUNT_CHANGE_DETECTED' }], raw: {} }),
      forwarder: createLockedForwarder('co@qbodocs.com', g),
      telegram,
    });
    expect(out.action).toBe('held');
    expect(out.reason).toBe('bank_change_warning');
    expect(g.sendForward).not.toHaveBeenCalled();
    expect(telegram.send).toHaveBeenCalledTimes(1);
    expect(await countRows('exceptions', "reason_code='bank_change_warning'")).toBe(1);
  });

  it('held_alert: telegram failure keeps the hold and records alert_failed', async () => {
    const { t, m } = await setupInvoice();
    const telegram = { send: vi.fn().mockRejectedValue(new Error('tg down')) };
    const out = await gatekeepOnce(t, m, {
      scan: async () => ({ findings: [{ severity: 'critical', pattern: 'EXACT_DUPLICATE' }], raw: {} }),
      forwarder: createLockedForwarder('co@qbodocs.com', gmail()),
      telegram,
    });
    expect(out.action).toBe('held');
    expect(await countRows('forwards', "status='held'")).toBe(1);
    expect(await countRows('exceptions', "reason_code='alert_failed'")).toBe(1);
  });

  it('unscannable_hold: image attachment is held, never forwarded', async () => {
    const { t, m } = await setupInvoice('image/png');
    const g = gmail();
    const out = await gatekeepOnce(t, m, {
      scan: async () => clean,
      forwarder: createLockedForwarder('co@qbodocs.com', g),
      telegram: { send: vi.fn().mockResolvedValue(undefined) },
    });
    expect(out.reason).toBe('unscannable_format');
    expect(g.sendForward).not.toHaveBeenCalled();
  });

  it('proof_fail_safe: scan outage → held (proof_scan_unavailable), never forward-unscanned', async () => {
    const { t, m } = await setupInvoice();
    const g = gmail();
    const out = await gatekeepOnce(t, m, {
      scan: async () => { throw new Error('swarmsync down'); },
      forwarder: createLockedForwarder('co@qbodocs.com', g),
      telegram: { send: vi.fn().mockResolvedValue(undefined) },
    });
    expect(out.action).toBe('held');
    expect(out.reason).toBe('proof_scan_unavailable');
    expect(g.sendForward).not.toHaveBeenCalled();
  });

  it('no_double_forward: re-running never forwards twice', async () => {
    const { t, m } = await setupInvoice();
    const g = gmail();
    const forwarder = createLockedForwarder('co@qbodocs.com', g);
    await gatekeepOnce(t, m, { scan: async () => clean, forwarder, telegram: telegramOk });
    await gatekeepOnce(t, m, { scan: async () => clean, forwarder, telegram: telegramOk });
    expect(g.sendForward).toHaveBeenCalledTimes(1);
    expect(await countRows('forwards', "status='forwarded'")).toBe(1);
  });
});
