import { buildGoogleLoginUrl } from '../../../../src/auth/google-sso.js';
import { createSsoLoginState } from '../../../../src/auth/sso-state.js';

// GET /api/auth/login — redirect the browser to Google's consent screen.
// State is opaque and single-use. Its tenant is retained server-side and the same
// token is bound to this browser in an HttpOnly cookie.
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const tenant = url.searchParams.get('tenant') ?? '1';
  if (!/^\d+$/.test(tenant)) {
    return new Response(JSON.stringify({ error: { code: 'VALIDATION', message: 'invalid tenant' } }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }
  const state = await createSsoLoginState(Number(tenant));
  const location = await buildGoogleLoginUrl(state);
  return new Response(null, {
    status: 302,
    headers: {
      location,
      'set-cookie': `sso_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`,
    },
  });
}
