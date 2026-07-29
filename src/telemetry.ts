/**
 * Liveness telemetry (CHUNK_6: hosted-dependency removal). There is no hosted
 * BookScout OS URL to report to, so this is a local-only no-op: it never makes a
 * network call and never throws. Kept as a stable call site (rather than
 * deleted outright) so any future local-only liveness logging has a home
 * without touching every caller.
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

/** No-op: always resolves false, never contacts a network endpoint. */
export async function sendHeartbeat(_input: HeartbeatInput, _deps: HeartbeatDeps = {}): Promise<boolean> {
  return false;
}
