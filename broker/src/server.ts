import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { query } from './db.js';
import { authenticate, type Install } from './auth.js';
import { logger } from './logger.js';
import { checkRateLimit } from './ratelimit.js';
import {
  isOverCap,
  secondsToWeekReset,
  recordSpend,
  estimateAnthropicUsd,
  swarmsyncFlatUsd,
} from './spend.js';
import { callAnthropic, callSwarmSync, type UpstreamResult } from './upstream.js';

/**
 * Broker HTTP server (CHUNK_2 skeleton + CHUNK_3 proxy routes) — `node:http`,
 * no framework, mirroring `src/http.ts`.
 *
 * - GET /health: no auth; probes the DB with `SELECT 1` → 200 ok / 503 degraded.
 * - Every OTHER route: auth runs FIRST, then (CHUNK_3) the paid proxy routes, else 501.
 *
 * INVARIANT (guarantee 5): the broker must never emit a 2xx on an upstream or
 * dependency failure. Every fail path below returns a NON-2xx and makes NO upstream
 * call when it cannot first verify auth, cap, and rate. `upstream.ts` owns the
 * matching invariant for the network calls themselves.
 *
 * Error shape everywhere: {"error":{"code":"…","message":"…"}}.
 */

type Respond = (status: number, body: unknown, headers?: Record<string, string>) => void;
type RespondRaw = (status: number, raw: string, contentType: string) => void;

function errorBody(code: string, message: string) {
  return { error: { code, message } };
}

// Test-only authed route: returns 200 for a valid token so the auth matrix
// (no-header/unknown/revoked/valid → 401/401/403/200) is exercisable. GUARDED:
// only mounted when BROKER_TEST_AUTH_ROUTE=1.
const TEST_AUTH_PATH = '/__authcheck';
function testAuthRouteEnabled(): boolean {
  return process.env.BROKER_TEST_AUTH_ROUTE === '1';
}

const PROXY_RATE_LIMIT = 60; // requests per install
const PROXY_RATE_WINDOW_MS = 60_000; // per minute

/** Relay an upstream result. On success the body is passed VERBATIM; never 2xx on failure. */
function relayUpstream(result: UpstreamResult, respond: Respond, respondRaw: RespondRaw): void {
  if (!result.ok) {
    respond(502, errorBody('UPSTREAM_FAILED', 'The upstream service failed or was unavailable.'));
    return;
  }
  respondRaw(200, result.body, result.contentType ?? 'application/json');
}

/**
 * Shared pre-flight for every PAID proxy route: rate limit → cap → call upstream
 * → record spend on success → relay. Any refusal makes NO upstream call.
 */
async function runPaidProxy(
  install: Install,
  upstreamKind: 'anthropic' | 'swarmsync',
  doCall: () => Promise<UpstreamResult>,
  respond: Respond,
  respondRaw: RespondRaw,
): Promise<void> {
  const rl = checkRateLimit(install.id, 'proxy', PROXY_RATE_LIMIT, PROXY_RATE_WINDOW_MS);
  if (!rl.allowed) {
    respond(429, errorBody('RATE_LIMITED', 'Too many requests.'), { 'retry-after': String(rl.retryAfterSeconds) });
    return;
  }
  // Spend cap. If the ledger query fails (broker DB down), fail CLOSED: 503 and
  // NO upstream call — we cannot know whether this install is over budget.
  const cap = Number(install.weekly_cap_usd);
  let overCap: boolean;
  try {
    overCap = await isOverCap(install.id, cap);
  } catch (err) {
    logger.error({ err: String(err), install: install.label }, 'spend-cap check failed (fail-closed → 503)');
    respond(503, errorBody('DEGRADED', 'Broker dependency unavailable; request refused.'));
    return;
  }
  if (overCap) {
    let retry = 3600;
    try {
      retry = await secondsToWeekReset();
    } catch {
      /* keep the fallback */
    }
    respond(429, errorBody('SPEND_CAP_EXCEEDED', 'Weekly spend cap reached for this install.'), {
      'retry-after': String(retry),
    });
    return;
  }
  const result = await doCall();
  if (result.ok) {
    const est = upstreamKind === 'anthropic' ? estimateAnthropicUsd(result.usage) : swarmsyncFlatUsd();
    try {
      await recordSpend(install.id, upstreamKind, est);
    } catch (err) {
      // The call already happened; a ledger failure must not turn success into
      // failure for the caller, but it must be loud.
      logger.error({ err: String(err), install: install.label }, 'spend ledger write failed');
    }
  }
  relayUpstream(result, respond, respondRaw);
}

function safeJson(body: string): unknown | undefined {
  try {
    return JSON.parse(body || 'null');
  } catch {
    return undefined;
  }
}

/**
 * `body` and `respondRaw` are optional so CHUNK_2 callers using the 4-arg
 * signature (health, auth matrix — neither needs a body or raw relay) keep
 * working unchanged. The real server always supplies both.
 */
export async function handleRequest(
  method: string,
  url: URL,
  authorization: string | undefined,
  respond: Respond,
  body = '',
  respondRaw: RespondRaw = (status, raw) => {
    // Fallback for old-signature callers: relay parsed JSON if possible.
    try {
      respond(status, JSON.parse(raw || 'null'));
    } catch {
      respond(status, raw);
    }
  },
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
    // Dependency failure (broker DB down) during auth → fail CLOSED.
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
  const install = auth.install;

  // Test-only 200 route (guarded) for the auth matrix.
  if (testAuthRouteEnabled() && method === 'GET' && url.pathname === TEST_AUTH_PATH) {
    respond(200, { ok: true, install: install.label });
    return;
  }

  // --- CHUNK_3 proxy routes (paid; fail-closed) ---
  const p = url.pathname;

  // Anthropic extraction proxy: caller sends a full Anthropic Messages request;
  // the broker injects the key and relays the raw model response verbatim. Keeping
  // the prompt-building in ap-hub (one place) is why this is a thin passthrough.
  if (method === 'POST' && p === '/v1/extract') {
    const parsed = safeJson(body);
    if (parsed === undefined || parsed === null || typeof parsed !== 'object') {
      respond(400, errorBody('VALIDATION', 'Request body must be a JSON object (an Anthropic Messages request).'));
      return;
    }
    await runPaidProxy(install, 'anthropic', () => callAnthropic(parsed), respond, respondRaw);
    return;
  }

  // SwarmSync Verify-API / AuditProof (apiBase, ssk_ key injected).
  if (method === 'POST' && p === '/api/verify') {
    const parsed = safeJson(body);
    if (parsed === undefined) {
      respond(400, errorBody('VALIDATION', 'Request body must be valid JSON.'));
      return;
    }
    await runPaidProxy(install, 'swarmsync', () => callSwarmSync('POST', '/api/verify', false, parsed), respond, respondRaw);
    return;
  }

  // SwarmSync InvoiceProof (webBase; upstream is public but the BROKER still
  // requires a valid install token — enforced above).
  if (method === 'POST' && p === '/api/scan/invoices') {
    const parsed = safeJson(body);
    if (parsed === undefined) {
      respond(400, errorBody('VALIDATION', 'Request body must be valid JSON.'));
      return;
    }
    await runPaidProxy(install, 'swarmsync', () => callSwarmSync('POST', '/api/scan/invoices', true, parsed), respond, respondRaw);
    return;
  }

  // SwarmSync chain verify (apiBase, GET, no body).
  if (method === 'GET' && /^\/api\/proof\/[^/]+\/export\/verify$/.test(p)) {
    await runPaidProxy(install, 'swarmsync', () => callSwarmSync('GET', p, false, undefined), respond, respondRaw);
    return;
  }

  // Telemetry (/v1/heartbeat) arrives in CHUNK_6.
  respond(501, errorBody('NOT_IMPLEMENTED', 'This broker route is not implemented in this build.'));
}

const MAX_BODY_BYTES = 15 * 1024 * 1024; // 15 MB ceiling (base64 attachments ride in Messages)

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function createBrokerServer(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const respond: Respond = (status, body, headers) => {
      res.writeHead(status, { 'content-type': 'application/json', ...(headers ?? {}) });
      res.end(JSON.stringify(body));
    };
    const respondRaw: RespondRaw = (status, raw, ct) => {
      res.writeHead(status, { 'content-type': ct });
      res.end(raw);
    };
    readBody(req)
      .then((body) => handleRequest(req.method ?? 'GET', url, req.headers.authorization, respond, body, respondRaw))
      .catch((err) => {
        logger.error({ err: String(err) }, 'broker request handler error');
        respond(500, errorBody('INTERNAL', 'Internal error.'));
      });
  });
}
