import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { query } from './db/pool.js';
import { logger } from './logger.js';

/**
 * Minimal HTTP server: /health liveness probe (db + queue status) plus OAuth
 * callback routes registered by CHUNK_2. No framework — one small handler.
 */

export type Route = (
  method: string,
  url: URL,
  respond: (status: number, body: unknown) => void,
  redirect: (location: string) => void,
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

/** Read a request body to a string (bounded), for raw routes. */
export function readBody(req: IncomingMessage, maxBytes = 8 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
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
      respond(db ? 200 : 503, { status: db ? 'ok' : 'degraded', db, queue: true });
      return;
    }

    for (const route of routes) {
      try {
        if (await route(req.method ?? 'GET', url, respond, redirect)) return;
      } catch (err) {
        logger.error({ err: String(err) }, 'route handler error');
        respond(500, { error: 'internal_error' });
        return;
      }
    }

    respond(404, { error: 'not_found' });
  });
}
