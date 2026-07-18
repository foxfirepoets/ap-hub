import { config } from './config.js';
import { logger } from './logger.js';

/**
 * Upstream callers for the two paid services the broker fronts: Anthropic and
 * SwarmSync (CHUNK_3). This module is where the broker's single most important
 * invariant lives:
 *
 *   THE BROKER MUST NEVER TURN AN UPSTREAM FAILURE INTO A SUCCESS.
 *
 * Every path here returns an `UpstreamResult`. On ANY error — network, timeout,
 * DNS, TLS, non-2xx, malformed body — the result carries `ok:false` and a NON-2xx
 * status. There is no code path that fabricates a 2xx, caches a prior success,
 * defaults to a pass, or "gracefully degrades" a proof result. A broker outage is
 * therefore indistinguishable, to the caller, from a SwarmSync outage — which is
 * exactly what guarantee 5 (fail-closed / hold-for-review) requires.
 */

export interface UpstreamResult {
  /** true ONLY when the upstream returned a real 2xx. */
  ok: boolean;
  /** HTTP status to relay to the caller. Never 2xx unless `ok` is true. */
  status: number;
  /** Raw response body (verbatim string). Relayed byte-for-byte on success. */
  body: string;
  /** Content-type to relay, if the upstream provided one. */
  contentType?: string;
  /** Parsed usage for spend estimation (Anthropic only), if present. */
  usage?: { input_tokens?: number; output_tokens?: number };
}

export type FetchLike = typeof fetch;

// Injectable fetch (tests provide a mock; production uses global fetch).
let fetchImpl: FetchLike = globalThis.fetch;
export function setFetchForTest(f: FetchLike): void {
  fetchImpl = f;
}
export function resetFetchForTest(): void {
  fetchImpl = globalThis.fetch;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Core guarded fetch. Returns an UpstreamResult; NEVER throws, NEVER returns a
 * 2xx it did not receive. A thrown fetch (network/DNS/TLS/timeout) becomes a 502.
 */
async function guardedFetch(
  url: string,
  init: RequestInit,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<UpstreamResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { ...init, signal: controller.signal });
    const body = await res.text();
    const contentType = res.headers.get('content-type') ?? undefined;
    if (res.status < 200 || res.status >= 300) {
      // Upstream said no. Relay a non-2xx; NEVER promote to success.
      logger.warn({ url, status: res.status }, 'upstream returned non-2xx');
      return { ok: false, status: 502, body, contentType };
    }
    return { ok: true, status: res.status, body, contentType };
  } catch (err) {
    // Network / DNS / TLS / timeout / abort → fail closed.
    logger.error({ url, err: String(err) }, 'upstream call failed (fail-closed → 502)');
    return { ok: false, status: 502, body: '', contentType: undefined };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Forward an Anthropic Messages request. The broker is a thin proxy: the caller
 * (ap-hub `getBrokerExtractor`) builds the full Messages request using the SAME
 * prompt path as the direct extractor, so the extraction/prompt logic lives in
 * exactly one place. The broker only injects the key and relays the response.
 */
export async function callAnthropic(requestBody: unknown): Promise<UpstreamResult> {
  const cfg = config();
  if (!cfg.ANTHROPIC_API_KEY) {
    // Misconfiguration is a broker fault, not a pass. Fail closed.
    logger.error('ANTHROPIC_API_KEY not configured on broker');
    return { ok: false, status: 502, body: '' };
  }
  const result = await guardedFetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': cfg.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(requestBody),
  });
  // Best-effort usage parse for spend estimation. A parse failure NEVER changes
  // ok/status — it only means we can't estimate cost precisely.
  if (result.ok) {
    try {
      const parsed = JSON.parse(result.body) as { usage?: UpstreamResult['usage'] };
      if (parsed.usage) result.usage = parsed.usage;
    } catch {
      /* no usage → flat estimate applied by caller */
    }
  }
  return result;
}

/**
 * Forward a SwarmSync request. `useWebBase` picks the public InvoiceProof host
 * ({webBase}/api/scan/invoices) vs the authed API host ({apiBase}/...). The
 * broker injects the ssk_ key on apiBase calls. Paths mirror SwarmSyncClient
 * exactly so ap-hub's client needs no change.
 */
export async function callSwarmSync(
  method: string,
  path: string,
  useWebBase: boolean,
  requestBody: unknown | undefined,
): Promise<UpstreamResult> {
  const cfg = config();
  const base = (useWebBase ? cfg.SWARMSYNC_WEB_BASE : cfg.SWARMSYNC_API_BASE).replace(/\/$/, '');
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  // Verify-API / AuditProof / chain-verify are on apiBase and need the ssk_ key.
  if (!useWebBase) {
    if (!cfg.SWARMSYNC_API_KEY) {
      logger.error('SWARMSYNC_API_KEY not configured on broker');
      return { ok: false, status: 502, body: '' };
    }
    headers.authorization = `Bearer ${cfg.SWARMSYNC_API_KEY}`;
  }
  const init: RequestInit = { method, headers };
  if (requestBody !== undefined && method !== 'GET') init.body = JSON.stringify(requestBody);
  return guardedFetch(`${base}${path}`, init);
}
