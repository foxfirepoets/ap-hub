/**
 * CHUNK_3_IPC — the post path: approve, reject, retry.
 *
 * Replaces `app/api/proposals/[id]/{approve,reject,retry}/route.ts`. Each channel calls the
 * SAME exported wrapper the route called, with no `deps` argument, so production takes the real
 * adapters and the whole authorization funnel (`tokenFromRequest` → `readContext` → role gate)
 * fires exactly where it fires today.
 *
 * Roles, verified by reading the wrapper rather than the route map:
 *
 *   runApprove  → runAction(request, 'owner_controller', …)                index.ts:157
 *   runReject   → runAction(request, ['owner_controller','bookkeeper'], …) index.ts:179
 *   runRetry    → runAction(request, 'owner_controller', …)                index.ts:167
 *
 * The response schemas are deliberately loose for approve/retry: `postResultResponse`
 * (`index.ts:127`) returns FOUR different success shapes — 201 posted, 202 queued, 202 held,
 * plus the 409/404 error paths — and the dispatcher fails a call CLOSED when the success
 * payload does not match. A narrow schema here would turn a correct `held` response into
 * `INTERNAL` and hide guarantee 5 from the user.
 */

import { z } from 'zod';

import { runApprove, runReject, runRetry } from '../../../src/services/action/index.js';
import {
  defineChannel,
  entityId,
  passthrough,
  persistedId,
  reason,
  strict,
  type RegistryEntry,
} from '../registry.js';

export const proposalEntries: readonly RegistryEntry[] = [
  defineChannel({
    channel: 'aphub:proposals:approve',
    role: ['owner_controller'],
    method: 'POST',
    pathTemplate: '/api/proposals/:proposalId/approve',
    // No body: `runAction`'s `parseBody` turns an empty body into `{}` and the handler reads
    // nothing from it. `synthesize` still sends '{}' because the method is not GET.
    bodyKeys: [],
    request: strict({ proposalId: entityId }),
    response: passthrough({}),
    validationMessage: 'AP-Hub could not tell which item to approve. Reopen the item and try again.',
    invoke: (request, payload) => runApprove(request, payload.proposalId as number),
  }),

  defineChannel({
    channel: 'aphub:proposals:reject',
    // Both roles, exactly as index.ts:179 — `bookkeeper` holds the `reject` permission.
    role: ['owner_controller', 'bookkeeper'],
    method: 'POST',
    pathTemplate: '/api/proposals/:proposalId/reject',
    bodyKeys: ['reason', 'markDuplicate'],
    // `reason` is required here so the requirement is enforced BEFORE the service is reached
    // (index.ts:180-181 returns 400 for a blank one).
    request: strict({
      proposalId: entityId,
      reason,
      markDuplicate: z.boolean().optional(),
    }),
    response: passthrough({ proposal_id: persistedId, status: z.string() }),
    validationMessage: 'Add a short reason before rejecting this item.',
    invoke: (request, payload) => runReject(request, payload.proposalId as number),
  }),

  defineChannel({
    channel: 'aphub:proposals:retry',
    role: ['owner_controller'],
    method: 'POST',
    pathTemplate: '/api/proposals/:proposalId/retry',
    bodyKeys: [],
    request: strict({ proposalId: entityId }),
    response: passthrough({}),
    validationMessage: 'AP-Hub could not tell which item to try again. Reopen the item and try again.',
    invoke: (request, payload) => runRetry(request, payload.proposalId as number),
  }),
];
