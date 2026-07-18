import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { query } from './db.js';
import { authenticate } from './auth.js';
import { logger } from './logger.js';

/**
 * Broker HTTP server (CHUNK_2) — `node:http`, no framework, mirroring `src/http.ts`.
 *
 * - GET /health: no auth; probes the DB with `SELECT 1` → 200 ok / 503 degraded.
 * - Every OTHER route: auth runs FIRST (so the auth matrix is provable), then this
 *   chunk returns 501 NOT_IMPLEMENTED — the real proxy routes arrive in CHUNK_3.
 *
 * Invariant carried from the spec: the broker must never emit a 2xx on an upstream
 * or dependency failure. Here there is no upstream yet; a DB-down auth check fails
 * CLOSED (503 DEGRADED), never open.
 *
 * Error shape everywhere: {"error":{"code":"…","message":"…"}}.
 */

type Respond = (status: number, body: unknown) => void;

function errorBody(code: string, message: string) {
  return { error: { code, message } };
}

// Test-only authed route: returns 200 for a valid token so the auth matrix
// (no-header/unknown/revoked/valid → 401/401/403/200) is exercisable without a
// real proxy route. GUARDED: only mounted when BROKER_TEST_AUTH_ROUTE=1.
const TEST_AUTH_PATH = '/__authcheck';
function testAuthRouteEnabled(): boolean {
  return process.env.BROKER_TEST_AUTH_ROUTE === '1';
}

export async function handleRequest(
  method: string,
  url: URL,
  authorization: string | undefined,
  respond: Respond,
): Promise<void> {
  // --- /health: no auth, DB liveness probe ---
  if (url.pathname === '/health') {
    let db = false;
    try {
      await query('SELECT 1');
      db = true;
    } catch {
      db = false;
    }
    respond(db ? 200 : 503, { status: db ? 'ok' : 'degraded', db });
    return;
  }

  // --- everything else: auth FIRST ---
  let auth;
  try {
    auth = await authenticate(authorization);
  } catch (err) {
    // A dependency failure (e.g. broker DB down) during the auth check must fail
    // CLOSED — we cannot verify revocation/identity, so we never proceed.
    logger.error({ err: String(err) }, 'auth check failed (dependency error)');
    respond(503, errorBody('DEGRADED', 'Broker dependency unavailable; request refused.'));
    return;
  }

  if (!auth.ok) {
    if (auth.reason === 'REVOKED') {
      respond(403, errorBody('TOKEN_REVOKED', 'This install token has been revoked.'));
    } else {
      respond(401, errorBody('UNAUTHENTICATED', 'A valid Authorization: Bearer aph_… token is required.'));
    }
    return;
  }

  // Authenticated. Test-only 200 route (guarded) for the auth matrix.
  if (testAuthRouteEnabled() && method === 'GET' && url.pathname === TEST_AUTH_PATH) {
    respond(200, { ok: true, install: auth.install.label });
    return;
  }

  // All real broker routes (proxy + telemetry) are implemented in later chunks.
  respond(501, errorBody('NOT_IMPLEMENTED', 'This broker route is not implemented in this build.'));
}

export function createBrokerServer(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const respond: Respond = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    handleRequest(req.method ?? 'GET', url, req.headers.authorization, respond).catch((err) => {
      logger.error({ err: String(err) }, 'broker request handler error');
      respond(500, errorBody('INTERNAL', 'Internal error.'));
    });
  });
}
