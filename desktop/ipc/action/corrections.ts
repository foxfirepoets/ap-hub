/**
 * CHUNK_3_IPC — learn-forever corrections and reusable mapping rules.
 *
 * Replaces `app/api/corrections/learn/route.ts` and `app/api/mappings/remap/route.ts`.
 *
 * Roles, verified in the wrapper:
 *   runLearn → runAction(request, ['owner_controller','bookkeeper'], …)  index.ts:226
 *   runRemap → runAction(request, ['owner_controller','bookkeeper'], …)  index.ts:209
 *
 * Both hold the `learn` / `remap` permissions in the RBAC matrix (`src/auth/guard.ts:16-39`),
 * so `cpa` — which holds `read` only — is refused by the wrapper, not by this file.
 *
 * `mapping` on the learn channel is a NESTED object and is `.strict()` too. `parseMapping`
 * (index.ts:192) reads six named keys and ignores the rest, so a non-strict nested object would
 * be a bag for arbitrary caller-supplied keys with no destination — the same silent-drop class
 * of bug `defineChannel`'s rule 4 exists to prevent, one level down.
 */

import { z } from 'zod';

import { runLearn, runRemap } from '../../../src/services/action/index.js';
import {
  defineChannel,
  entityId,
  passthrough,
  persistedId,
  shortText,
  strict,
  type RegistryEntry,
} from '../registry.js';
import { valueText } from './fields.js';

/** The six keys `parseMapping` reads. `kind` and `sourceKey` are the two it requires. */
const mappingInput = strict({
  kind: shortText,
  sourceKey: shortText,
  targetQboType: shortText.optional(),
  targetQboId: shortText.optional(),
  targetName: shortText.optional(),
  remember: z.boolean().optional(),
});

export const correctionEntries: readonly RegistryEntry[] = [
  defineChannel({
    channel: 'aphub:corrections:learn',
    role: ['owner_controller', 'bookkeeper'],
    method: 'POST',
    pathTemplate: '/api/corrections/learn',
    bodyKeys: ['proposalId', 'exceptionId', 'field', 'newValue', 'remember', 'mapping'],
    request: strict({
      // `field` and `newValue` are the two the wrapper requires (index.ts:229).
      field: shortText,
      newValue: valueText,
      // Ids are `numOrUndef` at index.ts:232-233 — optional, and never both required.
      proposalId: entityId.optional(),
      exceptionId: entityId.optional(),
      remember: z.boolean().optional(),
      mapping: mappingInput.optional(),
    }),
    // `became_rule` and `rule_applied` are documented in the wrapper but not narrowed here:
    // the response is passthrough, so they still reach the renderer untouched.
    response: passthrough({ correction_id: persistedId }),
    validationMessage:
      'AP-Hub needs to know which detail you changed and what it should say now. Fill both in and try again.',
    invoke: (request) => runLearn(request),
  }),

  defineChannel({
    channel: 'aphub:mappings:remap',
    role: ['owner_controller', 'bookkeeper'],
    method: 'POST',
    pathTemplate: '/api/mappings/remap',
    bodyKeys: ['kind', 'sourceKey', 'targetQboType', 'targetQboId', 'targetName', 'remember'],
    request: strict({
      kind: shortText,
      sourceKey: shortText,
      targetQboType: shortText.optional(),
      targetQboId: shortText.optional(),
      targetName: shortText.optional(),
      remember: z.boolean().optional(),
    }),
    response: passthrough({ kind: z.string(), source_key: z.string() }),
    validationMessage: 'AP-Hub needs to know what to match and what to match it to. Fill both in and try again.',
    invoke: (request) => runRemap(request),
  }),
];
