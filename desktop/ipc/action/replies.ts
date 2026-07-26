/**
 * CHUNK_3_IPC — release ONE held gatekeeper forward. The send-lockdown channel (guarantee 2).
 *
 * Replaces `app/api/replies/[id]/send/route.ts`.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════
 * READ `.ralph/guardrails.md` (the email carve-out) BEFORE TOUCHING THIS FILE.
 *
 * There is EXACTLY ONE provider-send call site in AP-Hub: `sendForward` in
 * `src/gmail/adapter.ts`, reachable only through `createLockedForwarder`
 * (`src/gatekeeper/forwarder.ts`), which binds its single recipient AT CONSTRUCTION and takes no
 * recipient parameter. `sendReply` (`src/services/reply.ts:43`) has no recipient parameter
 * either; it calls `d.forwarder.forward(gmailMessageId)` and nothing else
 * (`src/services/reply.ts:61`). This channel therefore decides only WHICH held forward is
 * released — never WHERE it goes.
 *
 * This file adds NO send path, NO recipient parameter, and does not touch the forwarder. It
 * reproduces the route's recipient deny-list, and nothing more.
 * ════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ── THE DENY-LIST, AND WHY IT IS STATED TWICE ───────────────────────────────────────────────
 * `runSendReply` rejects a body containing ANY of the eleven names in `RECIPIENT_FIELDS`
 * (`src/services/action/index.ts:252-264`) with a 400. The check is PRESENCE-based: the value is
 * irrelevant, the attempt is the defect.
 *
 * Over IPC that control is reproduced by two independent mechanisms, on purpose:
 *
 *  1. `.strict()` — the schema declares exactly one key, `replyId`. Every one of the eleven
 *     names is an unknown key and is rejected with `VALIDATION` before any `src/**` code runs.
 *     (`email` is additionally an identity-shaped field and is refused one step earlier still,
 *     at `desktop/ipc/dispatcher.ts:122`.)
 *  2. The `superRefine` below — an EXPLICIT, named, presence-based deny-list carrying the same
 *     eleven names as the service.
 *
 * (2) is not redundant ceremony. `.strict()` protects this channel only as long as the schema
 * stays single-key; the day someone adds a legitimate optional field, strictness would still
 * hold but the reviewer's guarantee would have quietly become "no one added the wrong key yet".
 * The explicit list is the control that survives that edit, and it is what
 * `test/ipc-action-domains.test.ts` asserts field by field.
 *
 * `runSendReply`'s own check remains in place and untouched, so the control fires twice on the
 * IPC path and once on any path that still reaches the wrapper directly.
 * ────────────────────────────────────────────────────────────────────────────────────────────
 *
 * Role: `runSendReply` → `runAction(request, 'owner_controller', …)` (`index.ts:267`). Not
 * `bookkeeper` — `bookkeeper` holds `draft_reply`, not `reply`.
 */

import { z } from 'zod';

import { runSendReply } from '../../../src/services/action/index.js';
import {
  defineChannel,
  entityId,
  passthrough,
  persistedId,
  strict,
  type RegistryEntry,
} from '../registry.js';

/**
 * Verbatim `RECIPIENT_FIELDS` from `src/services/action/index.ts:252-264`. Any field that could
 * redirect a send. Exported so the contract test asserts against this list rather than a copy of
 * it, and so a divergence from the service's list is visible in one place.
 */
export const RECIPIENT_DENY_LIST: readonly string[] = Object.freeze([
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
]);

/**
 * The zod issue a deny-list hit raises. Developer-facing only — the dispatcher NEVER derives a
 * renderer message from `ZodError.issues` (`desktop/ipc/registry.ts:101-104`) — and it names no
 * field, so it stays safe even if that ever changed.
 */
const NO_RECIPIENT_ISSUE = 'this channel accepts no recipient field';

/**
 * The ONE sentence the renderer sees for any schema failure on this channel. It has to be true
 * for both realistic causes — a deny-listed field, and an unusable reply id — so it states the
 * rule rather than the fault, and gives a next action either way.
 */
const SEND_VALIDATION_MESSAGE =
  'AP-Hub can only send this reply exactly as it was prepared, to the address it was prepared for. Reopen the reply and send it again, or discard it.';

export const replyEntries: readonly RegistryEntry[] = [
  defineChannel({
    channel: 'aphub:replies:send',
    role: ['owner_controller'],
    method: 'POST',
    pathTemplate: '/api/replies/:replyId/send',
    // No body key at all. There is no field on this channel that could carry a recipient,
    // because there is no field on this channel.
    bodyKeys: [],
    request: strict({ replyId: entityId }).superRefine((value, ctx) => {
      // Presence, not value — mirroring `Object.prototype.hasOwnProperty.call(body, f)` at
      // `src/services/action/index.ts:268`.
      for (const field of RECIPIENT_DENY_LIST) {
        if (Object.prototype.hasOwnProperty.call(value, field)) {
          ctx.addIssue({ code: 'custom', message: NO_RECIPIENT_ISSUE });
        }
      }
    }),
    // `to` here is the response echo of the LOCKED recipient the forwarder chose
    // (`src/services/reply.ts:63`), never an input. It is left in the payload because the
    // confirmation screen shows the user where the item went.
    response: passthrough({ forward_id: persistedId, to: z.string(), send_id: z.string() }),
    validationMessage: SEND_VALIDATION_MESSAGE,
    invoke: (request, payload) => runSendReply(request, payload.replyId as number),
  }),
];
