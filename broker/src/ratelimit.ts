/**
 * Per-install in-memory sliding-window rate limiter (CHUNK_3, SPEC §7/§8).
 *
 * Scale is 3–5 installs; an in-process window is sufficient and needs no store.
 * A limiter failure must never fail OPEN — but there is no external dependency
 * here to fail, so the only outcomes are "allowed" or "limited".
 *
 * Keyed by (installId, bucket) so proxy calls (60/min) and heartbeats (5/min,
 * CHUNK_6) are limited independently.
 */

const hits = new Map<string, number[]>();

export interface RateDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

export function checkRateLimit(
  installId: string,
  bucket: string,
  limit: number,
  windowMs: number,
  now: number = Date.now(),
): RateDecision {
  const key = `${installId}:${bucket}`;
  const cutoff = now - windowMs;
  const recent = (hits.get(key) ?? []).filter((t) => t > cutoff);
  if (recent.length >= limit) {
    const oldest = recent[0] ?? now;
    const retryAfterSeconds = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
    hits.set(key, recent);
    return { allowed: false, retryAfterSeconds };
  }
  recent.push(now);
  hits.set(key, recent);
  return { allowed: true, retryAfterSeconds: 0 };
}

/** Test helper — clear all windows. */
export function resetRateLimitForTest(): void {
  hits.clear();
}
