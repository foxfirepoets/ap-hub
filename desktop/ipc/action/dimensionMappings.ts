/**
 * CHUNK_3_IPC — the dimension-mapping review queue: accept, correct, reject, save-rule,
 * select-alternate.
 *
 * Replaces the five `app/api/dimension-mappings/[id]/*` POST routes. `GET /api/dimension-mappings`
 * is a READ and belongs to the read domains.
 *
 * Role: all five are `owner_controller` ONLY, through the private `runDimensionMappingAction`
 * clone, which calls `readContext(request, 'owner_controller')`
 * (`src/services/action/dimensionMappings.ts:49`).
 *
 * ── `select-alternate` NEEDS A REFINEMENT, NOT JUST FIELD TYPES ──────────────────────────────
 * `selectAlternateDimensionMapping` throws `VALIDATION` when NEITHER `providerId` nor
 * `providerLabel` is supplied (`src/services/dimensionMappings.ts:192-194`) — each is individually
 * optional but at least one is mandatory. A schema of two optional fields would let an empty
 * payload through to a network round trip to QuickBooks before failing, so the "at least one of"
 * rule is expressed as a `superRefine`. `defineChannel` sees through the resulting `ZodEffects`
 * wrapper (`desktop/ipc/registry.ts:203-227`).
 * ────────────────────────────────────────────────────────────────────────────────────────────
 */

import { z } from 'zod';

import {
  runAcceptDimensionMapping,
  runCorrectDimensionMapping,
  runRejectDimensionMapping,
  runSaveRuleDimensionMapping,
  runSelectAlternateDimensionMapping,
} from '../../../src/services/action/index.js';
import {
  defineChannel,
  entityId,
  optionalReason,
  passthrough,
  reason,
  shortText,
  strict,
  type RegistryEntry,
} from '../registry.js';
import { valueText } from './fields.js';

/** `mappingJson` at `src/services/action/dimensionMappings.ts:89`. */
const mappingEnvelope = passthrough({ mapping: passthrough({}) });

export const dimensionMappingEntries: readonly RegistryEntry[] = [
  defineChannel({
    channel: 'aphub:dimension-mappings:accept',
    role: ['owner_controller'],
    method: 'POST',
    pathTemplate: '/api/dimension-mappings/:mappingId/accept',
    bodyKeys: ['reason'],
    // Optional — accepting AP-Hub's own proposal needs no justification (`:160`).
    request: strict({ mappingId: entityId, reason: optionalReason }),
    response: mappingEnvelope,
    validationMessage: 'AP-Hub could not tell which suggestion to accept. Reload the list and try again.',
    invoke: (request, payload) => runAcceptDimensionMapping(request, payload.mappingId as number),
  }),

  defineChannel({
    channel: 'aphub:dimension-mappings:correct',
    role: ['owner_controller'],
    method: 'POST',
    pathTemplate: '/api/dimension-mappings/:mappingId/correct',
    bodyKeys: ['normalizedValue', 'reason'],
    request: strict({
      mappingId: entityId,
      // `String(body.normalizedValue ?? '')` at `:185` — an absent value becomes `''` and the
      // service rejects it. Required here so the user gets a sentence instead of a 400.
      normalizedValue: valueText,
      reason: optionalReason,
    }),
    response: mappingEnvelope,
    validationMessage: 'Type the correct value before saving this change.',
    invoke: (request, payload) => runCorrectDimensionMapping(request, payload.mappingId as number),
  }),

  defineChannel({
    channel: 'aphub:dimension-mappings:reject',
    role: ['owner_controller'],
    method: 'POST',
    pathTemplate: '/api/dimension-mappings/:mappingId/reject',
    bodyKeys: ['reason', 'status'],
    request: strict({
      mappingId: entityId,
      // Required: `:206` defaults it to `''` and the service rejects a blank one.
      reason,
      // `:207` is `body.status === 'held' ? 'held' : 'rejected'` — the only two outcomes. Naming
      // them here means a typo'd third value is refused rather than silently becoming 'rejected'.
      status: z.enum(['rejected', 'held']).optional(),
    }),
    response: mappingEnvelope,
    validationMessage: 'Add a short reason before rejecting or holding this suggestion.',
    invoke: (request, payload) => runRejectDimensionMapping(request, payload.mappingId as number),
  }),

  defineChannel({
    channel: 'aphub:dimension-mappings:save-rule',
    role: ['owner_controller'],
    method: 'POST',
    pathTemplate: '/api/dimension-mappings/:mappingId/save-rule',
    bodyKeys: ['reason'],
    request: strict({ mappingId: entityId, reason: optionalReason }),
    // Returns a RULE, not a mapping (`:198`).
    response: passthrough({ rule: passthrough({}) }),
    validationMessage: 'AP-Hub could not save that as a reusable rule. Reload the list and try again.',
    invoke: (request, payload) => runSaveRuleDimensionMapping(request, payload.mappingId as number),
  }),

  defineChannel({
    channel: 'aphub:dimension-mappings:select-alternate',
    role: ['owner_controller'],
    method: 'POST',
    pathTemplate: '/api/dimension-mappings/:mappingId/select-alternate',
    bodyKeys: ['providerId', 'providerLabel', 'reason'],
    request: strict({
      mappingId: entityId,
      providerId: shortText.optional(),
      providerLabel: shortText.optional(),
      reason: optionalReason,
    }).superRefine((value, ctx) => {
      if (value.providerId === undefined && value.providerLabel === undefined) {
        // Mirrors src/services/dimensionMappings.ts:192-194, one network call earlier.
        ctx.addIssue({ code: 'custom', message: 'one alternate must be chosen' });
      }
    }),
    response: mappingEnvelope,
    validationMessage: 'Choose which value this should point to before saving.',
    invoke: (request, payload) =>
      runSelectAlternateDimensionMapping(request, payload.mappingId as number),
  }),
];
