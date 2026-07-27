import { z } from 'zod';
import { ROLES } from '../../../src/auth/guard.js';
import { listConnectionStatuses, runRead } from '../../../src/services/read/index.js';
import { defineChannel, passthrough, strict, type RegistryEntry } from '../registry.js';

/**
 * CHUNK_5_CONNECT — GET /api/connections/status (any signed-in role, matching the route's own
 * `ROLES`). `id` is a plain `z.number()`: `listConnectionStatuses` explicitly `Number(row.id)`-casts it.
 */
export const connectionsReadEntries: readonly RegistryEntry[] = [
  defineChannel({
    channel: 'aphub:connections:status',
    role: ROLES,
    method: 'GET',
    pathTemplate: '/api/connections/status',
    request: strict({}),
    response: z.array(
      passthrough({
        id: z.number(),
        provider: z.string(),
        connectionClass: z.string(),
        displayName: z.string().nullable(),
        externalCompany: z.string().nullable(),
        status: z.string(),
        updatedAt: z.string(),
      }),
    ),
    validationMessage: 'AP-Hub could not check your connected accounts right now.',
    invoke: (request) => runRead(request, (ctx) => listConnectionStatuses(ctx.tenantId), { role: ROLES }),
  }),
];
