import { z } from 'zod';
import { runListDimensionMappings } from '../../../src/services/action/index.js';
import { defineChannel, entityId, filterText, passthrough, persistedId, strict, type RegistryEntry } from '../registry.js';

/**
 * B3 — GET /api/dimension-mappings (owner_controller only).
 *
 * `route-to-service-map.md` lists this route's role as "owner only" but does not mention the
 * mechanism: the route calls `runListDimensionMappings` (`src/services/action/
 * dimensionMappings.ts:141`), which runs through the module-private `runDimensionMappingRead`
 * (`dimensionMappings.ts:69-87`) — a wrapper that HARD-CODES `readContext(request,
 * 'owner_controller')`, not the shared `runRead`. Porting this with a plain `runRead` (even
 * with `{ role: ['owner_controller'] }`) would still be correct here, but the two are NOT
 * interchangeable in general — `runDimensionMappingRead` also maps `ServiceError` codes onto
 * HTTP statuses (`serviceErrorResponse`) the way `runRead` does not. This channel therefore
 * calls the real, unmodified exported wrapper directly rather than re-deriving the read path.
 *
 * `id`/`connectionId`/`proposalId` are `persistedId`: `DimensionMappingRow` types them
 * `number`, but `mapRow` (`src/mapping/dimensionMappingStore.ts:76`) passes bigint columns
 * straight through with no `Number()` cast, so pg returns them as strings.
 *
 * Field names on the wire are snake_case, NOT the row's camelCase: `mappingJson`
 * (`src/services/action/dimensionMappings.ts:89-112`) explicitly remaps every field
 * (`connection_id`, `proposal_id`, `dimension_type`, ...) before `jsonResponse` serializes it —
 * unlike every other B3 channel, where the service's own camelCase interface goes straight to
 * the wire. Verified against a live query, not assumed from the TS interface.
 */
export const dimensionMappingsEntries: readonly RegistryEntry[] = [
  defineChannel({
    channel: 'aphub:dimension-mappings:list',
    role: ['owner_controller'],
    method: 'GET',
    pathTemplate: '/api/dimension-mappings',
    queryParams: ['connectionId', 'dimensionType', 'reviewStatus', 'resolutionState', 'provider'],
    request: strict({
      connectionId: entityId.optional(),
      dimensionType: filterText.optional(),
      reviewStatus: filterText.optional(),
      resolutionState: filterText.optional(),
      provider: filterText.optional(),
    }),
    response: passthrough({
      mappings: z.array(
        passthrough({
          id: persistedId,
          connection_id: persistedId,
          provider: z.string(),
          proposal_id: persistedId,
          dimension_type: z.string(),
          raw_value: z.string(),
          normalized_value: z.string().nullable(),
          source_evidence: z.record(z.unknown()),
          extraction_confidence: z.number(),
          proposed_provider_id: z.string().nullable(),
          proposed_match_label: z.string().nullable(),
          provider_id: z.string().nullable(),
          mapping_method: z.string().nullable(),
          review_status: z.string(),
          resolution_state: z.string(),
          active: z.boolean(),
          mapping_version: z.number(),
          revalidated_at: z.string().nullable(),
          created_at: z.string(),
          updated_at: z.string(),
        }),
      ),
    }),
    validationMessage: 'BookScout OS could not load the dimension mapping review queue.',
    invoke: (request) => runListDimensionMappings(request),
  }),
];
