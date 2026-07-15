import type { AuthContext, Role } from '../../auth/guard.js';
import { AuthError } from '../../auth/guard.js';
import { ServiceError, toActorContext } from '../index.js';
import { jsonResponse, errorResponse, readContext } from '../read/http.js';
import { approveProposal, type ApproveResult } from '../approve.js';
import { rejectProposal, retryProposal } from '../proposals.js';
import { remapMapping, learnCorrection, type RemapInput } from '../mappings.js';
import { sendReply, type ReplyDeps } from '../reply.js';
import type { PostDeps } from '../../pipeline/posting.js';

// CHUNK_6_ONBOARDING action bridge (GET/POST /api/onboarding*) — re-exported for a single
// action-layer import surface, matching the CHUNK_4 routes below.
export { runOnboardingGet, runOnboardingStep, runOnboardingDryRunAction } from './onboarding.js';

/**
 * CHUNK_4_ACTION — the thin bridge between an `app/api/**` POST route and the
 * gate-covered CHUNK_2 service functions. The `app/` tree is OUTSIDE the validation
 * gate (see guardrails), so ALL logic — auth, body parsing, role gating, result→HTTP
 * mapping, and the recipient-lockdown check — lives HERE where lint/typecheck/test
 * cover it; the route files only wire a path to one `run*` function.
 *
 * These routes NEVER re-implement pipeline logic and NEVER add a QBO-write or email-send
 * path: approve/retry reach QBO only via `approveProposal`/`retryProposal` → the existing
 * `postOnce` → `src/qbo/write.ts`; send reaches Gmail only via `sendReply` → the locked
 * `src/gatekeeper/forwarder.ts`, and no recipient value can pass through.
 */

// --- primitives ---------------------------------------------------------------------------

function strOrUndef(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
function numOrUndef(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  // Ids are bigints; a JSON client (or pg) may present them as numeric strings.
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

/** Parse a JSON request body into an object. Empty body → `{}`. Non-object → throws. */
async function parseBody(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (!text || text.trim() === '') return {};
  const parsed: unknown = JSON.parse(text);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SyntaxError('body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

/** Map a service-layer `ServiceError` to an HTTP response (`*_not_found` → 404). */
function serviceErrorResponse(err: ServiceError): Response {
  const status = err.code.endsWith('_not_found')
    ? 404
    : err.code === 'source_message_missing'
      ? 422
      : err.code === 'dry_run_locked' // CHUNK_6_ONBOARDING: locked until automation_level ≠ 'off'.
        ? 403
        : 400;
  return errorResponse(err.code.toUpperCase(), err.message, status);
}

/**
 * Resolve the session (enforcing `role`), parse the body, invoke the handler, and shape
 * failures: AuthError → its status/code (401/403); ServiceError → mapped; anything else → 500.
 * Handlers own their own success status codes.
 */
async function runAction(
  request: Request,
  role: Role | readonly Role[],
  handler: (ctx: AuthContext, body: Record<string, unknown>) => Promise<Response>,
): Promise<Response> {
  let ctx: AuthContext;
  try {
    ctx = await readContext(request, role);
  } catch (err) {
    if (err instanceof AuthError) return errorResponse(err.code, err.message, err.status);
    return errorResponse('INTERNAL', 'auth failed', 500);
  }
  let body: Record<string, unknown>;
  try {
    body = await parseBody(request);
  } catch {
    return errorResponse('VALIDATION', 'invalid JSON body', 400);
  }
  try {
    return await handler(ctx, body);
  } catch (err) {
    if (err instanceof AuthError) return errorResponse(err.code, err.message, err.status);
    if (err instanceof ServiceError) return serviceErrorResponse(err);
    return errorResponse('INTERNAL', 'action failed', 500);
  }
}

// --- approve / retry ----------------------------------------------------------------------

/** Shared result→HTTP mapping for the post path (approve + retry both return ApproveResult). */
function postResultResponse(res: ApproveResult): Response {
  switch (res.status) {
    case 'posted':
      return jsonResponse(
        { posting_id: res.postingId, qbo_type: res.qboType, qbo_id: res.qboId, qbo_link: res.qboLink, mode: res.mode },
        201,
      );
    case 'duplicate':
      // Two-layer dedup / replay caught an existing post — never a second write (guarantee 4).
      return errorResponse('ALREADY_POSTED', 'proposal already posted', 409);
    case 'held':
      // Fail-safe: below-threshold / over-ceiling / missing proof coverage / verify mismatch.
      return jsonResponse({ status: 'held', code: 'HELD_FOR_REVIEW', reason: res.reason }, 202);
    case 'skipped':
      return errorResponse('NOT_FOUND', res.reason, 404);
  }
}

/**
 * A thrown post is a QBO API failure: `postOnce` has already recorded a `qbo_api_error`
 * exception and created no posting, so the item is safe to retry — 202 QBO_RETRY.
 */
function qboRetryOnThrow(err: unknown): Response {
  if (err instanceof AuthError || err instanceof ServiceError) throw err;
  return errorResponse('QBO_RETRY', 'qbo post failed; safe to retry', 202);
}

export async function runApprove(request: Request, proposalId: number, deps?: PostDeps): Promise<Response> {
  return runAction(request, 'owner_controller', async (ctx) => {
    try {
      return postResultResponse(await approveProposal(toActorContext(ctx), proposalId, deps));
    } catch (err) {
      return qboRetryOnThrow(err);
    }
  });
}

export async function runRetry(request: Request, proposalId: number, deps?: PostDeps): Promise<Response> {
  return runAction(request, 'owner_controller', async (ctx) => {
    try {
      return postResultResponse(await retryProposal(toActorContext(ctx), proposalId, deps));
    } catch (err) {
      return qboRetryOnThrow(err);
    }
  });
}

// --- reject -------------------------------------------------------------------------------

export async function runReject(request: Request, proposalId: number): Promise<Response> {
  return runAction(request, ['owner_controller', 'bookkeeper'], async (ctx, body) => {
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (!reason) return errorResponse('VALIDATION', 'reason is required', 400);
    const res = await rejectProposal(toActorContext(ctx), proposalId, {
      reason,
      markDuplicate: body.markDuplicate === true,
    });
    return jsonResponse({ proposal_id: res.proposalId, status: res.status }, 200);
  });
}

// --- remap / learn ------------------------------------------------------------------------

function parseMapping(v: unknown): RemapInput | undefined {
  if (v === null || typeof v !== 'object') return undefined;
  const m = v as Record<string, unknown>;
  const kind = strOrUndef(m.kind);
  const sourceKey = strOrUndef(m.sourceKey);
  if (!kind || !sourceKey) return undefined;
  return {
    kind,
    sourceKey,
    targetQboType: strOrUndef(m.targetQboType),
    targetQboId: strOrUndef(m.targetQboId),
    targetName: strOrUndef(m.targetName),
    remember: m.remember === undefined ? undefined : m.remember !== false,
  };
}

export async function runRemap(request: Request): Promise<Response> {
  return runAction(request, ['owner_controller', 'bookkeeper'], async (ctx, body) => {
    const kind = strOrUndef(body.kind);
    const sourceKey = strOrUndef(body.sourceKey);
    if (!kind || !sourceKey) return errorResponse('VALIDATION', 'kind and sourceKey are required', 400);
    const res = await remapMapping(toActorContext(ctx), {
      kind,
      sourceKey,
      targetQboType: strOrUndef(body.targetQboType),
      targetQboId: strOrUndef(body.targetQboId),
      targetName: strOrUndef(body.targetName),
      remember: body.remember === undefined ? undefined : body.remember !== false,
    });
    return jsonResponse({ kind: res.kind, source_key: res.sourceKey, became_rule: res.becameRule }, 200);
  });
}

export async function runLearn(request: Request): Promise<Response> {
  return runAction(request, ['owner_controller', 'bookkeeper'], async (ctx, body) => {
    const field = strOrUndef(body.field);
    const newValue = strOrUndef(body.newValue);
    if (!field || !newValue) return errorResponse('VALIDATION', 'field and newValue are required', 400);
    const res = await learnCorrection(toActorContext(ctx), {
      proposalId: numOrUndef(body.proposalId),
      exceptionId: numOrUndef(body.exceptionId),
      field,
      newValue,
      remember: body.remember === true,
      mapping: parseMapping(body.mapping),
    });
    return jsonResponse(
      { correction_id: res.correctionId, became_rule: res.becameRule, rule_applied: res.ruleApplied },
      200,
    );
  });
}

// --- reply (send-lockdown, guarantee 2) ---------------------------------------------------

/**
 * Any field that could redirect a send. Their PRESENCE (not value) is a hard 400: the reply
 * route decides only WHICH held forward to release, never WHERE it goes. The forwarder is
 * bound to the single locked recipient at construction; `sendReply` has no recipient param.
 */
const RECIPIENT_FIELDS = [
  'to',
  'recipient',
  'recipients',
  'cc',
  'bcc',
  'email',
  'address',
  'to_address',
  'toAddress',
  'from',
  'replyTo',
];

export async function runSendReply(request: Request, replyId: number, deps?: ReplyDeps): Promise<Response> {
  return runAction(request, 'owner_controller', async (ctx, body) => {
    const offending = RECIPIENT_FIELDS.filter((f) => Object.prototype.hasOwnProperty.call(body, f));
    if (offending.length > 0) {
      return errorResponse('VALIDATION', `recipient fields are not permitted: ${offending.join(', ')}`, 400);
    }
    const res = await sendReply(toActorContext(ctx), replyId, deps);
    return jsonResponse({ forward_id: res.forwardId, to: res.to, send_id: res.sendId }, 200);
  });
}
