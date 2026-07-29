// Pure error-code → plain-English mapper for the onboarding wizard's failure panel.
// No DOM/React/fetch/DB — a presentational helper only, unit-testable in isolation.
// CHUNK_5 wires this into every step/dry-run/approve failure path.
//
// CHUNK_6_CLEANUP — every code below mirrors `IPC_ERROR_CODES` in `desktop/ipc/errors.ts`, the
// CLOSED set of codes `window.aphub.invoke` can ever resolve to: `desktop/ipc/envelope.ts`'s
// `decode()` runs every service/route error through `normalizeCode` and replaces its message
// with `plainMessage(code)` (`envelope.ts:164-169`) BEFORE the result ever reaches this file, so
// both arguments below are already closed/pre-sanitized by construction. This file does not
// import `desktop/ipc/**` (renderer code stays out of that graph — same reasoning as
// `app/lib/aphub-bridge.d.ts`'s parallel `IpcResult` declaration); `ONBOARDING_ERROR_CODES`
// mirrors it instead, and `test/error-mapping.test.ts` imports the real set to prove the mirror
// hasn't drifted.
//
// `fallbackMessage` is intentionally never rendered by this function. Even though the invariant
// above means it is always already-safe text, this function treats it as untrusted so a future
// bypass of that invariant can never resurface a raw provider string, stack trace, error code,
// port, env var or SQL text in front of the non-technical user (CLAUDE.md, .ralph/guardrails.md).
// There used to be a `default` branch here that rendered it directly
// (`Something went wrong on that step. Details: ${fallbackMessage}`) — deleted for exactly that
// reason; every code below now gets a specific, fixed sentence instead.

export interface FriendlyOnboardingError {
  text: string;
  retryable: boolean;
}

/**
 * Mirrors `IPC_ERROR_CODES` in `desktop/ipc/errors.ts`. `DRY_RUN_LOCKED` is deliberately absent:
 * `normalizeCode` maps it onto `FORBIDDEN` before it ever crosses the bridge
 * (`desktop/ipc/errors.ts:76`), so it can never arrive here as its own code.
 */
export const ONBOARDING_ERROR_CODES = [
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
  'RESTORE_FAILED',
  'BACKUP_KEY_MISSING',
  'BACKUP_FAILED',
  'DISK_FULL',
  'INTERNAL',
] as const;

export type OnboardingErrorCode = (typeof ONBOARDING_ERROR_CODES)[number];

function isOnboardingErrorCode(code: string): code is OnboardingErrorCode {
  return (ONBOARDING_ERROR_CODES as readonly string[]).includes(code);
}

// Fixed and generic on purpose — never built from `code` or `fallbackMessage`, so there is
// nothing here for a provider string, stack trace or raw code to hide inside. Reached only if a
// code outside the closed set above somehow arrives (should not happen — see file header).
const GENERIC_FALLBACK: FriendlyOnboardingError = {
  text: 'Something went wrong on that step. Try again, and if it keeps happening, restart BookScout OS.',
  retryable: true,
};

/**
 * Exhaustive over `OnboardingErrorCode`. If `desktop/ipc/errors.ts` ever adds a code to its
 * closed set without a matching case here, the `never` assignment in `default` fails
 * `tsc --noEmit` — a build break, not a silent raw-string leak at runtime.
 */
function mapKnownCode(code: OnboardingErrorCode): FriendlyOnboardingError {
  switch (code) {
    case 'VALIDATION':
      return {
        text: "That step isn't available yet — finish the current step first, then try again.",
        retryable: true,
      };
    case 'FORBIDDEN':
      return {
        text: 'Only the account owner can change setup.',
        retryable: false,
      };
    case 'UNAUTHENTICATED':
      return {
        text: 'Your session expired — sign in again to continue where you left off.',
        retryable: false,
      };
    case 'SESSION_EXPIRED':
      return {
        text: 'Your sign-in has timed out — sign in again to continue where you left off.',
        retryable: false,
      };
    case 'NOT_FOUND':
      return {
        text: "BookScout OS couldn't find that item — it may already have been removed or handled.",
        retryable: false,
      };
    case 'CONFLICT':
      return {
        text: 'Someone else already changed this. Reload and try again.',
        retryable: true,
      };
    case 'ALREADY_POSTED':
      return {
        text: 'This was already sent to your accounting system, so BookScout OS did not send it again.',
        retryable: false,
      };
    case 'QBO_RETRY':
      return {
        text: "Your accounting system didn't respond in time. Nothing was recorded, so it's safe to try again.",
        retryable: true,
      };
    case 'DB_STARTING':
      return {
        text: 'BookScout OS is still starting up — this usually takes a few seconds. Try again shortly.',
        retryable: true,
      };
    case 'DB_FAILED':
      return {
        text: 'BookScout OS cannot open your data right now. Restart BookScout OS, and use Repair if this keeps happening.',
        retryable: false,
      };
    case 'PROVIDER_OFFLINE':
      return {
        text: 'BookScout OS could not reach that service. Check your internet connection and try again.',
        retryable: true,
      };
    case 'PROVIDER_REAUTH':
      return {
        text: 'BookScout OS needs your permission again before it can continue — reconnect the account in Settings.',
        retryable: false,
      };
    case 'CONNECT_TIMEOUT':
      return {
        text: "That sign-in took too long. Let's try again.",
        retryable: true,
      };
    case 'SECURE_STORE':
      return {
        text: 'BookScout OS could not read your saved sign-in details on this computer. Restart BookScout OS and try again.',
        retryable: false,
      };
    case 'RESTORE_FAILED':
      return {
        text: 'BookScout OS could not restore that backup. Your current data was not changed.',
        retryable: true,
      };
    case 'BACKUP_KEY_MISSING':
      return {
        text: 'BookScout OS could not find the secure key needed to read your backups on this computer.',
        retryable: false,
      };
    case 'BACKUP_FAILED':
      return {
        text: 'BookScout OS could not complete that backup.',
        retryable: true,
      };
    case 'DISK_FULL':
      return {
        text: 'BookScout OS paused because your disk is full. Free up space, then try again.',
        retryable: true,
      };
    case 'INTERNAL':
      return {
        text: 'Something went wrong on that step. Try again, and if it keeps happening, restart BookScout OS.',
        retryable: true,
      };
    default: {
      const exhaustiveCheck: never = code;
      return exhaustiveCheck;
    }
  }
}

export function friendlyOnboardingError(code: string, _fallbackMessage: string): FriendlyOnboardingError {
  return isOnboardingErrorCode(code) ? mapKnownCode(code) : GENERIC_FALLBACK;
}

// CHUNK_5_PAGEREDESIGN — plain-English text for the `?connect_error=...&reason=<code>`
// redirect codes emitted by src/auth/gmail-oauth.ts / src/auth/qbo-oauth.ts. Distinct from
// friendlyOnboardingError above (which maps API error codes, not OAuth redirect reasons);
// kept separate rather than overloading that switch with unrelated codes.
export function friendlyConnectReason(reason: string): string {
  switch (reason) {
    case 'denied':
      return "You'll need to allow access to continue.";
    case 'wrong_company':
      return "That QuickBooks company doesn't match the one this workspace is set up for.";
    case 'missing_code':
    case 'exchange_failed':
    default:
      return 'Something went wrong connecting — please try again.';
  }
}
