import { z } from 'zod';
import { listNotifications, runRead } from '../../../src/services/read/index.js';
import { defineChannel, passthrough, persistedId, strict, type RegistryEntry } from '../registry.js';

/**
 * B3 — GET /api/notifications (any authenticated role), filterable by `unreadOnly`.
 *
 * The HTTP route reads `?unread=true` off the URL directly; this invoke reads the already
 * zod-validated `payload.unreadOnly` instead of re-parsing `request.url`, since the invoke
 * closure calls `listNotifications` itself (there is no separate exported route wrapper to
 * reuse here) — same end result, one fewer string-boolean round trip.
 *
 * `id` is `persistedId`: `NotificationRow.id` is typed `number` but comes off the `bigserial
 * notifications.id` column, which pg returns as a string.
 */
export const notificationsEntries: readonly RegistryEntry[] = [
  defineChannel({
    channel: 'aphub:notifications:list',
    role: 'any',
    method: 'GET',
    pathTemplate: '/api/notifications',
    queryParams: ['unreadOnly'],
    request: strict({ unreadOnly: z.boolean().optional() }),
    response: z.array(
      passthrough({
        id: persistedId,
        kind: z.string(),
        severity: z.string(),
        payload: z.record(z.unknown()),
        digestBatch: z.string().nullable(),
        readAt: z.string().nullable(),
        createdAt: z.string(),
      }),
    ),
    validationMessage: 'AP-Hub could not load your notifications.',
    invoke: (request, payload) =>
      runRead(request, (ctx) => listNotifications(ctx.tenantId, { unreadOnly: payload.unreadOnly === true })),
  }),
];
