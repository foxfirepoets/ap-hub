/**
 * QuickBooks Desktop (Web Connector) wiring — the opt-in seam.
 *
 * When QB_DESKTOP_ENABLED=true, this registers the /qbwc SOAP endpoint so the
 * Web Connector can drain the qbXML work queue against the open company file.
 * This build exposes read-only verification only. Real-company write controls
 * are intentionally not registered.
 */

import type { Config } from '../config.js';
import { logger } from '../logger.js';
import { registerRawRoute, readBody } from '../http.js';
import { handleQbwcSoap } from './soap.js';
import { enqueueForNextRun, type QbDesktopMode } from './session.js';
import { companyQueryRq, vendorQueryRq, accountQueryRq } from './qbxml.js';

export function qbDesktopMode(_cfg: Config): QbDesktopMode {
  return 'readonly';
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
    // Larger cap than the default: a receiveResponseXML body carries the full
    // qbXML response (whole vendor/account lists), which inflates when XML-escaped.
    const body = await readBody(req, 64 * 1024 * 1024);
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
        case 'status': {
          const { snapshotWork } = await import('./session.js');
          send(200, snapshotWork());
          return true;
        }
        default:
          send(400, { error: 'unknown action (verify|status)' });
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

export { getSession, resetSessions, type WorkItem } from './session.js';
