import { describe, it, expect, vi } from 'vitest';
import { SwarmSyncClient } from '../src/swarmsync/client.js';

function res(ok: boolean, status: number, body: any) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) };
}

describe('SwarmSyncClient', () => {
  it('normalizes InvoiceProof findings', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      res(true, 200, { findings: [{ severity: 'critical', pattern: 'EXACT_DUPLICATE' }] }),
    );
    const c = new SwarmSyncClient({ apiBase: 'https://api', webBase: 'https://web', apiKey: 'ssk_live_x', fetchImpl });
    const out = await c.scanInvoices({ invoices: [] });
    expect(out.findings[0]!.pattern).toBe('EXACT_DUPLICATE');
    expect(fetchImpl.mock.calls[0]![0]).toBe('https://web/api/scan/invoices');
  });

  it('normalizes Verify-API proof fields (proof_id/chain_hash)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      res(true, 200, { proof_id: 'p1', chain_hash: 'h1', verification_status: 'passed', confidence: 0.9 }),
    );
    const c = new SwarmSyncClient({ apiBase: 'https://api', webBase: 'https://web', apiKey: 'ssk_live_x', fetchImpl });
    const out = await c.verifyDocument({ a: 1 }, { b: 2 });
    expect(out.proof_id).toBe('p1');
    expect(out.chain_hash).toBe('h1');
    // bearer auth on api base
    expect(fetchImpl.mock.calls[0]![1].headers.authorization).toBe('Bearer ssk_live_x');
  });

  it('retries on 500 then succeeds (backoff)', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(res(false, 500, {}))
      .mockResolvedValueOnce(res(true, 200, { findings: [] }));
    const c = new SwarmSyncClient({
      apiBase: 'https://api',
      webBase: 'https://web',
      apiKey: 'k',
      fetchImpl,
      backoffBaseMs: 1,
    });
    const out = await c.scanInvoices({ invoices: [] });
    expect(out.findings).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not retry a 4xx client error', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(false, 400, { error: 'bad' }));
    const c = new SwarmSyncClient({ apiBase: 'https://api', webBase: 'https://web', apiKey: 'k', fetchImpl, backoffBaseMs: 1 });
    await expect(c.verifyDocument({}, {})).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
