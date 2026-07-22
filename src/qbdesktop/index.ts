/**
 * QuickBooks Desktop (Web Connector) wiring — the opt-in seam.
 *
 * When QB_DESKTOP_ENABLED=true, this registers the /qbwc SOAP endpoint so the
 * Web Connector can drain the qbXML work queue against the open company file.
 * Everything stays read-only unless QB_DESKTOP_MODE=write AND a write item is
 * explicitly enqueued (session.ts enforces the guard). The QBO REST writer is
 * untouched and remains sandbox-only.
 */

import type { Config } from '../config.js';
import { logger } from '../logger.js';
import { registerRawRoute, readBody } from '../http.js';
import { handleQbwcSoap } from './soap.js';
import { enqueueForNextRun, type QbDesktopMode } from './session.js';
import { companyQueryRq, vendorQueryRq, accountQueryRq, billAddRq, type BillAddInput } from './qbxml.js';

export function qbDesktopMode(cfg: Config): QbDesktopMode {
  return cfg.QB_DESKTOP_MODE === 'write' ? 'write' : 'readonly';
}

/** Register the /qbwc SOAP endpoint. No-op unless QB_DESKTOP_ENABLED. */
export function registerQbDesktop(cfg: Config): void {
  if (!cfg.QB_DESKTOP_ENABLED) return;

  registerRawRoute(async (req, res, url) => {
    if (url.pathname !== '/qbwc') return false;
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'text/plain' });
      res.end('POST only');
      return true;
    }
    const body = await readBody(req);
    const out = handleQbwcSoap(body, {
      username: cfg.QBWC_USERNAME,
      password: cfg.QBWC_PASSWORD,
      mode: qbDesktopMode(cfg),
    });
    res.writeHead(out.status, { 'content-type': out.contentType });
    res.end(out.body);
    return true;
  });

  // Local control endpoint so the separate CLI process can drive the in-service
  // work queue. Guarded by the QBWC password (localhost pilot); never exposed
  // beyond the machine in normal single-operator use.
  registerRawRoute(async (req, res, url) => {
    if (url.pathname !== '/qbwc/control') return false;
    const send = (status: number, obj: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (req.method !== 'POST') { send(405, { error: 'POST only' }); return true; }
    if ((req.headers['x-qbwc-key'] ?? '') !== cfg.QBWC_PASSWORD) { send(401, { error: 'bad key' }); return true; }
    let payload: any = {};
    try { payload = JSON.parse((await readBody(req)) || '{}'); } catch { send(400, { error: 'bad json' }); return true; }
    try {
      switch (payload.action) {
        case 'verify':
          enqueueVerify();
          send(200, { ok: true, enqueued: 'company, vendors, accounts (read-only)' });
          return true;
        case 'bill':
          // enqueueBill throws WriteNotAllowedError when a session is read-only;
          // there may be no live session yet, so also refuse pre-queue in RO mode.
          if (qbDesktopMode(cfg) !== 'write') { send(409, { error: 'read-only mode; set QB_DESKTOP_MODE=write' }); return true; }
          enqueueBill(payload.bill);
          send(200, { ok: true, enqueued: `bill for ${payload.bill?.vendorName}` });
          return true;
        case 'status': {
          const { snapshotWork } = await import('./session.js');
          send(200, snapshotWork());
          return true;
        }
        default:
          send(400, { error: 'unknown action (verify|bill|status)' });
          return true;
      }
    } catch (err) {
      send(409, { error: (err as Error).message });
      return true;
    }
  });

  logger.info(
    { mode: qbDesktopMode(cfg), user: cfg.QBWC_USERNAME },
    'QuickBooks Desktop Web Connector endpoint registered at /qbwc',
  );
}

/** Build the .QWC config from the active configuration. */
export async function buildQwcFromConfig(cfg: Config, runEveryNMinutes = 0): Promise<string> {
  const { generateQwc } = await import('./qwc.js');
  const appUrl = `http://localhost:${cfg.PORT}/qbwc`;
  return generateQwc({
    appUrl,
    username: cfg.QBWC_USERNAME,
    mode: qbDesktopMode(cfg),
    runEveryNMinutes,
  });
}

/**
 * Enqueue a read-only verification query (safe in every mode). This is what the
 * wizard/CLI uses to confirm the connection works against the live company file.
 */
export function enqueueVerify(): void {
  enqueueForNextRun('verify: company', companyQueryRq('verify-company'));
  enqueueForNextRun('verify: vendors', vendorQueryRq('verify-vendors', 25));
  enqueueForNextRun('verify: accounts', accountQueryRq('verify-accounts'));
}

/**
 * Enqueue a real vendor bill. WRITE — refused by the session unless the active
 * session is in write mode. Callers (CLI) must be an explicit, deliberate action.
 */
export function enqueueBill(input: BillAddInput): void {
  enqueueForNextRun(`bill: ${input.vendorName}`, billAddRq(input, 'bill-' + (input.refNumber ?? 'x')));
}

export { getSession, resetSessions, type WorkItem } from './session.js';
