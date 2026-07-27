import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, resetConfigCache } from '../src/config.js';
import { swarmsync, resetServicesForTest } from '../src/services.js';
import { sendHeartbeat } from '../src/telemetry.js';
import * as extractModel from '../src/extract/model.js';

/**
 * CHUNK_6 hosted-dependency removal. Proves a fresh install makes ZERO calls
 * to any hosted key-broker: the concept is gone from source (not merely
 * unreferenced-but-present), config can no longer carry broker settings, the
 * extractor has no broker code path, the SwarmSync client always talks
 * directly to the configured endpoint with the operator's own key, and
 * telemetry never makes a network call at all.
 */

const SRC_ROOT = join(process.cwd(), 'src');

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('no_hosted_dependency (CHUNK_6): the broker concept is fully deleted from src/', () => {
  it('no file under src/ references a BROKER_* config key', () => {
    const offenders: string[] = [];
    for (const file of listTsFiles(SRC_ROOT)) {
      const text = readFileSync(file, 'utf8');
      if (/BROKER_/.test(text)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it('getBrokerExtractor no longer exists as an export', () => {
    expect((extractModel as any).getBrokerExtractor).toBeUndefined();
  });
});

describe('no_hosted_dependency: config can no longer carry a broker endpoint', () => {
  const base = {
    DATABASE_URL: 'postgres://x',
    ENCRYPTION_KEY: '0'.repeat(64),
    GMAIL_CLIENT_ID: 'g',
    GMAIL_CLIENT_SECRET: 's',
    GOOGLE_SSO_CLIENT_ID: 'google-sso-client',
    GOOGLE_SSO_CLIENT_SECRET: 'google-sso-secret',
    SESSION_COOKIE_SECRET: 'no-hosted-dep-test-session-secret-32-bytes-min',
  };

  it('legacy BROKER_* env vars (e.g. left over from an old .env) have no effect on the loaded config', () => {
    const cfg = loadConfig({
      ...base,
      BROKER_BASE_URL: 'https://broker.example.com',
      BROKER_INSTALL_TOKEN: 'legacy-token',
    } as any);
    expect((cfg as any).BROKER_BASE_URL).toBeUndefined();
    expect((cfg as any).BROKER_INSTALL_TOKEN).toBeUndefined();
  });

  it('SWARMSYNC_ENABLED defaults to false — a fresh install never calls the (optional) proof service either', () => {
    const cfg = loadConfig({ ...base } as any);
    expect(cfg.SWARMSYNC_ENABLED).toBe(false);
  });
});

describe('no_hosted_dependency: SwarmSyncClient always targets the configured endpoint directly', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    resetConfigCache();
    resetServicesForTest();
    process.env.DATABASE_URL = 'postgres://x';
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    process.env.GMAIL_CLIENT_ID = 'g';
    process.env.GMAIL_CLIENT_SECRET = 's';
    process.env.GOOGLE_SSO_CLIENT_ID = 'google-sso-client';
    process.env.GOOGLE_SSO_CLIENT_SECRET = 'google-sso-secret';
    process.env.SESSION_COOKIE_SECRET = 'no-hosted-dep-test-session-secret-32-bytes-min';
    process.env.SWARMSYNC_API_KEY = 'ssk_live_directkey';
    delete process.env.BROKER_BASE_URL;
    delete process.env.BROKER_INSTALL_TOKEN;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    resetConfigCache();
    resetServicesForTest();
  });

  it('verifyDocument hits the configured SWARMSYNC_API_BASE with the operator key, never a broker host', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ proof_id: 'p1', chain_hash: 'h1', verification_status: 'passed', confidence: 0.9 }),
      text: async () => '',
    });
    globalThis.fetch = fetchSpy as any;

    await swarmsync().verifyDocument({ a: 1 }, { b: 2 });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0]!;
    expect(url).toMatch(/^https:\/\/api\.swarmsync\.ai\//);
    expect((opts as any).headers.authorization).toBe('Bearer ssk_live_directkey');
  });
});

describe('no_hosted_dependency: telemetry is local-only and never makes a network call', () => {
  it('sendHeartbeat never calls fetch, even if legacy BROKER_* env vars are present', async () => {
    process.env.BROKER_BASE_URL = 'https://broker.example.com';
    process.env.BROKER_INSTALL_TOKEN = 'legacy-token';
    const fetchSpy = vi.fn();
    const ok = await sendHeartbeat({ event: 'alive' }, { fetchImpl: fetchSpy as any });
    expect(ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    delete process.env.BROKER_BASE_URL;
    delete process.env.BROKER_INSTALL_TOKEN;
  });
});
