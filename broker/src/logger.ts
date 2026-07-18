import pino from 'pino';

/**
 * Broker structured logger with token redaction — mirrors ap-hub's `src/logger.ts`
 * approach. The broker must NEVER write a usable credential to a log line.
 *
 * Redaction covers: the per-install bearer token (`aph_` prefix), the SwarmSync
 * `ssk_` key prefix, and generic `Bearer …` headers, plus sensitive object keys.
 */

const SENSITIVE_KEYS = new Set(
  [
    'authorization',
    'token',
    'token_sha256',
    'tokensha256',
    'secret',
    'apikey',
    'api_key',
    'anthropic_api_key',
    'swarmsync_api_key',
    'password',
    'cookie',
    'set-cookie',
    'setcookie',
  ].map((k) => k.toLowerCase()),
);

const TOKEN_PATTERNS: RegExp[] = [
  /\baph_[A-Za-z0-9_-]+/g, // per-install broker tokens
  /\bssk_(live|test)_[A-Za-z0-9]+/g, // SwarmSync API keys
  /\bsk-ant-[A-Za-z0-9_-]+/g, // Anthropic keys
  /\bBearer\s+[A-Za-z0-9._-]+/gi, // bearer tokens
];

export function redactString(input: string): string {
  let out = input;
  for (const re of TOKEN_PATTERNS) out = out.replace(re, '[REDACTED]');
  return out;
}

/** Deep-redact an arbitrary value for safe logging. */
export function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value as object)) return '[Circular]';
  seen.add(value as object);

  if (Array.isArray(value)) return value.map((v) => redact(v, seen));

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.has(k.toLowerCase())) {
      out[k] = '[REDACTED]';
    } else {
      out[k] = redact(v, seen);
    }
  }
  return out;
}

function level(): pino.Level {
  const l = process.env.LOG_LEVEL as pino.Level | undefined;
  return l ?? 'info';
}

const base = pino({
  level: level(),
  formatters: {
    log(obj: Record<string, unknown>) {
      return redact(obj) as Record<string, unknown>;
    },
  },
  redact: {
    paths: Array.from(SENSITIVE_KEYS),
    censor: '[REDACTED]',
  },
});

export type Logger = pino.Logger;
export const logger: Logger = base;

export function childLogger(bindings: Record<string, unknown>): Logger {
  return base.child(redact(bindings) as Record<string, unknown>);
}
