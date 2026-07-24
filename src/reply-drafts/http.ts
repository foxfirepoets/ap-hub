import type { AuthContext } from '../auth/guard.js';
import { AuthError } from '../auth/guard.js';
import { GmailAuthError } from '../gmail/client.js';
import { GmailComposeScopeError, GmailDraftRetryError } from '../gmail/drafts.js';
import { ServiceError, toActorContext } from '../services/index.js';
import { errorResponse, jsonResponse, readContext } from '../services/read/http.js';
import {
  createReplyDraft,
  discardReplyDraft,
  readReplyDraft,
  updateReplyDraft,
  type ReplyDraftDependencies,
} from './service.js';

function error(error: unknown): Response {
  if (error instanceof AuthError) return errorResponse(error.code, error.message, error.status);
  if (error instanceof GmailComposeScopeError) {
    return errorResponse(error.code, error.message, 428);
  }
  if (error instanceof GmailAuthError) {
    return errorResponse('GMAIL_RECONNECT_REQUIRED', error.message, 401);
  }
  if (error instanceof GmailDraftRetryError) {
    return errorResponse(error.code, error.message, 503);
  }
  if (error instanceof ServiceError) {
    const status = error.code.endsWith('_not_found') ? 404
      : error.code === 'reply_draft_exists' || error.code.includes('already_sent')
        || error.code.includes('discarded') || error.code.includes('conflict') ? 409 : 400;
    return errorResponse(error.code.toUpperCase(), error.message, status);
  }
  return errorResponse('INTERNAL', 'reply draft operation failed', 500);
}

async function body(request: Request): Promise<Record<string, unknown>> {
  const value: unknown = await request.json();
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ServiceError('VALIDATION', 'body must be an object');
  }
  return value as Record<string, unknown>;
}

async function mutation(
  request: Request,
  handler: (ctx: AuthContext, input: Record<string, unknown>) => Promise<unknown>,
): Promise<Response> {
  try {
    const ctx = await readContext(request, ['owner_controller', 'bookkeeper']);
    return jsonResponse(await handler(ctx, await body(request)));
  } catch (cause) {
    return error(cause);
  }
}

export async function runReadReplyDraft(
  request: Request,
  deps?: ReplyDraftDependencies,
): Promise<Response> {
  try {
    const ctx = await readContext(request, ['owner_controller', 'bookkeeper', 'cpa']);
    const raw = new URL(request.url).searchParams.get('messageId');
    const messageId = Number(raw);
    if (!raw || !Number.isInteger(messageId) || messageId <= 0) {
      return errorResponse('VALIDATION', 'messageId is required', 400);
    }
    const draft = await readReplyDraft(ctx.tenantId, messageId, deps);
    if (!draft) return errorResponse('NOT_FOUND', 'reply draft not found', 404);
    return jsonResponse(draft);
  } catch (cause) {
    return error(cause);
  }
}

export function runCreateReplyDraft(
  request: Request,
  deps?: ReplyDraftDependencies,
): Promise<Response> {
  return mutation(request, async (ctx, input) => {
    const messageId = Number(input.messageId);
    if (!Number.isInteger(messageId) || messageId <= 0 || typeof input.subject !== 'string'
      || typeof input.bodyText !== 'string'
      || (input.reason !== undefined && input.reason !== null && typeof input.reason !== 'string')) {
      throw new ServiceError('VALIDATION', 'messageId, subject, and bodyText are required');
    }
    return createReplyDraft(toActorContext(ctx), {
      messageId,
      subject: input.subject,
      bodyText: input.bodyText,
      reason: input.reason as string | null | undefined,
    }, deps);
  });
}

export function runUpdateReplyDraft(
  request: Request,
  draftId: number,
  deps?: ReplyDraftDependencies,
): Promise<Response> {
  return mutation(request, async (ctx, input) => {
    if (typeof input.subject !== 'string' || typeof input.bodyText !== 'string'
      || (input.reason !== undefined && input.reason !== null && typeof input.reason !== 'string')) {
      throw new ServiceError('VALIDATION', 'subject and bodyText are required');
    }
    return updateReplyDraft(toActorContext(ctx), draftId, {
      subject: input.subject,
      bodyText: input.bodyText,
      reason: input.reason as string | null | undefined,
    }, deps);
  });
}

export async function runDiscardReplyDraft(
  request: Request,
  draftId: number,
  deps?: ReplyDraftDependencies,
): Promise<Response> {
  try {
    const ctx = await readContext(request, ['owner_controller', 'bookkeeper']);
    return jsonResponse(await discardReplyDraft(toActorContext(ctx), draftId, deps));
  } catch (cause) {
    return error(cause);
  }
}
