import { timingSafeEqual } from 'node:crypto';
import { config } from '../../../../src/config.js';
import { loginWithGoogle } from '../../../../src/auth/google-sso.js';
import { buildSessionCookie } from '../../../../src/auth/session.js';
import { logger } from '../../../../src/logger.js';

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

// GET /api/auth/callback — Google redirects here with `code` + `state` ("<nonce>.<tenant>").
// We verify the state nonce against the sso_state cookie (OAuth CSRF defence), exchange the
// code, mint a session, set the httpOnly cookie, clear the state cookie, and land on the app.
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  if (!code) return badRequest('missing code');

  const state = url.searchParams.get('state') ?? '';
  const dot = state.indexOf('.');
  const nonce = dot >= 0 ? state.slice(0, dot) : '';
  const tenantRaw = dot >= 0 ? state.slice(dot + 1) : '';
  const cookieNonce = readCookie(request.headers.get('cookie'), 'sso_state');
  if (!nonce || !cookieNonce || !nonceMatches(nonce, cookieNonce)) {
    return badRequest('invalid state', 400, 'CSRF');
  }
  if (!/^\d+$/.test(tenantRaw)) return badRequest('invalid tenant');
  const tenantId = Number(tenantRaw);

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
