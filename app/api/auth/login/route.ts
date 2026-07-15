import { randomBytes } from 'node:crypto';
import { buildGoogleLoginUrl } from '../../../../src/auth/google-sso.js';

// GET /api/auth/login — redirect the browser to Google's consent screen.
// `state` = "<nonce>.<tenant>"; the nonce is also set as an HttpOnly cookie and
// re-checked on callback (OAuth CSRF / login-fixation defence). The tenant is
// only a routing hint — the callback still requires a pre-invited user in it,
// so `state` is never a trusted authorization input.
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const tenant = url.searchParams.get('tenant') ?? '1';
  if (!/^\d+$/.test(tenant)) {
    return new Response(JSON.stringify({ error: { code: 'VALIDATION', message: 'invalid tenant' } }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }
  const nonce = randomBytes(16).toString('base64url');
  const location = await buildGoogleLoginUrl(`${nonce}.${tenant}`);
  return new Response(null, {
    status: 302,
    headers: {
      location,
      'set-cookie': `sso_state=${nonce}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`,
    },
  });
}
