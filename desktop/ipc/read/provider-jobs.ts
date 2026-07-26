import { z } from 'zod';
import { listProviderJobs, runRead } from '../../../src/services/read/index.js';
import { defineChannel, passthrough, strict, type RegistryEntry } from '../registry.js';

/**
 * B3 — GET /api/provider-jobs (owner only, matching the route's `{ role: ['owner_controller'] }`).
 *
 * Every id here is a plain `z.number()`: `DurableProviderJobs`'s `mapJob` explicitly
 * `Number(row.*)`-casts every id-shaped field.
 */
export const providerJobsEntries: readonly RegistryEntry[] = [
  defineChannel({
    channel: 'aphub:provider-jobs:list',
    role: ['owner_controller'],
    method: 'GET',
    pathTemplate: '/api/provider-jobs',
    request: strict({}),
    response: passthrough({
      jobs: z.array(
        passthrough({
          id: z.number(),
          tenantId: z.number(),
          connectionId: z.number(),
          proposalId: z.number().nullable(),
          operation: z.string(),
          requestPayload: z.record(z.unknown()),
          responsePayload: z.record(z.unknown()).nullable(),
          status: z.string(),
          idempotencyKey: z.string(),
          leaseToken: z.string().nullable(),
          leasedAt: z.string().nullable(),
          leaseExpiresAt: z.string().nullable(),
          attempts: z.number(),
          errorCode: z.string().nullable(),
          errorDetail: z.string().nullable(),
          createdAt: z.string(),
          updatedAt: z.string(),
        }),
      ),
    }),
    validationMessage: 'AP-Hub could not load your provider jobs.',
    invoke: (request) => runRead(request, (ctx) => listProviderJobs(ctx.tenantId), { role: ['owner_controller'] }),
  }),
];
