import { describe, it, expect, afterEach, afterAll } from 'vitest';
import { handleRequest } from '../src/server.js';
import { resetPoolForTest, closePool } from '../src/db.js';
import { seedInstall, captureRespond } from './helpers.js';

/**
 * Server behavior: /health (no auth) 200 / 503-on-db-down; auth runs FIRST on every
 * other route; authed-but-unimplemented routes return 501; a dependency failure
 * during auth fails CLOSED (503), never open. Error shape {error:{code,message}}.
 */

const GOOD_URL = process.env.DATABASE_URL!;
const DEAD_URL = GOOD_URL.replace(/\/[^/]+$/, '/aphub_broker_nope_missing');

async function call(method: string, path: string, authorization?: string) {
  const cap = captureRespond();
  await handleRequest(method, new URL(`http://localhost${path}`), authorization, cap.respond);
  return cap.last();
}

describe('broker server', () => {
  afterEach(async () => {
    // Always restore the good pool after any DB-down simulation.
    await resetPoolForTest(GOOD_URL);
  });
  afterAll(closePool);

  it('GET /health → 200 {status:ok,db:true} when the DB is reachable, no auth', async () => {
    const r = await call('GET', '/health');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: 'ok', db: true });
  });

  it('GET /health → 503 {status:degraded,db:false} when the DB is down', async () => {
    await resetPoolForTest(DEAD_URL);
    const r = await call('GET', '/health');
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ status: 'degraded', db: false });
  });

  it('authed route not yet implemented (heartbeat = CHUNK_6) → 501 NOT_IMPLEMENTED', async () => {
    // /v1/extract is now implemented (CHUNK_3); /v1/heartbeat remains a placeholder
    // until CHUNK_6, so it is the honest target for the "authed but unimplemented" case.
    const { token } = await seedInstall();
    const r = await call('POST', '/v1/heartbeat', `Bearer ${token}`);
    expect(r.status).toBe(501);
    expect(r.body).toMatchObject({ error: { code: 'NOT_IMPLEMENTED' } });
  });

  it('auth runs FIRST — an unauthed request to a non-health route is 401, never 501/400', async () => {
    const r = await call('POST', '/v1/extract');
    expect(r.status).toBe(401);
    expect(r.body).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
  });

  it('a DB failure during the auth check fails CLOSED (503 DEGRADED), never open', async () => {
    const { token } = await seedInstall(); // seed while DB is good
    await resetPoolForTest(DEAD_URL);
    const r = await call('POST', '/v1/extract', `Bearer ${token}`);
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ error: { code: 'DEGRADED' } });
  });
});
