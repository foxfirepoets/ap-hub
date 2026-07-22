import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Typed configuration loader.
 *
 * Guarantee (CHUNK_1 / brainstorm §9): QBO_ENV must be `sandbox`. A value of
 * `production` is rejected at config load with a descriptive error — there is no
 * code path in Phase 1/2 that can select production. This is enforcement, not
 * convention: the whole process refuses to boot.
 */

const boolish = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? def : v === 'true' || v === '1' || v === 'yes'));

const RawSchema = z.object({
  // --- Core ---
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  ENCRYPTION_KEY: z
    .string()
    .min(64, 'ENCRYPTION_KEY must be a 32-byte hex string (64 hex chars). Generate: openssl rand -hex 32'),
  ANTHROPIC_API_KEY: z.string().min(1, 'ANTHROPIC_API_KEY is required'),

  // --- Gmail (read-only in all phases; send scope added only for the gatekeeper relay) ---
  GMAIL_CLIENT_ID: z.string().min(1, 'GMAIL_CLIENT_ID is required'),
  GMAIL_CLIENT_SECRET: z.string().min(1, 'GMAIL_CLIENT_SECRET is required'),
  GMAIL_REDIRECT_URI: z.string().url().default('http://localhost:3000/oauth/gmail/callback'),
  WATCHED_LABEL: z.string().default('AP-Inbox'),

  // --- QBO (read-only lists in P1; SANDBOX writes in P2) ---
  QBO_ENV: z.string().default('sandbox'),
  QBO_MINOR_VERSION: z.string().default('73'),
  QBO_SANDBOX_CLIENT_ID: z.string().default(''),
  QBO_SANDBOX_CLIENT_SECRET: z.string().default(''),
  QBO_SANDBOX_REALM_ID: z.string().default(''),
  QBO_SANDBOX_COMPANY_NAME: z.string().default(''),
  QBO_SANDBOX_REDIRECT_URI: z.string().url().default('http://localhost:3000/oauth/qbo/callback'),

  // --- SwarmSync proof suite (Amendment A1) ---
  SWARMSYNC_API_BASE: z.string().url().default('https://api.swarmsync.ai'),
  SWARMSYNC_WEB_BASE: z.string().url().default('https://swarmsync.ai'),
  SWARMSYNC_API_KEY: z.string().default(''),

  // --- Phase 0.5 gatekeeper (proof-gated forwarding relay) ---
  GATEKEEPER_ENABLED: boolish(false),
  QBO_FORWARDING_ADDRESS: z.string().default(''),
  TELEGRAM_BOT_TOKEN: z.string().default(''),
  TELEGRAM_CHAT_ID: z.string().default(''),

  // --- QuickBooks Desktop via Web Connector (opt-in) ---
  // NOTE: this path talks to a REAL company file, so it deliberately OVERRIDES
  // the QBO sandbox-only guarantee. It is disabled by default and read-only by
  // default; real-books writes require QB_DESKTOP_MODE=write AND an explicit
  // enqueue. The QBO REST writer (src/qbo/write.ts) remains sandbox-only.
  QB_DESKTOP_ENABLED: boolish(false),
  QB_DESKTOP_MODE: z.enum(['readonly', 'write']).default('readonly'),
  QBWC_USERNAME: z.string().default('aphub'),
  QBWC_PASSWORD: z.string().default(''),

  // --- Thresholds / gates ---
  AUTO_THRESHOLD: z.coerce.number().min(0).max(1).default(0.9),
  REVIEW_THRESHOLD: z.coerce.number().min(0).max(1).default(0.6),
  AMOUNT_CEILING: z.coerce.number().nonnegative().default(10000),

  // --- Runtime ---
  POLL_INTERVAL_SECONDS: z.coerce.number().int().positive().default(180),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type Config = z.infer<typeof RawSchema> & { QBO_ENV: 'sandbox' };

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = RawSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new ConfigError(`Invalid configuration:\n${issues}`);
  }
  const cfg = parsed.data;

  // HARD REFUSE production. The value must be exactly 'sandbox'.
  if (cfg.QBO_ENV !== 'sandbox') {
    throw new ConfigError(
      `QBO_ENV="${cfg.QBO_ENV}" is refused. This build only ever writes to a QuickBooks ` +
        `SANDBOX company; there is no production write path. Set QBO_ENV=sandbox.`,
    );
  }

  // QuickBooks Desktop, when enabled, needs a Web Connector password (the QBWC
  // login the operator sets when importing the .QWC). Write mode is a loud,
  // deliberate choice — it is allowed here but the session/CLI still require an
  // explicit enqueue before anything touches the real company file.
  if (cfg.QB_DESKTOP_ENABLED && !cfg.QBWC_PASSWORD) {
    throw new ConfigError(
      'QB_DESKTOP_ENABLED=true but QBWC_PASSWORD is empty. Set the Web Connector password ' +
        '(the same one you enter when importing the .QWC into the Web Connector).',
    );
  }

  // Gatekeeper, when enabled, requires its full config (white-label: all per-tenant values are config).
  if (cfg.GATEKEEPER_ENABLED) {
    const missing: string[] = [];
    if (!cfg.QBO_FORWARDING_ADDRESS) missing.push('QBO_FORWARDING_ADDRESS');
    if (!cfg.TELEGRAM_BOT_TOKEN) missing.push('TELEGRAM_BOT_TOKEN');
    if (!cfg.TELEGRAM_CHAT_ID) missing.push('TELEGRAM_CHAT_ID');
    if (missing.length > 0) {
      throw new ConfigError(
        `GATEKEEPER_ENABLED=true but missing required gatekeeper config: ${missing.join(', ')}.`,
      );
    }
  }

  return cfg as Config;
}

let cached: Config | null = null;
export function config(): Config {
  if (!cached) cached = loadConfig();
  return cached;
}

/** Test helper — reset the memoized config. */
export function resetConfigCache(): void {
  cached = null;
}
