/**
 * CHUNK_3_IPC — the closed error-code set and its plain-language messages.
 *
 * Implements `docs/build/interfaces/ipc-error-contract.md` §2 and §3.
 *
 * Two properties make this module load-bearing rather than cosmetic:
 *
 *  1. The service families are OPEN. `ServiceError.code` is a free-form string
 *     (`src/services/index.ts:42-49`) and every wrapper uppercases it, so the codes crossing
 *     the bridge are unbounded unless something closes them. `normalizeCode` is that
 *     something, and it fails CLOSED: a code it has never heard of becomes `INTERNAL`,
 *     because an unreviewed code is a code whose text has not been checked for provider
 *     content.
 *
 *  2. The message is LOOKED UP, never forwarded. Service messages interpolate arbitrary
 *     text — a raw driver error at `src/services/taxMappings.ts:259`, the caller's own value
 *     at `src/services/dimensionMappings.ts:50`. Forwarding any of them would break
 *     `.ralph/guardrails.md:96` ("no raw provider errors, stack traces, or error codes in the
 *     UI") and `specs/03_CHUNK_3_IPC.md:24`. There is no code path in this module that can
 *     emit a string it did not author.
 *
 * No message names a channel, a table, a file, a port, a field or a code —
 * `desktop/preload.ts:28` sets that rule for the refused-channel path and the dispatcher
 * matches it, so a probing renderer cannot tell "this channel does not exist" from
 * "this channel failed".
 */

/** The complete set of codes the renderer may ever see. Closed on purpose. */
export const IPC_ERROR_CODES = [
  'UNAUTHENTICATED',
  'SESSION_EXPIRED',
  'FORBIDDEN',
  'NOT_FOUND',
  'VALIDATION',
  'CONFLICT',
  'ALREADY_POSTED',
  'QBO_RETRY',
  'DB_STARTING',
  'DB_FAILED',
  'PROVIDER_OFFLINE',
  'PROVIDER_REAUTH',
  'CONNECT_TIMEOUT',
  'SECURE_STORE',
  'INTERNAL',
] as const;

export type IpcErrorCode = (typeof IPC_ERROR_CODES)[number];

/**
 * Codes that survive normalization unchanged.
 *
 * `ALREADY_POSTED` deliberately does NOT collapse into `CONFLICT`: it is the visible face of
 * guarantee 4 (no double-post) and `src/services/action/index.ts:137` documents it as such.
 * `SESSION_EXPIRED` deliberately does not collapse into `UNAUTHENTICATED` either — the
 * renderer treats both as "go to login" (`app/lib/session.tsx:36-39`), but the audit trail
 * and the contract tests need the distinction.
 */
const PASS_THROUGH: ReadonlySet<string> = new Set<IpcErrorCode>(IPC_ERROR_CODES);

/** Service and route codes with a deliberate destination. Each cites where it is produced. */
const EXPLICIT: Readonly<Record<string, IpcErrorCode>> = Object.freeze({
  // Provider reachability and consent.
  GMAIL_RECONNECT_REQUIRED: 'PROVIDER_REAUTH', // src/reply-drafts/http.ts:25
  GMAIL_COMPOSE_SCOPE_REQUIRED: 'PROVIDER_REAUTH', // src/gmail/drafts.ts:49
  DRAFT_RETRY: 'PROVIDER_OFFLINE', // src/gmail/drafts.ts:57
  DRAFT_RESULT_UNKNOWN: 'PROVIDER_OFFLINE', // src/gmail/drafts.ts:66
  // Conflicts the screens branch on by status 409.
  UNSAFE_RETRY: 'CONFLICT', // app/api/provider-jobs/[id]/retry/route.ts:19
  REPLY_DRAFT_EXISTS: 'CONFLICT', // src/reply-drafts/service.ts:239
  REPLY_DRAFT_ALREADY_SENT: 'CONFLICT', // src/reply-drafts/service.ts:277
  REPLY_DRAFT_DISCARDED: 'CONFLICT', // src/reply-drafts/service.ts:278
  REPLY_DRAFT_CONFLICT: 'CONFLICT', // src/reply-drafts/service.ts:310
  // Validation-shaped, whatever status they arrive with.
  INVALID_ID: 'VALIDATION', // app/api/provider-jobs/[id]/retry/route.ts:13
  SOURCE_MESSAGE_MISSING: 'VALIDATION', // src/services/action/index.ts:87 (422)
  DRY_RUN_LOCKED: 'FORBIDDEN', // src/services/action/index.ts:86 (403)
  READ_BACK_FAILED: 'INTERNAL', // src/services/action/taxMappings.ts:32 (500)
});

/**
 * Map a service code onto the closed set.
 *
 * The status is NOT touched. `SOURCE_MESSAGE_MISSING` still arrives as 422 and
 * `DRY_RUN_LOCKED` still as 403; the envelope carries the normalized code alongside the
 * original status so screens that branch on status keep working.
 */
export function normalizeCode(raw: unknown): IpcErrorCode {
  if (typeof raw !== 'string' || raw === '') return 'INTERNAL';
  if (PASS_THROUGH.has(raw)) return raw as IpcErrorCode;
  const explicit = EXPLICIT[raw];
  if (explicit !== undefined) return explicit;
  // The whole `ServiceError` *_not_found family — src/services/action/index.ts:82.
  if (raw.endsWith('_NOT_FOUND')) return 'NOT_FOUND';
  return 'INTERNAL';
}

/**
 * One plain-language sentence per code, each with a next action. The user is non-technical
 * (`CLAUDE.md`, Conventions), so no code name, channel name, field name or jargon appears.
 *
 * The `INTERNAL` string is verbatim from `desktop/preload.ts:43` so the refused-channel path
 * and the dispatcher's fallback are indistinguishable to the renderer.
 */
const MESSAGES: Readonly<Record<IpcErrorCode, string>> = Object.freeze({
  UNAUTHENTICATED: 'You are signed out. Sign in to continue.',
  SESSION_EXPIRED: 'Your sign-in has timed out. Sign in again to continue.',
  FORBIDDEN: 'Your account does not have permission to do that. Ask the account owner.',
  NOT_FOUND: 'AP-Hub could not find that item. It may have been removed.',
  VALIDATION: 'Some required details are missing or not valid. Check the highlighted fields and try again.',
  CONFLICT: 'Someone else changed this item first. Reload it and try again.',
  ALREADY_POSTED:
    'This has already been sent to your accounting system, so AP-Hub did not send it again.',
  QBO_RETRY:
    'Your accounting system did not respond. Nothing was recorded, so you can safely try again.',
  DB_STARTING: 'AP-Hub is still starting up. This usually takes a few seconds — try again shortly.',
  DB_FAILED: 'AP-Hub cannot open your data right now. Restart AP-Hub, and if it happens again use Repair.',
  PROVIDER_OFFLINE: 'AP-Hub could not reach that service. Check your internet connection and try again.',
  PROVIDER_REAUTH:
    'AP-Hub needs your permission again before it can continue. Reconnect the account in Settings.',
  CONNECT_TIMEOUT: 'That sign-in took too long. Let\'s try again.',
  SECURE_STORE:
    'AP-Hub could not read your saved sign-in details on this computer. Restart AP-Hub and try again.',
  INTERNAL: 'AP-Hub could not complete that action.',
});

/** The plain-language sentence for a normalized code. Total over the closed set. */
export function plainMessage(code: IpcErrorCode): string {
  return MESSAGES[code];
}

/** True for a member of the closed set. Used by the contract tests, not by the hot path. */
export function isIpcErrorCode(value: unknown): value is IpcErrorCode {
  return typeof value === 'string' && PASS_THROUGH.has(value);
}
