/**
 * CHUNK_3_IPC — retry one QuickBooks Desktop durable provider job.
 *
 * Replaces `app/api/provider-jobs/[id]/retry/route.ts`. `GET /api/provider-jobs` is a READ and
 * belongs to the read domains.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE ODD ONE OUT — AND THE ONE CHANNEL WITH NO EXPORTED WRAPPER TO CALL.
 *
 * Every other mutation in the product is a 3–8 line route file forwarding to an exported `run*`
 * function in `src/**`. This one is not: its whole implementation is INLINE in the route file
 * (`app/api/provider-jobs/[id]/retry/route.ts:9-24`), it resolves the session with a direct
 * `requireSession(tokenFromRequest(request), 'owner_controller')` rather than `readContext`, and
 * it is the only dynamic route in the tree that takes `params: Promise<{ id: string }>`.
 *
 * There is therefore no exported function for this channel to call. `app/**` is being deleted
 * (DEVIATIONS.md #4) and `src/**` is byte-frozen for this chunk, so the route's inline body is
 * reproduced HERE, in the transport layer, verb for verb:
 *
 *   requireSession(token, 'owner_controller')      same function, same role literal
 *   integer/positive id guard → INVALID_ID 400     kept even though `entityId` makes it
 *                                                  unreachable over IPC — it is the route's
 *                                                  behaviour, and this file is a port, not a
 *                                                  redesign
 *   DurableProviderJobs().retry(tenantId, jobId)   same call, tenant from the SESSION
 *   null row → NOT_FOUND 404                       cross-tenant miss can only 404
 *   AuthError → its own status/code                401 / 403 unchanged
 *   UnsafeProviderJobRetryError → UNSAFE_RETRY 409 normalizes to CONFLICT
 *                                                  (`desktop/ipc/errors.ts:68`)
 *   anything else → INTERNAL 500                   message authored here, never the cause
 *
 * The tenant comes from the resolved session and from nowhere else, so a caller cannot name
 * another tenant's job: `retry(actor.tenantId, jobId)` scopes the query and a foreign id returns
 * no row → 404. `UnsafeProviderJobRetryError` is guarantee 4's voice here — an uncertain provider
 * outcome refuses to be retried rather than risking a second write
 * (`src/qbdesktop/durable-jobs.ts:412`).
 *
 * If a future chunk exports a `runRetryProviderJob` wrapper from `src/**`, this closure should be
 * deleted and replaced by a call to it. Until then, duplicating the four lines is strictly safer
 * than editing the service layer.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { AuthError, requireSession } from '../../../src/auth/guard.js';
import { DurableProviderJobs, UnsafeProviderJobRetryError } from '../../../src/qbdesktop/durable-jobs.js';
import { errorResponse, jsonResponse, tokenFromRequest } from '../../../src/services/read/http.js';
import { defineChannel, entityId, passthrough, strict, type RegistryEntry } from '../registry.js';

/** Verbatim the route handler at `app/api/provider-jobs/[id]/retry/route.ts:9-24`. */
async function retryProviderJob(request: Request, jobId: number): Promise<Response> {
  try {
    const actor = await requireSession(tokenFromRequest(request), 'owner_controller');
    if (!Number.isInteger(jobId) || jobId <= 0) return errorResponse('INVALID_ID', 'invalid job id', 400);
    const job = await new DurableProviderJobs().retry(actor.tenantId, jobId);
    return job ? jsonResponse(job) : errorResponse('NOT_FOUND', 'not found', 404);
  } catch (error) {
    if (error instanceof AuthError) return errorResponse(error.code, error.message, error.status);
    if (error instanceof UnsafeProviderJobRetryError) {
      return errorResponse('UNSAFE_RETRY', error.message, 409);
    }
    return errorResponse('INTERNAL', 'retry failed', 500);
  }
}

export const providerJobEntries: readonly RegistryEntry[] = [
  defineChannel({
    channel: 'aphub:provider-jobs:retry',
    // `requireSession(…, 'owner_controller')` — the literal in the route, not a guess.
    role: ['owner_controller'],
    method: 'POST',
    pathTemplate: '/api/provider-jobs/:jobId/retry',
    // The route reads no body.
    bodyKeys: [],
    request: strict({ jobId: entityId }),
    response: passthrough({}),
    validationMessage:
      'AP-Hub could not tell which pending accounting task to try again. Reload the list and try again.',
    invoke: (request, payload) => retryProviderJob(request, payload.jobId as number),
  }),
];
