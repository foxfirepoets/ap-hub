import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { handleRequest, sanitizeHeartbeatDetail } from '../src/server.js';
import { query, closePool } from '../src/db.js';
import { resetRateLimitForTest } from '../src/ratelimit.js';
import { seedInstall, captureFull } from './helpers.js';

/**
 * CHUNK_6 heartbeat route: liveness telemetry only — a closed event enum, a capped
 * detail, 5/min rate limit, and the hard guarantee that NO business data ever lands
 * in the `heartbeats` table (content-assertion test below).
 */

async function post(path: string, authorization: string | undefined, body: unknown) {
  const cap = captureFull();
  await handleRequest('POST', new URL(`http://localhost${path}`), authorization, cap.respond, JSON.stringify(body), cap.respondRaw);
  return cap.last();
}

describe('broker /v1/heartbeat', () => {
  beforeEach(() => resetRateLimitForTest());
  afterAll(closePool);

  it('records a valid liveness heartbeat → 201', async () => {
    const { token, id } = await seedInstall();
    const r = await post('/v1/heartbeat', `Bearer ${token}`, { event: 'alive', pg_ok: true, detail: 'boot:ok', tz_offset_minutes: -300 });
    expect(r.status).toBe(201);
    const row = (await query('SELECT event, pg_ok, detail, tz_offset_minutes FROM heartbeats WHERE install_id=$1', [id])).rows[0] as any;
    expect(row.event).toBe('alive');
    expect(row.pg_ok).toBe(true);
    expect(row.detail).toBe('boot:ok');
  });

  it('an illegal event value → 400, nothing stored', async () => {
    const { token, id } = await seedInstall();
    const before = (await query('SELECT count(*)::int n FROM heartbeats WHERE install_id=$1', [id])).rows[0] as any;
    const r = await post('/v1/heartbeat', `Bearer ${token}`, { event: 'invoice_seen' });
    expect(r.status).toBe(400);
    const after = (await query('SELECT count(*)::int n FROM heartbeats WHERE install_id=$1', [id])).rows[0] as any;
    expect(after.n).toBe(before.n);
  });

  it('CONTENT ASSERTION: a detail with a vendor name, an amount and an email is stored as none of them', async () => {
    const { token, id } = await seedInstall();
    const dirty = 'Acme Corp invoice $1,234.56 from billing@acme.com';
    const r = await post('/v1/heartbeat', `Bearer ${token}`, { event: 'pg_health', pg_ok: true, detail: dirty });
    expect(r.status).toBe(201);
    const row = (await query('SELECT detail FROM heartbeats WHERE install_id=$1 ORDER BY id DESC LIMIT 1', [id])).rows[0] as any;
    expect(row.detail).toBeNull();
    // Belt-and-braces: none of the sensitive substrings survive anywhere in the column.
    const all = (await query('SELECT COALESCE(detail, \'\') d FROM heartbeats WHERE install_id=$1', [id])).rows.map((x: any) => x.d).join('|');
    for (const secret of ['Acme', '1,234.56', 'billing@acme.com']) expect(all).not.toContain(secret);
  });

  it('detail at the 200-char boundary of the safe pattern is kept; over-200 is stripped', () => {
    const ok = 'a' + 'b'.repeat(199); // 200 chars, safe pattern
    const over = 'a' + 'b'.repeat(200); // 201 chars
    expect(sanitizeHeartbeatDetail(ok)).toBe(ok);
    expect(sanitizeHeartbeatDetail(over)).toBeNull();
  });

  it('rate limit: the 6th heartbeat in a minute → 429', async () => {
    const { token } = await seedInstall();
    for (let i = 0; i < 5; i++) {
      const ok = await post('/v1/heartbeat', `Bearer ${token}`, { event: 'alive' });
      expect(ok.status).toBe(201);
    }
    const sixth = await post('/v1/heartbeat', `Bearer ${token}`, { event: 'alive' });
    expect(sixth.status).toBe(429);
    expect(sixth.body).toMatchObject({ error: { code: 'RATE_LIMITED' } });
  });

  it('an unauthenticated heartbeat is refused (401) — auth runs first', async () => {
    const r = await post('/v1/heartbeat', undefined, { event: 'alive' });
    expect(r.status).toBe(401);
  });
});
