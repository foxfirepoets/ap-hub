import { createServer, type Server } from 'node:http';
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
) => boolean | Promise<boolean>;

const routes: Route[] = [];

export function registerRoute(route: Route): void {
  routes.push(route);
}

export function createHttpServer(): Server {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost`);
    const respond = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

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
        if (await route(req.method ?? 'GET', url, respond)) return;
      } catch (err) {
        logger.error({ err: String(err) }, 'route handler error');
        respond(500, { error: 'internal_error' });
        return;
      }
    }

    respond(404, { error: 'not_found' });
  });
}
