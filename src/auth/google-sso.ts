import { config } from '../config.js';
import { query } from '../db/pool.js';
import { createSession, type NewSession } from './session.js';
import { writeAudit } from '../audit.js';

/**
 * Google SSO (CHUNK_1_AUTH). Reuses the existing Google OAuth client pattern
 * (`google.auth.OAuth2`, as in gmail-oauth.ts) at the `openid email profile` scopes.
 * On callback we verify the id_token, upsert the tenant's `users` row (matched by
 * email within the tenant), and mint a session. No Gmail/QBO scope is requested here.
 *
 * The pipeline is never modified; this only creates human-identity rows.
 */

const SSO_SCOPES = ['openid', 'email', 'profile'];

export interface GoogleProfile {
  sub: string;
  email: string;
  name?: string;
}

function redirectUri(): string {
  return `${config().WEB_BASE_URL}/api/auth/callback`;
}

/** Build the Google consent-screen URL. `state` carries the tenant id (see callback). */
export async function buildGoogleLoginUrl(state: string): Promise<string> {
  const cfg = config();
  const { google } = await import('googleapis');
  const oauth2 = new google.auth.OAuth2(
    cfg.GOOGLE_SSO_CLIENT_ID,
    cfg.GOOGLE_SSO_CLIENT_SECRET,
    redirectUri(),
  );
  return oauth2.generateAuthUrl({
    access_type: 'online',
    scope: SSO_SCOPES,
    include_granted_scopes: true,
    state,
    prompt: 'select_account',
  });
}

/** Exchange an auth code for a verified Google profile (sub/email/name). */
export async function exchangeCodeForProfile(code: string): Promise<GoogleProfile> {
  const cfg = config();
  const { google } = await import('googleapis');
  const oauth2 = new google.auth.OAuth2(
    cfg.GOOGLE_SSO_CLIENT_ID,
    cfg.GOOGLE_SSO_CLIENT_SECRET,
    redirectUri(),
  );
  const { tokens } = await oauth2.getToken(code);
  if (!tokens.id_token) throw new Error('Google SSO: no id_token in token response');
  const ticket = await oauth2.verifyIdToken({
    idToken: tokens.id_token,
    audience: cfg.GOOGLE_SSO_CLIENT_ID,
  });
  const payload = ticket.getPayload();
  if (!payload?.sub || !payload.email) {
    throw new Error('Google SSO: id_token missing sub/email');
  }
  return { sub: payload.sub, email: payload.email, name: payload.name };
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

/** Full callback flow: verified profile → upsert user → create session. */
export async function loginWithGoogle(code: string, tenantId: number): Promise<LoginResult> {
  const profile = await exchangeCodeForProfile(code);
  return completeLogin(tenantId, profile);
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
