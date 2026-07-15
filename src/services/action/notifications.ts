import type { AuthContext } from '../../auth/guard.js';
import { AuthError } from '../../auth/guard.js';
import { ServiceError, toActorContext } from '../index.js';
import { jsonResponse, errorResponse, readContext } from '../read/http.js';
import { markNotificationRead } from '../notifications.js';

/**
 * CHUNK_7_DIGEST — the thin bridge between `POST /api/notifications/:id/read` and
 * the gate-covered `markNotificationRead` service. Same shape as the CHUNK_6
 * onboarding bridge: all logic lives here (lint/typecheck/test cover it); the
 * `app/api/**` route file only wires a path to this function.
 */

function serviceErrorResponse(err: ServiceError): Response {
  const status = err.code.endsWith('_not_found') ? 404 : err.code === 'VALIDATION' ? 400 : 400;
  return errorResponse(err.code.toUpperCase(), err.message, status);
}

export async function runMarkNotificationRead(request: Request, notificationId: number): Promise<Response> {
  let ctx: AuthContext;
  try {
    ctx = await readContext(request);
  } catch (err) {
    if (err instanceof AuthError) return errorResponse(err.code, err.message, err.status);
    return errorResponse('INTERNAL', 'auth failed', 500);
  }
  try {
    const res = await markNotificationRead(toActorContext(ctx), notificationId);
    return jsonResponse(res, 200);
  } catch (err) {
    if (err instanceof AuthError) return errorResponse(err.code, err.message, err.status);
    if (err instanceof ServiceError) return serviceErrorResponse(err);
    return errorResponse('INTERNAL', 'action failed', 500);
  }
}
