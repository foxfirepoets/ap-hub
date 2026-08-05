/**
 * CHUNK_3_IPC — bank-statement review: correct a fact, file the statement, match or exclude a
 * line.
 *
 * Replaces the four `app/api/statements/**` POST routes. `GET /api/statements` and
 * `GET /api/statements/:id` are READS and belong to the read domains.
 *
 * Role: all four go through the private `action()` clone (`src/statements/http.ts:18`), which
 * calls `readContext(request, ['owner_controller', 'bookkeeper'])` at `:24`. `cpa` can READ
 * statements (the read routes pass all three roles) but cannot change one — a distinction that
 * disappears the moment these wrappers are unified.
 *
 * `action()` calls `request.json()` UNCONDITIONALLY at `:30`, so `aphub:statements:file` — which
 * has no fields at all — must still be sent a body. `synthesize` sends `'{}'` for every non-GET
 * method (`desktop/ipc/envelope.ts:110-116`), which is precisely why that rule exists.
 *
 * `reason` is required on three of the four, so the requirement is enforced before the service is
 * reached rather than surfacing as a `ServiceError` from inside a transaction.
 */

import { z } from 'zod';

import {
  runCorrectStatement,
  runExcludeStatementLine,
  runFileStatement,
  runMatchStatementLine,
} from '../../../src/statements/http.js';
import {
  defineChannel,
  entityId,
  passthrough,
  reason,
  shortText,
  strict,
  type RegistryEntry,
} from '../registry.js';
import { clearableValue } from './fields.js';

/** Every `action()` handler answers `jsonResponse({ ok: true })` (`src/statements/http.ts:33`). */
const okResponse = passthrough({ ok: z.boolean() });

export const statementEntries: readonly RegistryEntry[] = [
  defineChannel({
    channel: 'aphub:statements:correct',
    role: ['owner_controller', 'bookkeeper'],
    method: 'POST',
    pathTemplate: '/api/statements/:statementId/correct',
    bodyKeys: ['field', 'value', 'reason'],
    request: strict({
      statementId: entityId,
      field: shortText,
      // Required, and nullable — see `clearableValue`. `undefined` is a 400 at
      // `src/statements/http.ts:74-76`, so it must not be `.optional()` here.
      value: clearableValue,
      reason,
    }),
    response: okResponse,
    validationMessage: 'Choose which detail to change, what it should say, and add a short reason.',
    invoke: (request, payload) => runCorrectStatement(request, payload.statementId as number),
  }),

  defineChannel({
    channel: 'aphub:statements:file',
    role: ['owner_controller', 'bookkeeper'],
    method: 'POST',
    pathTemplate: '/api/statements/:statementId/file',
    // No fields. The body is still sent as '{}' because `action()` parses one unconditionally.
    bodyKeys: [],
    request: strict({ statementId: entityId }),
    response: okResponse,
    validationMessage: 'BookScout OS could not tell which statement to file. Reload the list and try again.',
    invoke: (request, payload) => runFileStatement(request, payload.statementId as number),
  }),

  defineChannel({
    channel: 'aphub:statements:match-line',
    role: ['owner_controller', 'bookkeeper'],
    method: 'POST',
    pathTemplate: '/api/statements/:statementId/lines/:lineId/match',
    bodyKeys: ['providerRef', 'reason'],
    request: strict({
      statementId: entityId,
      lineId: entityId,
      // NESTED AND STRICT. `objectBody` (`src/statements/http.ts:50`) accepts ANY object and
      // forwards it whole into `matched_provider_ref`, so a non-strict shape here would let the
      // renderer write arbitrary keys into an audited column. The only shape the product
      // produces is `{ transactionId }` (`app/(app)/statements/[id]/page.tsx:146`).
      providerRef: strict({ transactionId: shortText }),
      reason,
    }),
    response: okResponse,
    validationMessage:
      'Enter the matching QuickBooks reference and add a short reason before matching this line.',
    invoke: (request, payload) =>
      runMatchStatementLine(request, payload.statementId as number, payload.lineId as number),
  }),

  defineChannel({
    channel: 'aphub:statements:exclude-line',
    role: ['owner_controller', 'bookkeeper'],
    method: 'POST',
    pathTemplate: '/api/statements/:statementId/lines/:lineId/exclude',
    bodyKeys: ['reason'],
    request: strict({ statementId: entityId, lineId: entityId, reason }),
    response: okResponse,
    validationMessage: 'Add a short reason before leaving this line out.',
    invoke: (request, payload) =>
      runExcludeStatementLine(request, payload.statementId as number, payload.lineId as number),
  }),
];
