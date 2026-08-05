/**
 * CHUNK_3_IPC — session-token custody. The ONLY module that touches the session token.
 *
 * Implements the hard rule in `docs/build/interfaces/ipc-envelope.md` §3 and
 * `ipc-auth-context.md` §1:
 *
 *   > The session token is held in the main process. The dispatcher injects it. The renderer
 *   > never supplies it, never sees it, and cannot override it.
 *
 * WHY, in one paragraph, because the rule looks like ceremony until you see the consequence.
 * `requireSession` answers "who does this token belong to", not "was this caller entitled to
 * hold it" (`src/auth/guard.ts:80-103`), and tenant plus role are derived entirely from the
 * session it resolves (`src/auth/guard.ts:88-94`). So whoever chooses the token chooses the
 * tenant. The renderer is the one process in BookScout OS that renders untrusted-shaped content; it
 * is therefore the one process that must not be able to name its own identity.
 *
 * The rule is enforced STRUCTURALLY, in three independent layers:
 *
 *  1. TYPE. The signed cookie is a branded `SessionCookie`, and the only function that can
 *     produce one is `currentSessionCookie()` below. An IPC payload is
 *     `Record<string, unknown>`, and `unknown` is not assignable to `SessionCookie`, so there
 *     is no expression that carries a payload value into the cookie header. The compiler,
 *     not a reviewer, is what rejects that edit.
 *  2. SCHEMA. `desktop/ipc/registry.ts` refuses at build time to register any channel whose
 *     request schema declares an identity-shaped key, and every request schema is `.strict()`.
 *  3. DISPATCH. The dispatcher rejects a payload carrying an identity-shaped key before the
 *     schema even runs — rejected, never merged, never ignored-and-forwarded.
 *
 * On sign-out the main process discards the token (`clearSessionToken`). A renderer holding a
 * stale channel call cannot re-authenticate itself, because it never had the token to replay.
 */

import { SESSION_COOKIE_NAME, signSessionValue } from '../../src/auth/session.js';

declare const sessionCookieBrand: unique symbol;

/**
 * A complete, signed `cookie` header value: `aphub_session=<token>.<hmac-sha256-base64url>`.
 *
 * Branded so it cannot be forged from a plain string. `signSessionValue` is not optional:
 * `readSessionCookie` verifies the HMAC and returns `null` for an unsigned value
 * (`src/auth/session.ts:150-161` via `verifySessionValue` at `:126-128`), so sending a raw
 * token resolves to no session and every channel would answer `UNAUTHENTICATED`.
 */
export type SessionCookie = string & { readonly [sessionCookieBrand]: 'aphub-session-cookie' };

/**
 * The live session. Main-process module state, never exposed on any channel and never sent to
 * the renderer. CHUNK_4_IDENTITY owns setting it from local sign-in; CHUNK_3 owns the custody
 * rule and gives the contract tests a way to act as a specific user.
 */
let sessionToken: string | null = null;

/**
 * Adopt a session. Called by the sign-in path (CHUNK_4) and by the contract tests so they can
 * act as tenant A, tenant B, an owner, a bookkeeper or a cpa.
 *
 * There is deliberately no IPC channel that reaches this function.
 */
export function setSessionToken(rawToken: string | null): void {
  sessionToken = rawToken !== null && rawToken !== '' ? rawToken : null;
}

/** Discard the session. Sign-out, and any point where the token must stop being usable. */
export function clearSessionToken(): void {
  sessionToken = null;
}

/** Whether a session is held. Does not reveal the token. */
export function hasSession(): boolean {
  return sessionToken !== null;
}

/**
 * The signed cookie header value for the held session, or `null` when none is held.
 *
 * When it returns `null` the dispatcher sets NO `cookie` header at all. It must not send an
 * empty one: `tokenFromRequest` returns `null`, `requireSession` throws
 * `AuthError(401,'UNAUTHENTICATED')` (`src/auth/guard.ts:84`), and 401 is exactly what
 * `app/lib/session.tsx:36-39` already treats as "redirect to login".
 */
export function currentSessionCookie(): SessionCookie | null {
  const token = sessionToken;
  if (token === null) return null;
  return `${SESSION_COOKIE_NAME}=${signSessionValue(token)}` as SessionCookie;
}

/**
 * Payload keys that would name an identity. Verbatim the list in `ipc-auth-context.md` §1
 * (`token`, `session`, `sessionId`, `userId`, `tenantId`, `role`, `actor`, `email`) plus the
 * transport-header spellings a payload has no business carrying.
 *
 * None of these is a legitimate field on any of the 50 channels: identity is resolved, never
 * asserted.
 */
export const IDENTITY_FIELDS: readonly string[] = Object.freeze([
  'token',
  'sessiontoken',
  'accesstoken',
  'refreshtoken',
  'bearer',
  'session',
  'sessionid',
  'userid',
  'user',
  'tenantid',
  'tenant',
  'role',
  'actor',
  'email',
  'cookie',
  'authorization',
  'credential',
  'password',
  'secret',
]);

const IDENTITY_SET: ReadonlySet<string> = new Set(IDENTITY_FIELDS);

/** `Tenant_ID` and `tenantId` are the same claim; compare on a canonical form. */
function canonicalKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * The identity-shaped keys present on a payload, in payload order.
 *
 * Presence-based, exactly like the recipient deny-list at
 * `src/services/action/index.ts:268-271`: the VALUE is irrelevant, the attempt is the defect.
 */
export function identityFieldsIn(payload: unknown): readonly string[] {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return [];
  return Object.keys(payload as Record<string, unknown>).filter((k) => IDENTITY_SET.has(canonicalKey(k)));
}

/** True when a payload tries to name an identity. */
export function carriesIdentityClaim(payload: unknown): boolean {
  return identityFieldsIn(payload).length > 0;
}
