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

  // --- LLM backend (provider-agnostic) ---
  // ap-hub works with WHATEVER LLM the operator has: a local runtime (Ollama /
  // LM Studio), any OpenAI-compatible API (LLM_BASE_URL), a cloud key, or — with
  // an explicit LLM_PROVIDER=claude|codex|gemini — a local CLI. No key is
  // required at boot in ANY mode (including BROKER MODE below); the provider is
  // resolved at extraction time (see src/llm/provider.ts, ExtractorNotConfiguredError).
  ANTHROPIC_API_KEY: z.string().default(''),
  OPENAI_API_KEY: z.string().default(''),
  LLM_PROVIDER: z.string().default('auto'), // auto | anthropic | openai | ollama | lmstudio | custom | claude | codex | gemini
  LLM_BASE_URL: z.string().default(''), // an OpenAI-compatible endpoint (…/v1)
  LLM_API_KEY: z.string().default(''), // key for LLM_BASE_URL (blank for local)
  LLM_MODEL: z.string().default(''), // model id; blank = provider default / first available

  // --- Gmail (read-only in all phases; send scope added only for the gatekeeper relay) ---
  GMAIL_CLIENT_ID: z.string().min(1, 'GMAIL_CLIENT_ID is required'),
  GMAIL_CLIENT_SECRET: z.string().min(1, 'GMAIL_CLIENT_SECRET is required'),
  GMAIL_REDIRECT_URI: z.string().url().default('http://localhost:3001/oauth/gmail/callback'),
  WATCHED_LABEL: z.string().default('AP-Inbox'),
  // Resource-exhaustion guard (FIX-F8): attachments larger than this are skipped, not
  // fetched/stored. Default matches Gmail's own per-message attachment ceiling (25MB).
  MAX_ATTACHMENT_BYTES: z.coerce.number().int().positive().default(25 * 1024 * 1024),

  // --- QBO (read-only lists in P1; SANDBOX writes in P2) ---
  QBO_ENV: z.string().default('sandbox'),
  QBO_MINOR_VERSION: z.string().default('73'),
  QBO_SANDBOX_CLIENT_ID: z.string().default(''),
  QBO_SANDBOX_CLIENT_SECRET: z.string().default(''),
  QBO_SANDBOX_REALM_ID: z.string().default(''),
  QBO_SANDBOX_COMPANY_NAME: z.string().default(''),
  QBO_SANDBOX_REDIRECT_URI: z.string().url().default('http://localhost:3001/oauth/qbo/callback'),

  // --- SwarmSync proof suite (Amendment A1) ---
  // SwarmSync proof suite (InvoiceProof fraud scan · Verify-API notarization ·
  // AuditProof anchoring) is OPTIONAL. Enabled by default (existing behavior).
  // When disabled, no proof calls are made and invoices are capped at review.
  // Absence of a verifier is never treated as successful verification.
  SWARMSYNC_ENABLED: boolish(true),
  SWARMSYNC_OFF_MODE: z.literal('review').default('review'),
  SWARMSYNC_API_BASE: z.string().url().default('https://api.swarmsync.ai'),
  SWARMSYNC_WEB_BASE: z.string().url().default('https://swarmsync.ai'),
  SWARMSYNC_API_KEY: z.string().default(''),

  // --- Key broker (CHUNK_4): when BROKER_BASE_URL is set, ap-hub runs in BROKER
  // MODE — Claude + SwarmSync(verify/proof) calls go through the broker, which
  // holds the keys, and no ANTHROPIC/SWARMSYNC key need live on this machine.
  BROKER_BASE_URL: z.string().url().optional(),
  BROKER_INSTALL_TOKEN: z.string().default(''),

  // --- Phase 0.5 gatekeeper (proof-gated forwarding relay) ---
  GATEKEEPER_ENABLED: boolish(false),
  QBO_FORWARDING_ADDRESS: z.string().default(''),
  TELEGRAM_BOT_TOKEN: z.string().default(''),
  TELEGRAM_CHAT_ID: z.string().default(''),

  // --- QuickBooks Desktop via Web Connector (opt-in) ---
  // NOTE: this path talks to a REAL company file, so it deliberately OVERRIDES
  // the QBO sandbox-only guarantee. It is disabled by default and read-only by
  // default. Real-books writes are deliberately unavailable in this build.
  QB_DESKTOP_ENABLED: boolish(false),
  QB_DESKTOP_MODE: z.literal('readonly').default('readonly'),
  QBWC_USERNAME: z.string().default('aphub'),
  QBWC_PASSWORD: z.string().default(''),

  // --- Thresholds / gates ---
  AUTO_THRESHOLD: z.coerce.number().min(0).max(1).default(0.9),
  REVIEW_THRESHOLD: z.coerce.number().min(0).max(1).default(0.6),
  AMOUNT_CEILING: z.coerce.number().nonnegative().default(10000),

  // --- Human UX auth (CHUNK_1_AUTH): Google SSO + tenant-scoped sessions ---
  GOOGLE_SSO_CLIENT_ID: z.string().min(1, 'GOOGLE_SSO_CLIENT_ID is required'),
  GOOGLE_SSO_CLIENT_SECRET: z.string().min(1, 'GOOGLE_SSO_CLIENT_SECRET is required'),
  SESSION_COOKIE_SECRET: z
    .string()
    .min(32, 'SESSION_COOKIE_SECRET must be at least 32 characters; generate a random value'),
  SESSION_TTL_HOURS: z.coerce.number().positive().default(12),
  WEB_BASE_URL: z.string().url().default('http://localhost:3000'),

  // --- Runtime ---
  POLL_INTERVAL_SECONDS: z.coerce.number().int().positive().default(180),
  PORT: z.coerce.number().int().positive().default(3001),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type Config = z.infer<typeof RawSchema> & { QBO_ENV: 'sandbox' };

/** SwarmSync operating mode derived from config. */
export type SwarmSyncMode = 'on' | 'off_review';
export function swarmSyncMode(cfg: Config): SwarmSyncMode {
  if (cfg.SWARMSYNC_ENABLED) return 'on';
  return 'off_review';
}

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

  // Broker URL, when set, must be https — except http://127.0.0.1 for local tests.
  if (cfg.BROKER_BASE_URL) {
    const isHttps = cfg.BROKER_BASE_URL.startsWith('https://');
    const isLocalTest = cfg.BROKER_BASE_URL.startsWith('http://127.0.0.1');
    if (!isHttps && !isLocalTest) {
      throw new ConfigError(
        `BROKER_BASE_URL must be https:// (or http://127.0.0.1 in tests); got "${cfg.BROKER_BASE_URL}".`,
      );
    }
  }
  // No boot-time key requirement outside broker mode: src/llm/provider.ts
  // resolves a local runtime, an OpenAI-compatible endpoint, a cloud key, or an
  // explicitly-chosen CLI at extraction time, and throws LlmNotConfiguredError
  // (surfaced as a typed exceptions row, never a bare boot refusal) if none apply.

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
