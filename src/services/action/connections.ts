import { AuthError } from '../../auth/guard.js';
import { errorResponse, jsonResponse, readContext } from '../read/http.js';
import { config } from '../../config.js';
import { createConnectState, type ConnectProvider } from '../../auth/connect-state.js';
import { buildGmailAuthorizeUrl, buildQboAuthorizeUrl } from '../../auth/connect-urls.js';
import { ConnectFlowNotConfigured, startConnectFlow } from '../../auth/connect-loopback.js';
import { hasTokenCredentialAuthority } from '../../auth/tokens.js';

/**
 * CHUNK_4_STARTROUTES — the thin bridge between `app/api/connections/{gmail,qbo}/start` and the
 * real OAuth authorize-URL builders. Session-gated (owner_controller only): the tenant id
 * used to sign the CHUNK_1 `state` token always comes from the resolved session, never
 * from any request input. The `app/` tree is OUTSIDE the validation gate (see
 * guardrails), so this logic lives here where lint/typecheck/test cover it; the route
 * files only wire a path to one `run*` function.
 */

async function runConnectStart(
  request: Request,
  provider: ConnectProvider,
  buildUrl: (state: string) => string,
): Promise<Response> {
  try {
    const ctx = await readContext(request, 'owner_controller');
    if (!ctx.sessionId) throw new AuthError(401, 'UNAUTHENTICATED');
    const state = await createConnectState(
      { tenantId: ctx.tenantId, userId: ctx.userId, sessionId: ctx.sessionId },
      provider,
    );
    return new Response(null, { status: 302, headers: { location: buildUrl(state) } });
  } catch (err) {
    if (err instanceof AuthError) return errorResponse(err.code, err.message, err.status);
    return errorResponse('INTERNAL', 'connect start failed', 500);
  }
}

/** GET /api/connections/gmail/start — 302 to the real Google OAuth consent URL. */
export async function runGmailConnectStart(request: Request): Promise<Response> {
  return runConnectStart(request, 'gmail', (state) => buildGmailAuthorizeUrl(config(), state));
}

/** GET /api/connections/qbo/start — 302 to the real Intuit OAuth consent URL. */
export async function runQboConnectStart(request: Request): Promise<Response> {
  return runConnectStart(request, 'qbo', (state) => buildQboAuthorizeUrl(config(), state));
}

/**
 * CHUNK_5_CONNECT — `aphub:connections:start`. Opens the given provider's consent screen in
 * the system browser and stands up the ephemeral loopback listener that receives its callback
 * (`src/auth/connect-loopback.ts`); replaces the web flow's redirect-based start above for the
 * desktop shell, which has no address bar to redirect.
 *
 * The credential store is checked BEFORE the browser opens, not after: a desktop install always
 * wires one up at boot, so an unavailable store here means it could not be reached at all, and
 * the user should never be sent through consent only to find the result cannot be saved.
 */
export async function runConnectionsStart(request: Request): Promise<Response> {
  try {
    const ctx = await readContext(request, 'owner_controller');
    if (!ctx.sessionId) throw new AuthError(401, 'UNAUTHENTICATED');

    if (!hasTokenCredentialAuthority()) {
      return errorResponse('SECURE_STORE', 'AP-Hub could not reach your saved sign-in details.', 503);
    }

    const body = (await request.json().catch(() => ({}))) as { provider?: unknown };
    const provider = body.provider;
    if (provider !== 'gmail' && provider !== 'qbo') {
      return errorResponse('VALIDATION', 'Choose an account to connect and try again.', 400);
    }

    await startConnectFlow(provider, {
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      sessionId: ctx.sessionId,
      email: ctx.email,
    });
    return jsonResponse({ state: 'browser_opened' });
  } catch (err) {
    if (err instanceof AuthError) return errorResponse(err.code, err.message, err.status);
    if (err instanceof ConnectFlowNotConfigured) {
      return errorResponse('PROVIDER_OFFLINE', 'AP-Hub could not open the sign-in window.', 502);
    }
    return errorResponse('PROVIDER_OFFLINE', 'AP-Hub could not open the sign-in window.', 502);
  }
}
