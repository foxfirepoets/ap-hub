import { describe, it, expect, vi } from 'vitest';
import { SwarmSyncClient } from '../src/swarmsync/client.js';

/**
 * Guarantee-5 (proof_fail_safe): a proof-service call failure must never be
 * treated as a pass. These tests prove the SwarmSyncClient itself has no
 * fail-open path — any non-2xx, network failure, or malformed 200 body from
 * the configured proof endpoint surfaces as a THROW, which the existing
 * proof-gate logic (proof_fail_safe / gatekeeper_hold / proof_gate_posting)
 * turns into a HOLD.
 *
 * (CHUNK_6 hosted-dependency removal: the hosted key broker that used to sit
 * in front of these calls has been removed — SwarmSyncClient now always talks
 * directly to the configured SWARMSYNC_API_BASE with the operator's own key.
 * These tests were rewritten from broker-specific fixtures to generic ones;
 * the fail-safe guarantee they prove is unchanged.)
 */

// FetchLike shape the SwarmSyncClient expects.
function res(ok: boolean, status: number, body: unknown, throwOnJson = false) {
  return {
    ok,
    status,
    json: async () => {
      if (throwOnJson) throw new SyntaxError('Unexpected end of JSON input');
      return body;
    },
    text: async () => (throwOnJson ? '' : JSON.stringify(body)),
  };
}

/** retries:0 keeps the test fast. */
function proofClient(fetchImpl: any) {
  return new SwarmSyncClient({
    apiBase: 'http://127.0.0.1:9/proof',
    webBase: 'https://swarmsync.ai',
    apiKey: 'ssk_live_testkey',
    fetchImpl,
    retries: 0,
    backoffBaseMs: 1,
    timeoutMs: 2000,
  });
}

describe('proof-service fail-safe — proof calls HOLD, never fail open', () => {
  it('CASE 1: proof service returns 502 on verify → verifyDocument THROWS (→ pipeline holds)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(false, 502, { error: { code: 'UPSTREAM_FAILED' } }));
    await expect(proofClient(fetchImpl).verifyDocument({ a: 1 }, { b: 2 })).rejects.toThrow();
  });

  it('CASE 2: proof service unreachable (fetch throws) → verifyDocument THROWS', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(proofClient(fetchImpl).verifyDocument({ a: 1 }, { b: 2 })).rejects.toThrow();
  });

  it('CASE 3: proof service returns 200 with an EMPTY/malformed body → THROWS, NOT treated as a pass', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(true, 200, undefined, /* throwOnJson */ true));
    await expect(proofClient(fetchImpl).verifyDocument({ a: 1 }, { b: 2 })).rejects.toThrow();
  });

  it('CASE 4 (positive control): a real proof-service 200 is returned normally', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      res(true, 200, { proof_id: 'p1', chain_hash: 'h1', verification_status: 'passed', confidence: 0.95 }),
    );
    const out = await proofClient(fetchImpl).verifyDocument({ a: 1 }, { b: 2 });
    expect(out.proof_id).toBe('p1');
    // The bearer sent is the operator's own SwarmSync key, never a broker/install token.
    expect(fetchImpl.mock.calls[0]![1].headers.authorization).toBe('Bearer ssk_live_testkey');
  });
});
