import { z } from 'zod';
import { listAudit, runRead } from '../../../src/services/read/index.js';
import { defineChannel, filterText, passthrough, persistedId, strict, type RegistryEntry } from '../registry.js';

/**
 * B3 — GET /api/audit (any authenticated role), filterable by `action`/`entity`.
 * `id` is `persistedId`: `AuditRow.id` is typed `number` but comes off the `bigserial
 * audit_log.id` column, which pg returns as a string.
 */
export const auditEntries: readonly RegistryEntry[] = [
  defineChannel({
    channel: 'aphub:audit:list',
    role: 'any',
    method: 'GET',
    pathTemplate: '/api/audit',
    queryParams: ['action', 'entity'],
    request: strict({ action: filterText.optional(), entity: filterText.optional() }),
    response: z.array(
      passthrough({
        id: persistedId,
        actor: z.string(),
        action: z.string(),
        entity: z.string().nullable(),
        realm: z.string().nullable(),
        detail: z.unknown(),
        at: z.string(),
      }),
    ),
    validationMessage: 'AP-Hub could not load your audit trail.',
    invoke: (request, payload) =>
      runRead(request, (ctx) =>
        listAudit(ctx.tenantId, {
          action: payload.action as string | undefined,
          entity: payload.entity as string | undefined,
        }),
      ),
  }),
];
