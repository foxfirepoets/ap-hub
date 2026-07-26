/**
 * CHUNK_3_IPC — Gmail reply drafts: create, update, discard.
 *
 * Replaces `POST /api/reply-drafts` and `PATCH`/`DELETE /api/reply-drafts/[id]`.
 * `GET /api/reply-drafts` is a READ and belongs to the read domains.
 *
 * Guarantee 1 holds by construction: these three reach Gmail only through draft create / update /
 * discard, never a send and never a mutation of an existing message.
 *
 * ── THREE OPERATIONS, TWO DIFFERENT WRAPPERS ────────────────────────────────────────────────
 * `runCreateReplyDraft` and `runUpdateReplyDraft` go through the private `mutation()` clone
 * (`src/reply-drafts/http.ts:47`), which calls `readContext(request, ['owner_controller',
 * 'bookkeeper'])` and then `body(request)` — an UNCONDITIONAL `request.json()` at `:40` that
 * throws on an empty body.
 *
 * `runDiscardReplyDraft` does NOT use `mutation()`. It has its own inline
 * `readContext(request, ['owner_controller','bookkeeper'])` (`:122`) and reads no body at all.
 * Same role set, different code path, and the difference is exactly why these wrappers must not
 * be unified. `synthesize` sends `'{}'` on the DELETE regardless, which nothing reads.
 * ────────────────────────────────────────────────────────────────────────────────────────────
 *
 * `cpa` is refused by both paths: it holds `read` only, not `draft_reply`.
 */

import {
  runCreateReplyDraft,
  runDiscardReplyDraft,
  runUpdateReplyDraft,
} from '../../../src/reply-drafts/http.js';
import { defineChannel, entityId, passthrough, strict, type RegistryEntry } from '../registry.js';
import { clearableReason, emailBody, emailSubject } from './fields.js';

export const replyDraftEntries: readonly RegistryEntry[] = [
  defineChannel({
    channel: 'aphub:reply-drafts:create',
    role: ['owner_controller', 'bookkeeper'],
    method: 'POST',
    pathTemplate: '/api/reply-drafts',
    bodyKeys: ['messageId', 'subject', 'bodyText', 'reason'],
    request: strict({
      // `messageId` is a BODY key here, not a path param — the route has no `:id`
      // (`app/api/reply-drafts/route.ts`), and the wrapper reads it from the body at
      // `src/reply-drafts/http.ts:83` and requires a positive integer at `:84`.
      messageId: entityId,
      subject: emailSubject,
      bodyText: emailBody,
      // `undefined | null | string`, exactly as `:86` allows.
      reason: clearableReason,
    }),
    response: passthrough({}),
    validationMessage: 'A reply needs a subject and some text before AP-Hub can prepare it.',
    invoke: (request) => runCreateReplyDraft(request),
  }),

  defineChannel({
    channel: 'aphub:reply-drafts:update',
    role: ['owner_controller', 'bookkeeper'],
    // PATCH, matching the route verb. `mutation()` does not branch on the method, but the
    // envelope's rule is that the method is declared and never inferred.
    method: 'PATCH',
    pathTemplate: '/api/reply-drafts/:draftId',
    bodyKeys: ['subject', 'bodyText', 'reason'],
    request: strict({
      draftId: entityId,
      subject: emailSubject,
      bodyText: emailBody,
      reason: clearableReason,
    }),
    response: passthrough({}),
    validationMessage: 'A reply needs a subject and some text before AP-Hub can save your changes.',
    invoke: (request, payload) => runUpdateReplyDraft(request, payload.draftId as number),
  }),

  defineChannel({
    channel: 'aphub:reply-drafts:discard',
    role: ['owner_controller', 'bookkeeper'],
    method: 'DELETE',
    pathTemplate: '/api/reply-drafts/:draftId',
    bodyKeys: [],
    request: strict({ draftId: entityId }),
    response: passthrough({}),
    validationMessage: 'AP-Hub could not tell which draft reply to discard. Reload the list and try again.',
    invoke: (request, payload) => runDiscardReplyDraft(request, payload.draftId as number),
  }),
];
