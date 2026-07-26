/**
 * CHUNK_3_IPC — request-field primitives the action domains need beyond the shared set in
 * `desktop/ipc/registry.ts` (`entityId`, `persistedId`, `reason`, `optionalReason`,
 * `shortText`, `filterText`).
 *
 * Every cap here is chosen to match a limit the SERVICE already enforces, so the schema
 * rejects only what the service would have rejected anyway. Where the service accepts an
 * empty string the schema does too: tightening a field is a behaviour change, and the one
 * place it bites is `aphub:provider-connections:write-gate`, where `confirmedCompanyId` and
 * `confirmation` are legitimately `''` on the DISABLE path
 * (`src/accounting/write-gates.ts:13-19` only requires them when `enabled` is true).
 */

import { z } from 'zod';

/** A corrected or proposed field value. Cap mirrors `reason` (`src/statements/review.ts:160`). */
export const valueText = z.string().trim().min(1).max(1000);

/**
 * A corrected fact value that may be cleared. `runCorrectStatement` accepts a string or an
 * explicit `null` and REJECTS `undefined` (`src/statements/http.ts:74-76`: `body.value !== null
 * && typeof body.value !== 'string'` is true for `undefined`), so this is required-but-nullable
 * rather than optional. An empty string is accepted, exactly as the wrapper accepts it.
 */
export const clearableValue = z.union([z.string().trim().max(1000), z.null()]);

/**
 * A string the wrapper only type-checks, and which the service is allowed to see as `''`.
 * Used for the two write-gate confirmation fields.
 */
export function permissiveText(max: number): z.ZodString {
  return z.string().trim().max(max);
}

/** An email subject line. Cap is the service's own (`requireCopy(…, 'subject', 998)`). */
export const emailSubject = z.string().trim().min(1).max(998);

/**
 * An email body. NOT trimmed — trailing newlines are part of the draft the user typed, and
 * `createReplyDraft` stores the value verbatim. Cap is the service's own
 * (`requireCopy(…, 'bodyText', 100_000)`).
 */
export const emailBody = z.string().min(1).max(100_000);

/**
 * A reason that may be explicitly cleared. `runCreateReplyDraft` and `runUpdateReplyDraft`
 * accept `undefined`, `null` or a string (`src/reply-drafts/http.ts:86`, `:105`).
 */
export const clearableReason = z.string().trim().min(1).max(1000).nullable().optional();
