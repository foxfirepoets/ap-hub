import { config } from './config.js';
import { logger } from './logger.js';

/**
 * Liveness telemetry client (CHUNK_6). Sends heartbeats to the broker's
 * `/v1/heartbeat`. Two hard rules:
 *
 *  1. NEVER blocks or crashes the pipeline. Every failure (broker down, timeout, no
 *     broker configured) is logged `warn` and swallowed — the return value is a boolean,
 *     it never throws. CHUNK_7's supervisor calls this on a timer and must be immune to it.
 *  2. NEVER sends business data. `detail` is a short status code only; the broker strips
 *     anything that is not a safe code, but we keep it disciplined on the client too.
 */

export type HeartbeatEvent = 'alive' | 'watchdog_restart' | 'pg_health' | 'shutdown';

export interface HeartbeatInput {
  event: HeartbeatEvent;
  pgOk?: boolean;
  detail?: string;
}

export interface HeartbeatDeps {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
}

/** Local tz offset in minutes as stored (positive = ahead of UTC), matching the broker column. */
function tzOffsetMinutes(now: Date): number {
  // getTimezoneOffset returns minutes behind UTC (positive for west); negate to store "ahead".
  return -now.getTimezoneOffset();
}

export async function sendHeartbeat(input: HeartbeatInput, deps: HeartbeatDeps = {}): Promise<boolean> {
  const cfg = config();
  if (!cfg.BROKER_BASE_URL || !cfg.BROKER_INSTALL_TOKEN) {
    // No broker configured (direct mode) — telemetry is a no-op, never an error.
    return false;
  }
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as typeof fetch);
  const now = (deps.now ?? (() => new Date()))();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? 5000);
  try {
    const res = await fetchImpl(`${cfg.BROKER_BASE_URL.replace(/\/$/, '')}/v1/heartbeat`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${cfg.BROKER_INSTALL_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        event: input.event,
        pg_ok: input.pgOk,
        detail: input.detail,
        tz_offset_minutes: tzOffsetMinutes(now),
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      logger.warn({ status: res.status, event: input.event }, 'heartbeat rejected by broker (dropped)');
      return false;
    }
    return true;
  } catch (err) {
    // Broker unreachable / timeout / abort — drop it silently (warn only). The pipeline
    // MUST NOT care whether telemetry landed.
    logger.warn({ err: String(err), event: input.event }, 'heartbeat send failed (dropped, pipeline unaffected)');
    return false;
  } finally {
    clearTimeout(timer);
  }
}
