import type { AuthContext } from '../auth/guard.js';
import { AuthError } from '../auth/guard.js';
import { ServiceError, toActorContext } from '../services/index.js';
import { errorResponse, jsonResponse, readContext } from '../services/read/http.js';
import {
  correctStatementFact,
  excludeStatementLine,
  fileStatement,
  matchStatementLine,
} from './review.js';

function objectBody(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

async function action(
  request: Request,
  handler: (ctx: AuthContext, body: Record<string, unknown>) => Promise<void>,
): Promise<Response> {
  let ctx: AuthContext;
  try {
    ctx = await readContext(request, ['owner_controller', 'bookkeeper']);
  } catch (error) {
    if (error instanceof AuthError) return errorResponse(error.code, error.message, error.status);
    return errorResponse('INTERNAL', 'auth failed', 500);
  }
  try {
    const body = objectBody(await request.json());
    if (!body) return errorResponse('VALIDATION', 'body must be an object', 400);
    await handler(ctx, body);
    return jsonResponse({ ok: true });
  } catch (error) {
    if (error instanceof SyntaxError) return errorResponse('VALIDATION', 'invalid JSON body', 400);
    if (error instanceof ServiceError) {
      const status = error.code.endsWith('_not_found') ? 404 : 400;
      return errorResponse(error.code.toUpperCase(), error.message, status);
    }
    return errorResponse('INTERNAL', 'statement action failed', 500);
  }
}

export function runMatchStatementLine(
  request: Request,
  statementId: number,
  lineId: number,
): Promise<Response> {
  return action(request, async (ctx, body) => {
    const providerRef = objectBody(body.providerRef);
    if (!providerRef || typeof body.reason !== 'string') {
      throw new ServiceError('VALIDATION', 'providerRef and reason are required');
    }
    await matchStatementLine(toActorContext(ctx), statementId, lineId, {
      providerRef,
      reason: body.reason,
    });
  });
}

export function runExcludeStatementLine(
  request: Request,
  statementId: number,
  lineId: number,
): Promise<Response> {
  return action(request, async (ctx, body) => {
    if (typeof body.reason !== 'string') throw new ServiceError('VALIDATION', 'reason is required');
    await excludeStatementLine(toActorContext(ctx), statementId, lineId, body.reason);
  });
}

export function runCorrectStatement(request: Request, statementId: number): Promise<Response> {
  return action(request, async (ctx, body) => {
    if (typeof body.field !== 'string' || typeof body.reason !== 'string'
      || (body.value !== null && typeof body.value !== 'string')) {
      throw new ServiceError('VALIDATION', 'field, value, and reason are required');
    }
    await correctStatementFact(toActorContext(ctx), statementId, {
      field: body.field,
      value: body.value,
      reason: body.reason,
    });
  });
}

export function runFileStatement(request: Request, statementId: number): Promise<Response> {
  return action(request, async (ctx) => fileStatement(toActorContext(ctx), statementId));
}
