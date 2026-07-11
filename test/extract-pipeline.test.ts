import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { extractOnce } from '../src/pipeline/extract.js';
import { resetTables, createTenant, insertMessage, insertAttachment, countRows, closeAll } from './helpers.js';
import { hasProofRef } from '../src/swarmsync/proof.js';
import type { Extractor } from '../src/extract/model.js';

const goodRaw = {
  vendor_name: 'Acme', invoice_number: 'INV-1', invoice_date: '2026-07-01', due_date: null,
  total: 100, tax: 0, line_items: [{ description: 'work', amount: 100 }],
  doc_type: 'invoice', direction: 'AP', field_confidence: { vendor_name: 0.95, total: 0.95 },
};
const extractor = (raw: any): Extractor => ({ extract: vi.fn().mockResolvedValue(raw) });
const okVerify = vi.fn().mockResolvedValue({ proof_id: 'p1', chain_hash: 'h1', verification_status: 'passed', confidence: 0.9, raw: {} });
const enqueueMap = vi.fn().mockResolvedValue(undefined);

describe('CHUNK_5 extract pipeline', () => {
  beforeEach(resetTables);
  afterAll(closeAll);

  it('persists extraction and records the Verify-API proof', async () => {
    const t = await createTenant();
    const m = await insertMessage(t);
    const a = await insertAttachment(t, m);
    const out = await extractOnce(t, { tenantId: t, messageId: m, attachmentId: a }, {
      extractor: extractor(goodRaw),
      verify: okVerify,
      enqueueMap,
    });
    expect(out.status).toBe('ok');
    expect(await hasProofRef(t, 'extraction', String(out.extractionId), 'verify_api')).toBe(true);
    expect(enqueueMap).toHaveBeenCalled();
  });

  it('foot_check: totals that do not foot raise total_mismatch', async () => {
    const t = await createTenant();
    const m = await insertMessage(t);
    const a = await insertAttachment(t, m);
    await extractOnce(t, { tenantId: t, messageId: m, attachmentId: a }, {
      extractor: extractor({ ...goodRaw, total: 999 }),
      verify: okVerify,
      enqueueMap,
    });
    expect(await countRows('exceptions', "reason_code='total_mismatch'")).toBe(1);
  });

  it('proof_fail_safe: Verify-API outage → proof_scan_unavailable, extraction still saved', async () => {
    const t = await createTenant();
    const m = await insertMessage(t);
    const a = await insertAttachment(t, m);
    const out = await extractOnce(t, { tenantId: t, messageId: m, attachmentId: a }, {
      extractor: extractor(goodRaw),
      verify: vi.fn().mockRejectedValue(new Error('verify down')),
      enqueueMap,
    });
    expect(out.status).toBe('ok');
    expect(await countRows('extractions')).toBe(1);
    expect(await countRows('exceptions', "reason_code='proof_scan_unavailable'")).toBe(1);
  });

  it('malformed model output is retried and never persisted raw', async () => {
    const t = await createTenant();
    const m = await insertMessage(t);
    const a = await insertAttachment(t, m);
    const flaky: Extractor = {
      extract: vi.fn()
        .mockResolvedValueOnce({ garbage: true })
        .mockResolvedValueOnce({ still: 'bad' })
        .mockResolvedValueOnce(goodRaw),
    };
    const out = await extractOnce(t, { tenantId: t, messageId: m, attachmentId: a }, { extractor: flaky, verify: okVerify, enqueueMap });
    expect(out.status).toBe('ok');
    expect(flaky.extract).toHaveBeenCalledTimes(3);
    expect(await countRows('extractions')).toBe(1);
  });
});
