import { describe, it, expect, vi } from 'vitest';
import { SwarmSyncClient } from '../src/swarmsync/client.js';
import { getBrokerExtractor } from '../src/extract/model.js';
import { loadConfig } from '../src/config.js';

/**
 * CHUNK_4 — guarantee-5 under the broker. The broker adds a new hop in front of
 * the proof service; these tests prove it introduces NO fail-open path. Every
 * broker failure shape must surface to ap-hub as a THROW, which the existing
 * proof-gate logic (proof_fail_safe / gatekeeper_hold / proof_gate_posting) turns
 * into a HOLD. A broker outage must be indistinguishable from a SwarmSync outage.
 *
 * These are the highest-value tests in this chunk.
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

/** A broker-backed client: apiBase = broker URL, apiKey = install token. retries:0 keeps it fast. */
function brokerClient(fetchImpl: any) {
  return new SwarmSyncClient({
    apiBase: 'http://127.0.0.1:9/broker',
    webBase: 'https://swarmsync.ai',
    apiKey: 'aph_installtoken',
    fetchImpl,
    retries: 0,
    backoffBaseMs: 1,
    timeoutMs: 2000,
  });
}

describe('broker fail-safe — proof calls HOLD, never fail open', () => {
  it('CASE 1: broker returns 502 on verify → verifyDocument THROWS (→ pipeline holds)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(false, 502, { error: { code: 'UPSTREAM_FAILED' } }));
    await expect(brokerClient(fetchImpl).verifyDocument({ a: 1 }, { b: 2 })).rejects.toThrow();
  });

  it('CASE 2: broker unreachable (fetch throws) → verifyDocument THROWS', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(brokerClient(fetchImpl).verifyDocument({ a: 1 }, { b: 2 })).rejects.toThrow();
  });

  it('CASE 3: broker returns 200 with an EMPTY/malformed body → THROWS, NOT treated as a pass', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(true, 200, undefined, /* throwOnJson */ true));
    await expect(brokerClient(fetchImpl).verifyDocument({ a: 1 }, { b: 2 })).rejects.toThrow();
  });

  it('CASE 4 (positive control): a real broker 200 proof is returned normally', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      res(true, 200, { proof_id: 'p1', chain_hash: 'h1', verification_status: 'passed', confidence: 0.95 }),
    );
    const out = await brokerClient(fetchImpl).verifyDocument({ a: 1 }, { b: 2 });
    expect(out.proof_id).toBe('p1');
    // The bearer sent to the broker is the INSTALL TOKEN, never the ssk_ key.
    expect(fetchImpl.mock.calls[0]![1].headers.authorization).toBe('Bearer aph_installtoken');
  });
});

describe('broker extractor — fail-closed + no local key', () => {
  it('broker 502 on /v1/extract → extractor THROWS (→ exception row, proposal not advanced)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 502, json: async () => ({}) });
    const ex = getBrokerExtractor('http://127.0.0.1:9', 'aph_tok', fetchImpl as any);
    await expect(ex.extract({ bodyText: 'invoice' })).rejects.toThrow(/502/);
  });

  it('broker 200 with a valid Anthropic Messages response → parsed extraction JSON', async () => {
    const anthropicResponse = { content: [{ type: 'text', text: '{"vendor_name":"Acme","total":100}' }] };
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => anthropicResponse });
    const ex = getBrokerExtractor('http://127.0.0.1:9', 'aph_tok', fetchImpl as any);
    const out = (await ex.extract({ bodyText: 'invoice' })) as any;
    expect(out.vendor_name).toBe('Acme');
    // Posts to the broker with the install token; never contacts Anthropic directly.
    expect(fetchImpl.mock.calls[0]![0]).toBe('http://127.0.0.1:9/v1/extract');
    expect(fetchImpl.mock.calls[0]![1].headers.authorization).toBe('Bearer aph_tok');
  });
});

describe('broker-mode config — keys optional with a broker, required without', () => {
  const base = {
    DATABASE_URL: 'postgres://x',
    ENCRYPTION_KEY: '0'.repeat(64),
    GMAIL_CLIENT_ID: 'g',
    GMAIL_CLIENT_SECRET: 's',
    GOOGLE_SSO_CLIENT_ID: 'google-sso-client',
    GOOGLE_SSO_CLIENT_SECRET: 'google-sso-secret',
    SESSION_COOKIE_SECRET: 'broker-test-session-secret-32-bytes-minimum',
  };

  it('BROKER MODE: boots with NO ANTHROPIC_API_KEY when BROKER_BASE_URL is set', () => {
    const cfg = loadConfig({ ...base, BROKER_BASE_URL: 'https://broker.example.com', BROKER_INSTALL_TOKEN: 'aph_x' } as any);
    expect(cfg.BROKER_BASE_URL).toBe('https://broker.example.com');
    expect(cfg.ANTHROPIC_API_KEY).toBe('');
  });

  it('DIRECT MODE: boots with no ANTHROPIC_API_KEY (the LLM backend is resolved at extraction time)', () => {
    const cfg = loadConfig({ ...base } as any);
    expect(cfg.ANTHROPIC_API_KEY).toBe('');
    expect(cfg.BROKER_BASE_URL).toBeUndefined();
  });

  it('rejects a non-https BROKER_BASE_URL (except http://127.0.0.1)', () => {
    expect(() => loadConfig({ ...base, BROKER_BASE_URL: 'http://evil.example.com' } as any)).toThrow(/https/);
    // localhost is allowed for tests
    const cfg = loadConfig({ ...base, BROKER_BASE_URL: 'http://127.0.0.1:8080' } as any);
    expect(cfg.BROKER_BASE_URL).toBe('http://127.0.0.1:8080');
  });
});
