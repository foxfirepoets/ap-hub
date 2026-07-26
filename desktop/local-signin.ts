/**
 * CHUNK_4_IDENTITY — the shell's side of local sign-in.
 *
 * Runs once the private database is up and its identity has been verified against the running
 * OS account (`src/db/local-database.ts`'s `OsAccountMismatch` check). Resolves the OS
 * account's own owner row (creating it on first launch) and hands the resulting session to
 * `desktop/ipc/context.ts` — the one module allowed to hold it. No password, no browser tab,
 * no code the user has to click through: the window simply opens onto the app.
 */

import { randomBytes } from 'node:crypto';
import { userInfo } from 'node:os';
import { createHostAdapter } from '../src/host/index.js';
import { localSignIn, type LocalSignInResult } from '../src/auth/local-signin.js';
import { setSessionToken } from './ipc/context.js';

/** Plain label only — never validated or displayed as an email address. */
function displayName(): string {
  try {
    const name = userInfo().username;
    return name && name.trim().length > 0 ? name : 'You';
  } catch {
    return 'You';
  }
}

/** Credential-store target for the session-cookie HMAC secret (`src/auth/session.ts`). */
const SESSION_COOKIE_SECRET_TARGET = 'APHub/auth/session-cookie-secret';

/**
 * The standalone shell has no `.env` and asks the user for nothing — so the secret
 * `src/auth/session.ts` signs cookies with is generated once, on first launch, and kept in the
 * OS credential store exactly like the database password (`DATABASE_PASSWORD_TARGET`). Never
 * logged, never written to `install.json`, never surfaced to the user.
 */
async function ensureSessionCookieSecret(): Promise<void> {
  if (process.env.SESSION_COOKIE_SECRET) return;
  const { secretStore } = createHostAdapter();
  let secret = await secretStore.get(SESSION_COOKIE_SECRET_TARGET);
  if (secret === null) {
    secret = randomBytes(32).toString('base64url');
    await secretStore.put(SESSION_COOKIE_SECRET_TARGET, secret);
  }
  process.env.SESSION_COOKIE_SECRET = secret;
}

export async function establishLocalIdentity(osAccountId: string): Promise<LocalSignInResult> {
  await ensureSessionCookieSecret();
  const result = await localSignIn(osAccountId, displayName());
  setSessionToken(result.session.token);
  return result;
}
