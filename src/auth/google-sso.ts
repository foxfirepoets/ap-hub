import { query } from '../db/pool.js';
import { createSession, type NewSession } from './session.js';
import { writeAudit } from '../audit.js';

/**
 * Google SSO (CHUNK_1_AUTH) — REMOVED as the product entry point by CHUNK_4_IDENTITY. The OS
 * account that already authenticated the user is the product's identity now
 * (`src/auth/local-signin.ts`); there is no browser tab, no consent screen, and no code the
 * user clicks through.
 *
 * The two functions that actually STARTED a Google OAuth round trip —
 * `buildGoogleLoginUrl` (the consent-screen redirect) and `loginWithGoogle` /
 * `exchangeCodeForProfile` (the code-for-profile exchange) — are deleted outright: CHUNK_3_IPC
 * already deleted the `app/api/auth/login` and `app/api/auth/callback` routes that were their
 * only callers, so nothing in the product could reach them before this chunk either.
 *
 * `activateUserForLogin` / `completeLogin` remain: they are the DB-only "activate an
 * already-invited user from an already-verified profile" half, still exercised by
 * `test/auth-guard.test.ts` and `test/provisioning.test.ts`, and are not themselves an entry
 * point — nothing produces a `GoogleProfile` to hand them anymore.
 */

export interface GoogleProfile {
  sub: string;
  email: string;
  name?: string;
}

export interface UpsertedUser {
  id: number;
  role: string;
  status: string;
}

/**
 * Activate a PRE-EXISTING user within a tenant, matched by (tenant_id, email).
 * SSO login NEVER self-provisions: the user must already have been invited
 * (status 'invited') or be 'active'. An invited user is activated on first
 * login; google_sub and name are refreshed; a disabled user stays disabled.
 * Returns null when no row exists for (tenant_id, email) — i.e. not invited.
 *
 * Rationale (security): the tenant id arrives from an attacker-controllable
 * login param; auto-INSERT here would let any Google account mint an active
 * session in any tenant and read its financial data. First-owner provisioning
 * must happen out-of-band (seed/CLI/onboarding invite), not via public SSO.
 */
export async function activateUserForLogin(
  tenantId: number,
  profile: GoogleProfile,
): Promise<UpsertedUser | null> {
  const { rows } = await query<UpsertedUser>(
    `UPDATE users SET
       name = COALESCE($3, name),
       google_sub = $4,
       status = CASE WHEN status = 'invited' THEN 'active' ELSE status END
     WHERE tenant_id = $1 AND email = $2
     RETURNING id, role, status`,
    [tenantId, profile.email, profile.name ?? null, profile.sub],
  );
  return rows[0] ?? null;
}

export interface LoginResult {
  userId: number;
  tenantId: number;
  role: string;
  session: NewSession;
}

/**
 * Activate a pre-invited user + mint a session from an already-verified profile.
 * Split out so the DB path is testable without contacting Google. Refuses a
 * stranger (not invited → no row) and a disabled user (neither gets a session).
 */
export async function completeLogin(
  tenantId: number,
  profile: GoogleProfile,
): Promise<LoginResult> {
  const user = await activateUserForLogin(tenantId, profile);
  if (!user) {
    throw new Error('no invited account for this email in this tenant');
  }
  if (user.status !== 'active') {
    throw new Error('user is disabled');
  }
  const session = await createSession(user.id);
  await writeAudit({
    tenantId,
    actor: profile.email,
    action: 'auth.login',
    entity: `user:${user.id}`,
  });
  return { userId: user.id, tenantId, role: user.role, session };
}
