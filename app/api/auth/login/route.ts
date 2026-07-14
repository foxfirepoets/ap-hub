import { buildGoogleLoginUrl } from '../../../../src/auth/google-sso.js';

// GET /api/auth/login — redirect the browser to Google's consent screen.
// The tenant is carried in `state` (white-label: never hard-coded in logic; a caller
// supplies it, defaulting to the sole tenant during single-tenant installs).
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const tenant = url.searchParams.get('tenant') ?? '1';
  const location = await buildGoogleLoginUrl(tenant);
  return new Response(null, { status: 302, headers: { location } });
}
