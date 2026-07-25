import { AuthError } from '../auth/guard.js';
import { ServiceError, toActorContext } from '../services/index.js';
import { errorResponse, jsonResponse, readContext } from '../services/read/http.js';
import { setOwnerWriteGate } from './write-gates.js';

export async function runSetOwnerWriteGate(request: Request, connectionId: number): Promise<Response> {
  try {
    const ctx = await readContext(request, 'owner_controller');
    const body = await request.json() as Record<string, unknown>;
    if (typeof body.enabled !== 'boolean' || typeof body.confirmedCompanyId !== 'string' ||
        typeof body.backupConfirmed !== 'boolean' || typeof body.confirmation !== 'string') {
      return errorResponse('VALIDATION', 'complete write-gate confirmation is required', 400);
    }
    return jsonResponse(await setOwnerWriteGate(toActorContext(ctx), connectionId, {
      enabled: body.enabled, confirmedCompanyId: body.confirmedCompanyId,
      backupConfirmed: body.backupConfirmed, confirmation: body.confirmation,
    }));
  } catch (error) {
    if (error instanceof AuthError) return errorResponse(error.code, error.message, error.status);
    if (error instanceof ServiceError) return errorResponse(error.code.toUpperCase(), error.message, error.code.endsWith('_not_found') ? 404 : 400);
    return errorResponse('INTERNAL', 'write gate was not changed', 500);
  }
}
