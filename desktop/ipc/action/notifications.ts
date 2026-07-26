/**
 * CHUNK_3_IPC — mark one notification read.
 *
 * Replaces `app/api/notifications/[id]/read/route.ts`.
 *
 * ── ROLE: 'any'. THIS IS DELIBERATE AND MUST NOT BE "FIXED". ────────────────────────────────
 *
 * `runMarkNotificationRead` calls `readContext(request)` with **NO role argument**
 * (`src/services/action/notifications.ts:22`), so `requireSession` applies no role gate and any
 * authenticated role — including `cpa`, which otherwise holds `read` only — can mark a
 * notification read. `markNotificationRead` then asserts `ensurePermission(ctx, 'read')`
 * (`src/services/notifications.ts:16`), which every role holds.
 *
 * That is today's real behaviour, and `docs/build/route-to-service-map.md:134` records it as
 * "any authenticated". Declaring `role: ['owner_controller']` here would be a lie about the
 * wrapper AND — because this entry's `invoke` bakes the role into the wrapper it calls — would
 * not actually tighten anything; it would only make the role field, which the contract tests
 * treat as the source of truth for the role matrix, disagree with the code. Narrowing the real
 * behaviour is an unrequested product change and belongs in its own decision, not in a transport
 * port. See the CHUNK_3 handover note.
 * ────────────────────────────────────────────────────────────────────────────────────────────
 */

import { runMarkNotificationRead } from '../../../src/services/action/index.js';
import { defineChannel, entityId, passthrough, strict, type RegistryEntry } from '../registry.js';

export const notificationEntries: readonly RegistryEntry[] = [
  defineChannel({
    channel: 'aphub:notifications:read',
    role: 'any',
    method: 'POST',
    pathTemplate: '/api/notifications/:notificationId/read',
    // The wrapper never parses a body — it goes straight from `readContext` to the service.
    bodyKeys: [],
    request: strict({ notificationId: entityId }),
    response: passthrough({}),
    validationMessage: 'AP-Hub could not tell which message to mark as read. Reload the list and try again.',
    invoke: (request, payload) => runMarkNotificationRead(request, payload.notificationId as number),
  }),
];
