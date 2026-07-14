import { readSessionCookie } from '../../auth/session.js';
import { requireSession, AuthError, type AuthContext, type Role } from '../../auth/guard.js';

/**
 * CHUNK_3_READ — the thin bridge between an `app/api/**` route handler and the
 * gate-covered read services. The `app/` tree is OUTSIDE the validation gate
 * (see guardrails), so ALL logic lives here (and in the sibling query modules)
 * where lint/typecheck/test cover it; route files only wire a path to `runRead`.
 *
 * A read handler returns its data, or `null` to signal "not found in this tenant"
 * — which `runRead` maps to 404 NOT_FOUND. Cross-tenant access can therefore never
 * return foreign rows: the scoped query returns no row → handler returns null → 404.
 */

export function jsonResponse(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ data }), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export function errorResponse(code: string, message: string, status: number): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Read the raw session token from the request (signed cookie, or Bearer fallback). */
export function tokenFromRequest(request: Request): string | null {
  const fromCookie = readSessionCookie(request.headers.get('cookie'));
  if (fromCookie) return fromCookie;
  const auth = request.headers.get('authorization');
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  return null;
}

/** Resolve the caller to a tenant-scoped AuthContext (throws AuthError on failure). */
export async function readContext(request: Request, role?: Role | readonly Role[]): Promise<AuthContext> {
  return requireSession(tokenFromRequest(request), role);
}

/**
 * Run a read handler: resolve the session, invoke the handler with the context,
 * and shape the Response. `null` → 404 NOT_FOUND; AuthError → its status/code;
 * anything else → 500. Reads never mutate, so there is no audit row here.
 */
export async function runRead<T>(
  request: Request,
  handler: (ctx: AuthContext) => Promise<T>,
  opts: { role?: Role | readonly Role[] } = {},
): Promise<Response> {
  let ctx: AuthContext;
  try {
    ctx = await readContext(request, opts.role);
  } catch (err) {
    if (err instanceof AuthError) return errorResponse(err.code, err.message, err.status);
    return errorResponse('INTERNAL', 'auth failed', 500);
  }
  try {
    const result = await handler(ctx);
    if (result === null || result === undefined) {
      return errorResponse('NOT_FOUND', 'not found', 404);
    }
    return jsonResponse(result);
  } catch (err) {
    if (err instanceof AuthError) return errorResponse(err.code, err.message, err.status);
    return errorResponse('INTERNAL', 'read failed', 500);
  }
}

/** Sandbox QBO deep-link built from posting data (realm is data-driven, never hard-coded). */
export function sandboxLink(realm: string, qboType: string, qboId: string): string {
  return `https://app.sandbox.qbo.intuit.com/app/${qboType.toLowerCase()}?txnId=${qboId}&realm=${realm}`;
}
