/**
 * CHUNK_3_IPC — tax mappings: create, edit, disable, replace, revalidate, and provider discovery.
 *
 * Replaces `POST /api/tax-mappings`, the four `POST /api/tax-mappings/[id]/*` routes and
 * `GET /api/tax-mappings/discover`. The plain `GET /api/tax-mappings`, `GET /api/tax-mappings/:id`
 * and `GET /api/tax-mappings/:id/audit` are READS and belong to the read domains.
 *
 * Role: every one of these is `owner_controller` ONLY. Verified in the wrappers, which are two
 * different private clones in the same file:
 *
 *   runCreateTaxMapping / runEditTaxMapping / runDisableTaxMapping /
 *   runReplaceTaxMapping / runRevalidateTaxMapping
 *       → runTaxMappingAction  → readContext(request, 'owner_controller')  taxMappings.ts:54
 *   runDiscoverTaxCodes
 *       → runTaxMappingRead    → readContext(request, 'owner_controller')  taxMappings.ts:77
 *
 * `aphub:tax-mappings:discover` is the odd one in this file: it is a GET that reaches QuickBooks
 * read-only, and it therefore goes through the READ clone, not the action clone. It is registered
 * here anyway because it is owner-gated provider I/O in the mapping domain and the CHUNK_3
 * assignment places it with the tax-mapping operations. It declares `method: 'GET'` and no body
 * keys, so `synthesize` sends no body — `runTaxMappingRead` never parses one.
 *
 * String fields are `shortText`, not enums: `internalTaxTreatment` and `taxMode` are validated by
 * `src/services/taxMappings.ts`, and encoding its allowlist here would silently reject a value the
 * service later adds.
 */

import {
  runCreateTaxMapping,
  runDisableTaxMapping,
  runDiscoverTaxCodes,
  runEditTaxMapping,
  runReplaceTaxMapping,
  runRevalidateTaxMapping,
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

/** One mapping row, as `mappingJson` shapes it (`src/services/action/taxMappings.ts:91`). */
const mappingEnvelope = passthrough({ mapping: passthrough({}) });

export const taxMappingEntries: readonly RegistryEntry[] = [
  defineChannel({
    channel: 'aphub:tax-mappings:create',
    role: ['owner_controller'],
    method: 'POST',
    pathTemplate: '/api/tax-mappings',
    bodyKeys: [
      'connectionId',
      'provider',
      'providerTaxCode',
      'internalTaxTreatment',
      'taxMode',
      'appliesAt',
      'reason',
    ],
    request: strict({
      // A BODY key here, not a path param: the create route is the collection root.
      // `numField` (`taxMappings.ts:122`) throws unless it is finite.
      connectionId: entityId,
      // `String(body.x ?? '')` at `:151-154` turns an absent field into `''`, which
      // `createTaxMapping` then rejects. Required here so the refusal happens before the
      // service and carries a sentence the user can act on.
      provider: shortText,
      providerTaxCode: shortText,
      internalTaxTreatment: shortText,
      taxMode: shortText,
      appliesAt: shortText.optional(),
      reason: optionalReason,
    }),
    response: mappingEnvelope,
    validationMessage:
      'AP-Hub needs the accounting connection and the full tax details before it can save this rule.',
    invoke: (request) => runCreateTaxMapping(request),
  }),

  defineChannel({
    channel: 'aphub:tax-mappings:edit',
    role: ['owner_controller'],
    method: 'POST',
    pathTemplate: '/api/tax-mappings/:taxMappingId/edit',
    bodyKeys: ['internalTaxTreatment', 'taxMode', 'appliesAt', 'reason'],
    request: strict({
      taxMappingId: entityId,
      // All three optional at `:187-189` — the screen changes one at a time.
      internalTaxTreatment: shortText.optional(),
      taxMode: shortText.optional(),
      appliesAt: shortText.optional(),
      // Required: `:190` defaults it to `''` and `editTaxMapping` rejects a blank one.
      reason,
    }),
    response: mappingEnvelope,
    validationMessage: 'Add a short reason before changing this tax rule.',
    invoke: (request, payload) => runEditTaxMapping(request, payload.taxMappingId as number),
  }),

  defineChannel({
    channel: 'aphub:tax-mappings:disable',
    role: ['owner_controller'],
    method: 'POST',
    pathTemplate: '/api/tax-mappings/:taxMappingId/disable',
    bodyKeys: ['reason'],
    request: strict({ taxMappingId: entityId, reason }),
    response: mappingEnvelope,
    validationMessage: 'Add a short reason before turning this tax rule off.',
    invoke: (request, payload) => runDisableTaxMapping(request, payload.taxMappingId as number),
  }),

  defineChannel({
    channel: 'aphub:tax-mappings:replace',
    role: ['owner_controller'],
    method: 'POST',
    pathTemplate: '/api/tax-mappings/:taxMappingId/replace',
    bodyKeys: ['providerTaxCode', 'internalTaxTreatment', 'taxMode', 'appliesAt', 'reason'],
    request: strict({
      taxMappingId: entityId,
      providerTaxCode: shortText.optional(),
      internalTaxTreatment: shortText,
      taxMode: shortText,
      appliesAt: shortText.optional(),
      reason,
    }),
    // Replace never deletes: it returns the superseded row alongside the new one (`:219`).
    response: passthrough({ old: passthrough({}), replacement: passthrough({}) }),
    validationMessage:
      'AP-Hub needs the new tax details and a short reason before it can replace this rule.',
    invoke: (request, payload) => runReplaceTaxMapping(request, payload.taxMappingId as number),
  }),

  defineChannel({
    channel: 'aphub:tax-mappings:revalidate',
    role: ['owner_controller'],
    method: 'POST',
    pathTemplate: '/api/tax-mappings/:taxMappingId/revalidate',
    bodyKeys: ['reason'],
    // `reason` is OPTIONAL here and required on the other three. `:227` passes `undefined` when
    // it is absent rather than `''`, and the route comment says so. Do not "make it consistent".
    request: strict({ taxMappingId: entityId, reason: optionalReason }),
    response: mappingEnvelope,
    validationMessage: 'AP-Hub could not tell which tax rule to re-check. Reload the list and try again.',
    invoke: (request, payload) => runRevalidateTaxMapping(request, payload.taxMappingId as number),
  }),

  defineChannel({
    channel: 'aphub:tax-mappings:discover',
    role: ['owner_controller'],
    // GET: read-only provider discovery. `runTaxMappingRead` parses no body, and a GET with a
    // body would throw in the `Request` constructor.
    method: 'GET',
    pathTemplate: '/api/tax-mappings/discover',
    // Read from `new URL(request.url).searchParams` at `taxMappings.ts:238`, so it must reach the
    // URL, not a body. Omitted when absent — the wrapper branches on `if (code)`, where `''`
    // would be falsy but the string `'null'` would not.
    queryParams: ['code'],
    bodyKeys: [],
    request: strict({ code: shortText.optional() }),
    // Two shapes: `{ taxCodes: [...] }` for a full discovery, `{ code, ...validation }` for a
    // single check. Left open so neither fails closed.
    response: passthrough({}),
    validationMessage: 'AP-Hub could not look up that tax code. Check it and try again.',
    invoke: (request) => runDiscoverTaxCodes(request),
  }),
];
