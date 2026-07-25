import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { query } from './db/pool.js';
import { logger } from './logger.js';

export interface OperationalHealth {
  providerJobs: {
    queued: number;
    oldestQueuedSeconds: number | null;
    expiredLeases: number;
    resultUnknown: number;
    failed: number;
    held: number;
  };
  statements: { held: number; unbalanced: number };
  drafts: { failed: number; resultUnknown: number };
}

type HealthQuery = <T extends Record<string, unknown>>(
  sql: string,
  params?: unknown[],
) => Promise<{ rows: T[] }>;

function numeric(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Aggregate counts only: no tenant data, payloads, addresses, or provider secrets. */
export async function collectOperationalHealth(
  runQuery: HealthQuery = query as HealthQuery,
): Promise<OperationalHealth> {
  const provider = await runQuery<Record<string, unknown>>(
    `SELECT
       count(*) FILTER (WHERE status='queued')::int AS queued,
       extract(epoch FROM (now()-min(created_at) FILTER (WHERE status='queued')))::int AS oldest_queued_seconds,
       count(*) FILTER (WHERE status='leased' AND lease_expires_at < now())::int AS expired_leases,
       count(*) FILTER (WHERE error_code='PROVIDER_RESULT_UNKNOWN')::int AS result_unknown,
       count(*) FILTER (WHERE status='failed')::int AS failed,
       count(*) FILTER (WHERE status='held')::int AS held
     FROM provider_jobs`,
  );
  const statements = await runQuery<Record<string, unknown>>(
    `SELECT count(*) FILTER (WHERE status='held')::int AS held,
            count(*) FILTER (WHERE status='unbalanced')::int AS unbalanced
       FROM bank_statements`,
  );
  const drafts = await runQuery<Record<string, unknown>>(
    `SELECT count(*) FILTER (WHERE status='proposed' AND reason IS NOT NULL)::int AS failed,
            count(*) FILTER (WHERE status='result_unknown')::int AS result_unknown
       FROM reply_drafts`,
  );
  const p = provider.rows[0] ?? {};
  const s = statements.rows[0] ?? {};
  const d = drafts.rows[0] ?? {};
  return {
    providerJobs: {
      queued: numeric(p.queued),
      oldestQueuedSeconds: p.oldest_queued_seconds == null ? null : numeric(p.oldest_queued_seconds),
      expiredLeases: numeric(p.expired_leases),
      resultUnknown: numeric(p.result_unknown),
      failed: numeric(p.failed),
      held: numeric(p.held),
    },
    statements: { held: numeric(s.held), unbalanced: numeric(s.unbalanced) },
    drafts: { failed: numeric(d.failed), resultUnknown: numeric(d.result_unknown) },
  };
}

/**
 * Minimal HTTP server: /health liveness probe (db + queue status) plus OAuth
 * callback routes registered by CHUNK_2. No framework — one small handler.
 */

export type Route = (
  method: string,
  url: URL,
  respond: (status: number, body: unknown) => void,
  redirect: (location: string) => void,
  req: IncomingMessage,
) => boolean | Promise<boolean>;

const routes: Route[] = [];

export function registerRoute(route: Route): void {
  routes.push(route);
}

/**
 * A raw route gets the underlying req/res so it can read the request body and
 * write a non-JSON content-type. Used by the QuickBooks Web Connector SOAP
 * endpoint (XML in, XML out). Return true if it handled the request.
 */
export type RawRoute = (
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
) => boolean | Promise<boolean>;

const rawRoutes: RawRoute[] = [];

export function registerRawRoute(route: RawRoute): void {
  rawRoutes.push(route);
}

export class RequestBodyError extends Error {
  constructor(
    readonly status: 408 | 413,
    message: string,
  ) {
    super(message);
    this.name = 'RequestBodyError';
  }
}

/** Read a request body to a string with byte and slow-client bounds. */
export function readBody(
  req: IncomingMessage,
  maxBytes = 8 * 1024 * 1024,
  timeoutMs = 15_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new RequestBodyError(408, 'request body timed out'))),
      timeoutMs,
    );
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        finish(() => reject(new RequestBodyError(413, 'request body too large')));
        return;
      }
      if (!settled) chunks.push(c);
    });
    req.on('end', () => finish(() => resolve(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', (err) => finish(() => reject(err)));
  });
}

export function createHttpServer(): Server {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost`);
    const respond = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const redirect = (location: string) => {
      res.writeHead(302, { Location: location });
      res.end();
    };

    // Raw routes first (they own the response, incl. content-type + body).
    for (const raw of rawRoutes) {
      try {
        if (await raw(req, res, url)) return;
      } catch (err) {
        logger.error({ err: String(err) }, 'raw route handler error');
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'text/plain' });
          res.end('internal_error');
        }
        return;
      }
    }

    if (url.pathname === '/health') {
      let db = false;
      try {
        await query('SELECT 1');
        db = true;
      } catch {
        db = false;
      }
      respond(db ? 200 : 503, {
        status: db ? 'ok' : 'degraded',
        db,
        queue: true,
      });
      return;
    }

    for (const route of routes) {
      try {
        if (await route(req.method ?? 'GET', url, respond, redirect, req)) return;
      } catch (err) {
        logger.error({ err: String(err) }, 'route handler error');
        respond(500, { error: 'internal_error' });
        return;
      }
    }

    respond(404, { error: 'not_found' });
  });
}
