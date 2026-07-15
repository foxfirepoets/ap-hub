import { AuthError } from '../../auth/guard.js';
import { errorResponse, readContext } from '../read/http.js';
import { config } from '../../config.js';
import { signConnectState } from '../../auth/connect-state.js';
import { buildGmailAuthorizeUrl, buildQboAuthorizeUrl } from '../../auth/connect-urls.js';

/**
 * CHUNK_4_STARTROUTES — the thin bridge between `app/api/connections/{gmail,qbo}/start` and the
 * real OAuth authorize-URL builders. Session-gated (owner_controller only): the tenant id
 * used to sign the CHUNK_1 `state` token always comes from the resolved session, never
 * from any request input. The `app/` tree is OUTSIDE the validation gate (see
 * guardrails), so this logic lives here where lint/typecheck/test cover it; the route
 * files only wire a path to one `run*` function.
 */

async function runConnectStart(request: Request, buildUrl: (state: string) => string): Promise<Response> {
  try {
    const ctx = await readContext(request, 'owner_controller');
    const state = signConnectState(ctx.tenantId);
    return new Response(null, { status: 302, headers: { location: buildUrl(state) } });
  } catch (err) {
    if (err instanceof AuthError) return errorResponse(err.code, err.message, err.status);
    return errorResponse('INTERNAL', 'connect start failed', 500);
  }
}

/** GET /api/connections/gmail/start — 302 to the real Google OAuth consent URL. */
export async function runGmailConnectStart(request: Request): Promise<Response> {
  return runConnectStart(request, (state) => buildGmailAuthorizeUrl(config(), state));
}

/** GET /api/connections/qbo/start — 302 to the real Intuit OAuth consent URL. */
export async function runQboConnectStart(request: Request): Promise<Response> {
  return runConnectStart(request, (state) => buildQboAuthorizeUrl(config(), state));
}
