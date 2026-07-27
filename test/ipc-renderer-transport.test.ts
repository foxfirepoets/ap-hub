import { afterEach, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { IPC_CHANNELS } from '../desktop/channels.js';
import { READ_ENTRIES } from '../desktop/ipc/read/index.js';
import { ACTION_ENTRIES } from '../desktop/ipc/action/index.js';
import type { RegistryEntry } from '../desktop/ipc/registry.js';

import { allRoutes, resolveRoute } from '../app/lib/ipc-routes.js';
import { apiDelete, apiGet, apiPatch, apiPost, ApiError } from '../app/lib/api.js';
import type { AphubBridge, IpcResult } from '../app/lib/aphub-bridge.js';

/**
 * B5 — the renderer transport port. Two concerns:
 *
 *  1. `app/lib/ipc-routes.ts`'s pure table cannot import the registry (no `zod`/`src/**` in the
 *     renderer bundle), so it duplicates every `(method, pathTemplate)` the registry declares.
 *     The parity tests below are what makes that duplication safe — they import BOTH sides,
 *     which the table itself is forbidden from doing.
 *  2. `app/lib/api.ts`'s throw/no-throw asymmetry (apiGet throws, mutations never do) must
 *     survive the swap from `fetch` to `window.aphub.invoke` exactly, including the `ok: true`
 *     + `code: 'QBO_RETRY'` case on a 202.
 */

const ROOT = join(__dirname, '..');
const ALL_ENTRIES: readonly RegistryEntry[] = [...READ_ENTRIES, ...ACTION_ENTRIES];
const CHANNEL_SET = new Set(IPC_CHANNELS);

function entryKey(entry: { method: string; pathTemplate: string }): string {
  return `${entry.method} ${entry.pathTemplate}`;
}

// --- 1. registry parity, both directions ----------------------------------------------------

describe('ipc-routes table vs the registry', () => {
  it('has exactly 55 entries on both sides', () => {
    expect(ALL_ENTRIES.length).toBe(55);
    expect(allRoutes().length).toBe(55);
  });

  it('every registry entry has exactly one matching table route', () => {
    const routeKeys = allRoutes().map(entryKey);
    for (const entry of ALL_ENTRIES) {
      const key = entryKey(entry);
      const matches = routeKeys.filter((k) => k === key);
      expect(matches.length, `expected exactly one ipc-routes entry for ${key}`).toBe(1);
    }
  });

  it('every table route has exactly one matching registry entry (no orphans)', () => {
    const entryKeys = ALL_ENTRIES.map(entryKey);
    for (const route of allRoutes()) {
      const key = entryKey(route);
      const matches = entryKeys.filter((k) => k === key);
      expect(matches.length, `expected exactly one registry entry for ${key}`).toBe(1);
    }
  });

  it('every table route resolves to the SAME channel the registry entry declares', () => {
    const byKey = new Map(ALL_ENTRIES.map((entry) => [entryKey(entry), entry.channel]));
    for (const route of allRoutes()) {
      expect(route.channel).toBe(byKey.get(entryKey(route)));
    }
  });

  it('no table route names a channel outside IPC_CHANNELS', () => {
    for (const route of allRoutes()) {
      expect(CHANNEL_SET.has(route.channel), `${route.channel} is not in IPC_CHANNELS`).toBe(true);
    }
  });
});

// --- 2. multi-param path extraction ----------------------------------------------------------

describe('resolveRoute path-param extraction', () => {
  it('extracts statementId and lineId by their registry-declared names, in order', () => {
    const resolved = resolveRoute('POST', '/api/statements/501/lines/7/match', {
      providerRef: { transactionId: 'TXN-1' },
      reason: 'matched manually',
    });
    expect(resolved).not.toBeNull();
    expect(resolved!.channel).toBe('aphub:statements:match-line');
    expect(resolved!.payload).toEqual({
      statementId: 501,
      lineId: 7,
      providerRef: { transactionId: 'TXN-1' },
      reason: 'matched manually',
    });
  });

  it('same multi-param path for exclude-line', () => {
    const resolved = resolveRoute('POST', '/api/statements/501/lines/7/exclude', { reason: 'not ours' });
    expect(resolved!.channel).toBe('aphub:statements:exclude-line');
    expect(resolved!.payload).toEqual({ statementId: 501, lineId: 7, reason: 'not ours' });
  });

  it('coerces every single path param to a number under its schema name', () => {
    expect(resolveRoute('POST', '/api/proposals/9/approve', {})!.payload).toEqual({ proposalId: 9 });
    expect(resolveRoute('POST', '/api/dimension-mappings/12/accept', {})!.payload).toEqual({ mappingId: 12 });
    expect(resolveRoute('POST', '/api/tax-mappings/3/disable', { reason: 'r' })!.payload).toEqual({
      taxMappingId: 3,
      reason: 'r',
    });
  });

  it('a literal segment (discover) never falls into the sibling :id route', () => {
    const resolved = resolveRoute('GET', '/api/tax-mappings/discover?code=TAX8', undefined);
    expect(resolved!.channel).toBe('aphub:tax-mappings:discover');
    expect(resolved!.payload).toEqual({ code: 'TAX8' });
  });

  it('numeric ids still route to the :id read, not discover', () => {
    const resolved = resolveRoute('GET', '/api/tax-mappings/42', undefined);
    expect(resolved!.channel).toBe('aphub:tax-mappings:get');
    expect(resolved!.payload).toEqual({ id: 42 });
  });
});

// --- 3. the throw / no-throw asymmetry ---------------------------------------------------------

type Invoke = (channel: string, payload?: unknown) => Promise<IpcResult>;

function installBridge(invoke: Invoke): void {
  const bridge: AphubBridge = { invoke, on: () => () => {}, platform: 'win32', channels: [] };
  (globalThis as unknown as { window: { aphub: AphubBridge } }).window = { aphub: bridge };
}

function removeBridge(): void {
  delete (globalThis as { window?: unknown }).window;
}

describe('apiGet throws, mutations never do', () => {
  afterEach(removeBridge);

  it('apiGet throws ApiError with the envelope code, message and status on failure', async () => {
    installBridge(async () => ({ ok: false, status: 404, code: 'NOT_FOUND', message: 'Statement not found.' }));
    await expect(apiGet('/api/statements/9')).rejects.toMatchObject({
      name: 'ApiError',
      code: 'NOT_FOUND',
      message: 'Statement not found.',
      status: 404,
    });
  });

  it('apiGet returns data on a 200 envelope and never throws', async () => {
    installBridge(async () => ({ ok: true, status: 200, data: { id: 1 } }));
    await expect(apiGet('/api/statements/1')).resolves.toEqual({ id: 1 });
  });

  it('apiPost never throws on 201 and returns the ok result', async () => {
    installBridge(async () => ({ ok: true, status: 201, data: { qbo_link: 'https://x' } }));
    const res = await apiPost('/api/proposals/9/approve');
    expect(res).toEqual({ ok: true, status: 201, data: { qbo_link: 'https://x' }, error: undefined });
  });

  it('a 202 carrying QBO_RETRY arrives ok:true with the code intact and does not throw', async () => {
    installBridge(async () => ({
      ok: true,
      status: 202,
      code: 'QBO_RETRY',
      message: 'qbo post failed; safe to retry',
    }));
    const res = await apiPost('/api/proposals/9/approve');
    expect(res.ok).toBe(true);
    expect(res.status).toBe(202);
    expect(res.error).toEqual({ code: 'QBO_RETRY', message: 'qbo post failed; safe to retry' });
  });

  it('a 202 held-for-review response also arrives ok:true, distinct from QBO_RETRY', async () => {
    installBridge(async () => ({ ok: true, status: 202, data: { status: 'held', code: 'HELD_FOR_REVIEW' } }));
    const res = await apiPost<{ status: string; code: string }>('/api/proposals/9/approve');
    expect(res.ok).toBe(true);
    expect(res.status).toBe(202);
    expect(res.data?.code).toBe('HELD_FOR_REVIEW');
    expect(res.error).toBeUndefined();
  });

  it('apiPost never throws on 409 and returns ok:false with the status intact', async () => {
    installBridge(async () => ({ ok: false, status: 409, code: 'CONFLICT', message: 'Already posted.' }));
    const res = await apiPost('/api/proposals/9/approve');
    expect(res).toEqual({ ok: false, status: 409, data: undefined, error: { code: 'CONFLICT', message: 'Already posted.' } });
  });

  it('apiPost never throws on 400 and returns ok:false with the status intact', async () => {
    installBridge(async () => ({ ok: false, status: 400, code: 'VALIDATION', message: 'Add a short reason.' }));
    const res = await apiPost('/api/proposals/9/reject', { reason: '' });
    expect(res).toEqual({ ok: false, status: 400, data: undefined, error: { code: 'VALIDATION', message: 'Add a short reason.' } });
  });

  it('apiPatch never throws and returns the ActionResult shape', async () => {
    installBridge(async () => ({ ok: true, status: 200, data: {} }));
    const res = await apiPatch('/api/reply-drafts/5', { subject: 's', bodyText: 'b', reason: null });
    expect(res).toEqual({ ok: true, status: 200, data: {}, error: undefined });
  });

  it('apiDelete never throws and returns the ActionResult shape', async () => {
    installBridge(async () => ({ ok: true, status: 200, data: {} }));
    const res = await apiDelete('/api/reply-drafts/5');
    expect(res).toEqual({ ok: true, status: 200, data: {}, error: undefined });
  });

  it('an absent status defaults to 200 when ok and 500 when not', async () => {
    installBridge(async (channel) =>
      channel === 'aphub:onboarding:dry-run' ? { ok: true } : { ok: false, code: 'INTERNAL' },
    );
    const okRes = await apiPost('/api/onboarding/dry-run');
    expect(okRes.status).toBe(200);
    const failRes = await apiPost('/api/mappings/remap', { kind: 'k', sourceKey: 's' });
    expect(failRes.status).toBe(500);
  });

  it('apiGet throws a plain-language error, never leaking IPC vocabulary, when the bridge is absent', async () => {
    removeBridge();
    await expect(apiGet('/api/today')).rejects.toMatchObject({ code: 'INTERNAL', status: 500 });
    try {
      await apiGet('/api/today');
      throw new Error('expected apiGet to throw');
    } catch (err) {
      const message = err instanceof ApiError ? err.message : '';
      expect(message.toLowerCase()).not.toMatch(/ipc|channel|invoke|aphub:/);
    }
  });

  it('apiPost never throws and stays plain-language when the bridge is absent', async () => {
    removeBridge();
    const res = await apiPost('/api/proposals/9/approve');
    expect(res.ok).toBe(false);
    expect(res.status).toBe(500);
    expect(res.error?.message.toLowerCase()).not.toMatch(/ipc|channel|invoke|aphub:/);
  });
});

// --- 4. no fetch left in app/lib -------------------------------------------------------------

describe('app/lib performs zero network fetches', () => {
  it('api.ts contains no fetch( call', () => {
    const source = readFileSync(join(ROOT, 'app/lib/api.ts'), 'utf8');
    expect(source).not.toMatch(/\bfetch\s*\(/);
  });

  it('session.tsx contains no fetch( call', () => {
    const source = readFileSync(join(ROOT, 'app/lib/session.tsx'), 'utf8');
    expect(source).not.toMatch(/\bfetch\s*\(/);
  });

  it('no file under app/lib contains a fetch( call (grep-equivalent sweep)', () => {
    const dir = join(ROOT, 'app/lib');
    const offenders: string[] = [];
    for (const name of readdirSync(dir)) {
      if (!/\.(ts|tsx)$/.test(name)) continue;
      const text = readFileSync(join(dir, name), 'utf8');
      if (/\bfetch\s*\(/.test(text)) offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });
});
