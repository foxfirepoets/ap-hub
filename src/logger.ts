import pino from 'pino';

/**
 * Structured logger with token/PII redaction (CHUNK_1 + Amendment A1 + Phase 0.5).
 *
 * Redaction covers: OAuth access/refresh tokens, the SwarmSync `ssk_` key prefix,
 * the Telegram bot token, and extracted bank/PII fields. Nothing sensitive is ever
 * written to a log line, even at debug.
 */

const SENSITIVE_KEYS = new Set(
  [
    'access_token',
    'refresh_token',
    'accesstoken',
    'refreshtoken',
    'authorization',
    'password',
    'client_secret',
    'clientsecret',
    'encryption_key',
    'anthropic_api_key',
    'swarmsync_api_key',
    'telegram_bot_token',
    'bot_token',
    'session_token',
    'sessiontoken',
    'token_hash',
    'tokenhash',
    'cookie',
    'set-cookie',
    'setcookie',
    'bank_info',
    'bankinfo',
    'bank',
    'bankrouting',
    'bankroutingnumber',
    'bankaccountnumber',
    'routing',
    'account_number',
    'ssn',
    'ein',
    'apikey',
    'api_key',
    'token',
    'secret',
  ].map((k) => k.toLowerCase()),
);

const TOKEN_PATTERNS: RegExp[] = [
  /\bssk_(live|test)_[A-Za-z0-9]+/g, // SwarmSync API keys
  /\bBearer\s+[A-Za-z0-9._-]+/gi, // bearer tokens
  /\b\d{6,}:[A-Za-z0-9_-]{20,}/g, // Telegram bot token form 123456:ABC...
  /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g, // JWT-ish
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
