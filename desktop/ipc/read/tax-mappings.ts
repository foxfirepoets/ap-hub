import { z } from 'zod';
import {
  runDiscoverTaxCodes,
  runGetTaxMapping,
  runGetTaxMappingAudit,
  runListTaxMappings,
} from '../../../src/services/action/index.js';
import {
  defineChannel,
  entityId,
  filterText,
  passthrough,
  persistedId,
  shortText,
  strict,
  type RegistryEntry,
} from '../registry.js';

/**
 * B3 — GET /api/tax-mappings, GET /api/tax-mappings/:id, GET /api/tax-mappings/discover,
 * GET /api/tax-mappings/:id/audit. All owner_controller only.
 *
 * `route-to-service-map.md` lists these routes' role as "owner only" but does not mention the
 * mechanism: all four call wrappers exported from `src/services/action/taxMappings.ts` that
 * run through the module-private `runTaxMappingRead` (`taxMappings.ts:74-89`) — a wrapper that
 * HARD-CODES `readContext(request, 'owner_controller')`, not the shared `runRead`. Porting
 * these with a plain `runRead` would widen owner-only tax data to bookkeeper/cpa if the role
 * option were ever passed incorrectly; calling the real, unmodified exported wrapper functions
 * directly removes that risk entirely.
 *
 * `id`/`connectionId`/`supersededById` are `persistedId`: `TaxMappingRow`/`TaxMappingAuditRow`
 * type them `number`, but `mapRow` (`src/mapping/taxMappingStore.ts:50`) passes bigint columns
 * straight through with no `Number()` cast, so pg returns them as strings.
 *
 * Field names on the wire are snake_case, NOT the row's camelCase: `mappingJson`/`auditRowJson`
 * (`src/services/action/taxMappings.ts:91-120`) explicitly remap every field (`connection_id`,
 * `provider_tax_code`, `tax_mapping_id`, ...) before `jsonResponse` serializes it — unlike every
 * other B3 channel, where the service's own camelCase interface goes straight to the wire.
 * Verified against a live query, not assumed from the TS interface.
 *
 * `aphub:tax-mappings:discover`'s response is a deliberately loose `passthrough({})`: it
 * returns one of two unrelated shapes (`{ code, valid, detail?, taxCode? }` when `code` is
 * given, `{ taxCodes: [...] }` otherwise) sourced from QBO's live `TaxCode` entity, which this
 * chunk does not own a schema for.
 */

const taxMappingRow = passthrough({
  id: persistedId,
  connection_id: persistedId,
  provider: z.string(),
  provider_tax_code: z.string(),
  internal_tax_treatment: z.string(),
  tax_mode: z.string(),
  applies_at: z.string(),
  active: z.boolean(),
  needs_revalidation: z.boolean(),
  superseded_by_id: persistedId.nullable(),
  replaced_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

const taxMappingAuditRow = passthrough({
  id: persistedId,
  tax_mapping_id: persistedId,
  connection_id: persistedId,
  provider: z.string(),
  changed_by: persistedId.nullable(),
  action: z.string(),
  reason: z.string().nullable(),
  changed_at: z.string(),
});

export const taxMappingsEntries: readonly RegistryEntry[] = [
  defineChannel({
    channel: 'aphub:tax-mappings:list',
    role: ['owner_controller'],
    method: 'GET',
    pathTemplate: '/api/tax-mappings',
    queryParams: ['connectionId', 'filter', 'provider'],
    request: strict({
      connectionId: entityId.optional(),
      filter: z.enum(['all', 'exception', 'active']).optional(),
      provider: filterText.optional(),
    }),
    response: passthrough({ mappings: z.array(taxMappingRow), filter: z.string() }),
    validationMessage: 'BookScout OS could not load your tax mappings.',
    invoke: (request) => runListTaxMappings(request),
  }),
  defineChannel({
    channel: 'aphub:tax-mappings:get',
    role: ['owner_controller'],
    method: 'GET',
    pathTemplate: '/api/tax-mappings/:id',
    request: strict({ id: entityId }),
    response: passthrough({ mapping: taxMappingRow }),
    validationMessage: 'BookScout OS could not find that tax mapping.',
    invoke: (request, payload) => runGetTaxMapping(request, payload.id as number),
  }),
  defineChannel({
    channel: 'aphub:tax-mappings:discover',
    role: ['owner_controller'],
    method: 'GET',
    pathTemplate: '/api/tax-mappings/discover',
    queryParams: ['code'],
    request: strict({ code: shortText.optional() }),
    response: passthrough({}),
    validationMessage: 'BookScout OS could not check tax codes with your accounting system.',
    invoke: (request) => runDiscoverTaxCodes(request),
  }),
  defineChannel({
    channel: 'aphub:tax-mappings:audit',
    role: ['owner_controller'],
    method: 'GET',
    pathTemplate: '/api/tax-mappings/:id/audit',
    request: strict({ id: entityId }),
    response: passthrough({ audit: z.array(taxMappingAuditRow) }),
    validationMessage: 'BookScout OS could not load the history for that tax mapping.',
    invoke: (request, payload) => runGetTaxMappingAudit(request, payload.id as number),
  }),
];
