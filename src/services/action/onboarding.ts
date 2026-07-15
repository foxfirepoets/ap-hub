import type { AuthContext, Role } from '../../auth/guard.js';
import { AuthError } from '../../auth/guard.js';
import { ServiceError, toActorContext } from '../index.js';
import { jsonResponse, errorResponse, readContext } from '../read/http.js';
import { getOnboardingState, advanceOnboardingStep, runOnboardingDryRun, type DryRunDeps } from '../onboarding.js';

/**
 * CHUNK_6_ONBOARDING — the thin bridge between `app/api/onboarding*` routes and the
 * gate-covered onboarding service (`src/services/onboarding.ts`). Same shape as the
 * CHUNK_4 action bridge: ALL logic lives here (lint/typecheck/test cover it); the
 * `app/api/**` route files only wire a path to one `run*` function.
 */

/** Map a service-layer `ServiceError` to an HTTP response (mirrors CHUNK_4's mapping). */
function serviceErrorResponse(err: ServiceError): Response {
  const status = err.code.endsWith('_not_found') ? 404 : err.code === 'dry_run_locked' ? 403 : 400;
  return errorResponse(err.code.toUpperCase(), err.message, status);
}

async function parseBody(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (!text || text.trim() === '') return {};
  const parsed: unknown = JSON.parse(text);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SyntaxError('body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

async function runOnboardingAction(
  request: Request,
  role: Role | readonly Role[] | undefined,
  handler: (ctx: AuthContext, body: Record<string, unknown>) => Promise<Response>,
): Promise<Response> {
  let ctx: AuthContext;
  try {
    ctx = await readContext(request, role);
  } catch (err) {
    if (err instanceof AuthError) return errorResponse(err.code, err.message, err.status);
    return errorResponse('INTERNAL', 'auth failed', 500);
  }
  let body: Record<string, unknown> = {};
  if (request.method === 'POST') {
    try {
      body = await parseBody(request);
    } catch {
      return errorResponse('VALIDATION', 'invalid JSON body', 400);
    }
  }
  try {
    return await handler(ctx, body);
  } catch (err) {
    if (err instanceof AuthError) return errorResponse(err.code, err.message, err.status);
    if (err instanceof ServiceError) return serviceErrorResponse(err);
    return errorResponse('INTERNAL', 'action failed', 500);
  }
}

/** GET /api/onboarding — current state + discovery (any authenticated role). */
export async function runOnboardingGet(request: Request): Promise<Response> {
  return runOnboardingAction(request, undefined, async (ctx) => {
    const state = await getOnboardingState(toActorContext(ctx));
    return jsonResponse(state);
  });
}

/** POST /api/onboarding/step — advance the wizard step / persist a choice (owner only). */
export async function runOnboardingStep(request: Request): Promise<Response> {
  return runOnboardingAction(request, 'owner_controller', async (ctx, body) => {
    const step = typeof body.step === 'string' ? body.step : undefined;
    const automationLevel = typeof body.automationLevel === 'string' ? body.automationLevel : undefined;
    const row = await advanceOnboardingStep(toActorContext(ctx), { step, automationLevel });
    return jsonResponse(row);
  });
}

/** POST /api/onboarding/dry-run — propose-only scan; never reaches post_sandbox. */
export async function runOnboardingDryRunAction(request: Request, deps?: DryRunDeps): Promise<Response> {
  return runOnboardingAction(request, 'owner_controller', async (ctx) => {
    const summary = await runOnboardingDryRun(toActorContext(ctx), deps);
    return jsonResponse(summary, 201);
  });
}
