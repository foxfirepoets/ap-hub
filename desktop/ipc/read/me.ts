import { z } from 'zod';
import { runRead } from '../../../src/services/read/index.js';
import { defineChannel, passthrough, persistedId, strict, type RegistryEntry } from '../registry.js';

/** B3 — GET /api/me (any authenticated role). Echoes the resolved session, nothing else. */
export const meEntries: readonly RegistryEntry[] = [
  defineChannel({
    channel: 'aphub:me:get',
    role: 'any',
    method: 'GET',
    pathTemplate: '/api/me',
    request: strict({}),
    // `tenantId` is `persistedId`: `ctx.tenantId` comes off a bigint session column, so pg
    // returns it as a string even though `AuthContext.tenantId` is typed `number`.
    response: passthrough({ email: z.string(), role: z.string(), tenantId: persistedId }),
    validationMessage: 'BookScout OS could not confirm your sign-in.',
    invoke: (request) =>
      runRead(request, async (ctx) => ({ email: ctx.email, role: ctx.role, tenantId: ctx.tenantId })),
  }),
];
