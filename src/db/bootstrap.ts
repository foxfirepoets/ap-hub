import { createServer } from 'node:net';

/**
 * CHUNK_2_DATABASE — choosing a port for the bundled PostgreSQL.
 *
 * The bundled instance must never collide with, connect to, or disturb a PostgreSQL the user
 * already runs. Two rules make that structural rather than conventional:
 *
 *   1. The search starts at 55432 and only moves upward, so the default 5432 is never
 *      reachable by the probe at all.
 *   2. 5432 is additionally refused outright, so a future change to the start port cannot
 *      quietly make the bundled server adopt a system instance's port. Belt and braces,
 *      because the failure this prevents is "two servers over one data directory", which
 *      corrupts rather than errors.
 *
 * OS-neutral by construction — no platform identifier appears here, so `lint:noleak` stays
 * green and the macOS path is the same code.
 */

/** Where the search begins. Chosen to sit well clear of PostgreSQL's default. */
export const PORT_PROBE_START = 55432;

/** Ports the bundled instance must never occupy, whatever the start value is. */
export const RESERVED_PORTS: readonly number[] = Object.freeze([5432]);

/** How many candidates to try before giving up. Bounded: exhaustion is a typed failure. */
export const PORT_PROBE_MAX_ATTEMPTS = 64;

/** Raised when no free port exists in the searched range. Surfaces to the user as DB_FAILED. */
export class PortRangeExhausted extends Error {
  readonly code = 'DB_FAILED';
  constructor(from: number, attempts: number) {
    super(`No free port found in ${attempts} candidates from ${from}`);
    this.name = 'PortRangeExhausted';
  }
}

/**
 * True when nothing holds the port on the loopback IPv4 address.
 *
 * Bound explicitly to 127.0.0.1 rather than to all interfaces, for two reasons: the bundled
 * server is started with `listen_addresses=127.0.0.1`, so IPv4 loopback is the only address
 * that matters; and binding 0.0.0.0 to test would briefly open a port on every interface,
 * which is precisely the non-loopback exposure the phase forbids.
 *
 * `exclusive` defeats SO_REUSEADDR, so a port genuinely in use by another process reports
 * busy instead of appearing bindable.
 */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen({ port, host: '127.0.0.1', exclusive: true });
  });
}

export interface ProbeOptions {
  from?: number;
  maxAttempts?: number;
  /** Injected for tests so the probe's ordering can be asserted without opening sockets. */
  isFree?: (port: number) => Promise<boolean>;
}

/**
 * Return the first free loopback port at or above `from`, skipping every reserved port.
 *
 * Returns a port; never a connection string, and never a port it did not itself verify free.
 * The caller records the result in `install.json` and `local_install.db_port` — the user is
 * never shown it.
 */
export async function probeFreePort(options: ProbeOptions = {}): Promise<number> {
  const from = options.from ?? PORT_PROBE_START;
  const maxAttempts = options.maxAttempts ?? PORT_PROBE_MAX_ATTEMPTS;
  const free = options.isFree ?? isPortFree;

  if (!Number.isInteger(from) || from < 1024 || from > 65535) {
    throw new RangeError('probe start port must be an integer between 1024 and 65535');
  }

  for (let i = 0; i < maxAttempts; i++) {
    const port = from + i;
    if (port > 65535) break;
    if (RESERVED_PORTS.includes(port)) continue;
    if (await free(port)) return port;
  }
  throw new PortRangeExhausted(from, maxAttempts);
}
