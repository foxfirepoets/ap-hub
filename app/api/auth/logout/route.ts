import { buildClearCookie, readSessionCookie, revokeSessionByToken } from '../../../../src/auth/session.js';

// POST /api/auth/logout — revoke the current session and clear the cookie.
export async function POST(request: Request): Promise<Response> {
  const token = readSessionCookie(request.headers.get('cookie'));
  if (token) await revokeSessionByToken(token);
  return new Response(JSON.stringify({ data: { ok: true } }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'set-cookie': buildClearCookie() },
  });
}
