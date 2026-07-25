import { timingSafeEqual } from 'node:crypto';
import { config } from '../../../../src/config.js';
import { loginWithGoogle } from '../../../../src/auth/google-sso.js';
import { buildSessionCookie } from '../../../../src/auth/session.js';
import { logger } from '../../../../src/logger.js';
import { consumeSsoLoginState } from '../../../../src/auth/sso-state.js';

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

function nonceMatches(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

const badRequest = (message: string, status = 400, code = 'VALIDATION') =>
  new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });

// GET /api/auth/callback — Google redirects here with an opaque, single-use state.
// We verify it against the browser cookie and resolve its server-side tenant, exchange the
// code, mint a session, set the httpOnly cookie, clear the state cookie, and land on the app.
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  if (!code) return badRequest('missing code');

  const state = url.searchParams.get('state') ?? '';
  const cookieState = readCookie(request.headers.get('cookie'), 'sso_state');
  if (!state || !cookieState || !nonceMatches(state, cookieState)) {
    return badRequest('invalid state', 400, 'CSRF');
  }
  const tenantId = await consumeSsoLoginState(state);
  if (!tenantId) return badRequest('invalid state', 400, 'CSRF');

  try {
    const { session } = await loginWithGoogle(code, tenantId);
    const headers = new Headers({ location: config().WEB_BASE_URL });
    headers.append('set-cookie', buildSessionCookie(session.token, session.expiresAt));
    headers.append('set-cookie', 'sso_state=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0');
    return new Response(null, { status: 302, headers });
  } catch (err) {
    logger.warn({ err: String(err) }, 'sso callback failed');
    return new Response(
      JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: 'login failed' } }),
      { status: 401, headers: { 'content-type': 'application/json' } },
    );
  }
}
