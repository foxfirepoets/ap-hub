import { z } from 'zod';
import { getExceptionById, listExceptions, runRead } from '../../../src/services/read/index.js';
import {
  defineChannel,
  entityId,
  filterText,
  passthrough,
  persistedId,
  strict,
  type RegistryEntry,
} from '../registry.js';

/**
 * B3 — GET /api/exceptions (list, filterable by `status`) and GET /api/exceptions/:id.
 * Any authenticated role. `id` is `persistedId`: `ExceptionRow.id` is typed `number` but comes
 * straight off the `bigserial exceptions.id` column, which pg returns as a string.
 */

const exceptionRow = passthrough({
  id: persistedId,
  entityRef: z.string().nullable(),
  reasonCode: z.string(),
  detail: z.unknown(),
  status: z.string(),
  resolvedBy: z.string().nullable(),
  resolution: z.unknown(),
  createdAt: z.string(),
  resolvedAt: z.string().nullable(),
});

export const exceptionsEntries: readonly RegistryEntry[] = [
  defineChannel({
    channel: 'aphub:exceptions:list',
    role: 'any',
    method: 'GET',
    pathTemplate: '/api/exceptions',
    queryParams: ['status'],
    request: strict({ status: filterText.optional() }),
    response: z.array(exceptionRow),
    validationMessage: 'BookScout OS could not load your exceptions.',
    invoke: (request, payload) =>
      runRead(request, (ctx) => listExceptions(ctx.tenantId, { status: payload.status as string | undefined })),
  }),
  defineChannel({
    channel: 'aphub:exceptions:get',
    role: 'any',
    method: 'GET',
    pathTemplate: '/api/exceptions/:id',
    request: strict({ id: entityId }),
    response: exceptionRow,
    validationMessage: 'BookScout OS could not find that exception.',
    invoke: (request, payload) => runRead(request, (ctx) => getExceptionById(ctx.tenantId, payload.id as number)),
  }),
];
