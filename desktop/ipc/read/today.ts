import { z } from 'zod';
import { getToday, runRead } from '../../../src/services/read/index.js';
import { defineChannel, passthrough, persistedId, strict, type RegistryEntry } from '../registry.js';

/**
 * B3 — GET /api/today (any authenticated role). The route inlines `runRead` with no
 * separate exported wrapper, so this invoke replicates that one-liner exactly rather than
 * editing `src/**`.
 *
 * `proposalId` and `tenantId` use `persistedId`, not `z.number()`: `getToday` returns
 * `proposal_id`/`tenant_id` straight off `bigserial` columns, which pg hands back as strings
 * (`migrations/001_init.sql`), even though `TodayItem`/`TodayDigest` are typed `number`.
 */

const todayItem = passthrough({
  proposalId: persistedId,
  status: z.string(),
  confidence: z.number(),
  vendor: z.string().nullable(),
  total: z.string().nullable(),
  docNumber: z.string().nullable(),
  sourceFilename: z.string().nullable(),
  emailSubject: z.string().nullable(),
  createdAt: z.string(),
});

export const todayEntries: readonly RegistryEntry[] = [
  defineChannel({
    channel: 'aphub:today:get',
    role: 'any',
    method: 'GET',
    pathTemplate: '/api/today',
    request: strict({}),
    response: passthrough({
      tenantId: persistedId,
      generatedAt: z.string(),
      counts: passthrough({
        exceptions: z.number(),
        posted: z.number(),
        held: z.number(),
        failed: z.number(),
      }),
      items: z.array(todayItem),
    }),
    validationMessage: 'AP-Hub could not load your Today view.',
    invoke: (request) => runRead(request, (ctx) => getToday(ctx.tenantId)),
  }),
];
