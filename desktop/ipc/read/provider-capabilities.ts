import { z } from 'zod';
import { ROLES } from '../../../src/auth/guard.js';
import { listProviderCapabilities, runRead } from '../../../src/services/read/index.js';
import { defineChannel, passthrough, strict, type RegistryEntry } from '../registry.js';

/**
 * B3 — GET /api/provider-capabilities (all `ROLES`, matching the route's own `{ role: ROLES }`).
 *
 * `id` is a plain `z.number()`: `listProviderCapabilities` explicitly `Number(row.id)`-casts
 * it. `capabilities`/`gaps` come from `assessProviderCapabilities` (`src/accounting/
 * capabilities.ts`), spread onto each connection.
 */
const providerCapability = passthrough({
  provider: z.string(),
  edition: z.string(),
  operation: z.string(),
  supported: z.boolean(),
  reason: z.string().nullable(),
  unsupportedFields: z.array(z.string()),
});

export const providerCapabilitiesEntries: readonly RegistryEntry[] = [
  defineChannel({
    channel: 'aphub:provider-capabilities:list',
    role: ROLES,
    method: 'GET',
    pathTemplate: '/api/provider-capabilities',
    request: strict({}),
    response: passthrough({
      connections: z.array(
        passthrough({
          id: z.number(),
          provider: z.string(),
          connectionClass: z.string(),
          displayName: z.string().nullable(),
          externalCompany: z.string().nullable(),
          status: z.string(),
          lastVerifiedAt: z.string().nullable(),
          writeGateEnabled: z.boolean().nullable(),
          expectedCompanyId: z.string().nullable(),
          observedCompanyId: z.string().nullable(),
          lastContactAt: z.string().nullable(),
          edition: z.string(),
          supported: z.boolean(),
          capabilities: z.array(providerCapability),
          gaps: z.array(z.string()),
        }),
      ),
    }),
    validationMessage: 'BookScout OS could not check what your accounting connection supports.',
    invoke: (request) => runRead(request, (ctx) => listProviderCapabilities(ctx.tenantId), { role: ROLES }),
  }),
];
