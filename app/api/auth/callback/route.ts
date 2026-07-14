import { config } from '../../../../src/config.js';
import { loginWithGoogle } from '../../../../src/auth/google-sso.js';
import { buildSessionCookie } from '../../../../src/auth/session.js';
import { logger } from '../../../../src/logger.js';

// GET /api/auth/callback — Google redirects here with `code` + `state` (tenant id).
// We exchange the code, mint a session, set the httpOnly cookie, and land on the app.
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const tenantId = Number(url.searchParams.get('state') ?? '1');
  if (!code) {
    return new Response(JSON.stringify({ error: { code: 'VALIDATION', message: 'missing code' } }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }
  try {
    const { session } = await loginWithGoogle(code, tenantId);
    return new Response(null, {
      status: 302,
      headers: {
        location: config().WEB_BASE_URL,
        'set-cookie': buildSessionCookie(session.token, session.expiresAt),
      },
    });
  } catch (err) {
    logger.warn({ err: String(err) }, 'sso callback failed');
    return new Response(
      JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: 'login failed' } }),
      { status: 401, headers: { 'content-type': 'application/json' } },
    );
  }
}
