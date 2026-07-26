/**
 * CHUNK_3_IPC — the ACTION barrel. Every mutation in the product, and nothing else.
 *
 * `desktop/main.ts` (integration lead) composes the dispatcher from
 * `{ channels: ACTION_CHANNELS, entries: ACTION_ENTRIES }`. Those two exports are this agent's
 * ENTIRE integration surface — no other file outside `desktop/ipc/action/**` is touched, and
 * nothing under `src/**` is modified. Every channel below calls the SAME exported service wrapper
 * its HTTP route called, with the SAME role, so the authorization funnel
 * (`tokenFromRequest` → `readContext`/`requireSession` → role gate) fires exactly where it fires
 * today. Only the funnel's caller changed.
 *
 * `buildRegistry` asserts `ACTION_CHANNELS` and `ACTION_ENTRIES` are set-equal in BOTH directions
 * (`desktop/ipc/registry.ts:351-360`), and `test/ipc-action-domains.test.ts` asserts it again
 * directly, so the deliberate duplication in the zero-import `channels.ts` cannot drift.
 *
 * ── THE ROLE COLUMN IS READ OFF THE WRAPPER, NOT OFF THE ROUTE MAP ───────────────────────────
 * `runAction` is module-private and has SIX near-identical private clones, each with a different
 * role default: `runOnboardingAction`, `runTaxMappingAction`/`runTaxMappingRead`,
 * `runDimensionMappingAction`/`runDimensionMappingRead`, `action()` (`src/statements/http.ts:18`)
 * and `mutation()` (`src/reply-drafts/http.ts:47`), plus three operations with no shared wrapper
 * at all. Unifying them would be an authorization change disguised as a refactor. Every role
 * below was verified by opening the route file and following it to the `readContext` /
 * `requireSession` call that actually gates it.
 *
 * | channel                                    | HTTP route replaced                                 | exported fn                          | wrapper behind it                       | role the wrapper enforces         |
 * |--------------------------------------------|-----------------------------------------------------|--------------------------------------|-----------------------------------------|-----------------------------------|
 * | aphub:proposals:approve                    | POST /api/proposals/:id/approve                     | runApprove                           | runAction (index.ts:157)                | owner_controller                  |
 * | aphub:proposals:reject                     | POST /api/proposals/:id/reject                      | runReject                            | runAction (index.ts:179)                | owner_controller, bookkeeper      |
 * | aphub:proposals:retry                      | POST /api/proposals/:id/retry                       | runRetry                             | runAction (index.ts:167)                | owner_controller                  |
 * | aphub:corrections:learn                    | POST /api/corrections/learn                         | runLearn                             | runAction (index.ts:226)                | owner_controller, bookkeeper      |
 * | aphub:mappings:remap                       | POST /api/mappings/remap                            | runRemap                             | runAction (index.ts:209)                | owner_controller, bookkeeper      |
 * | aphub:accounting-documents:classify        | POST /api/accounting-documents/:id/classify         | runClassifyDocument                  | inline readContext (doc-review-http:16) | owner_controller, bookkeeper      |
 * | aphub:notifications:read                   | POST /api/notifications/:id/read                    | runMarkNotificationRead              | inline readContext, NO role (notif.:22) | ANY authenticated role            |
 * | aphub:onboarding:step                      | POST /api/onboarding/step                           | runOnboardingStep                    | runOnboardingAction (onboarding.ts:69)  | owner_controller                  |
 * | aphub:onboarding:dry-run                   | POST /api/onboarding/dry-run                        | runOnboardingDryRunAction            | runOnboardingAction (onboarding.ts:79)  | owner_controller                  |
 * | aphub:provider-connections:write-gate      | POST /api/provider-connections/:id/write-gate       | runSetOwnerWriteGate                 | inline readContext (write-gates-http:9) | owner_controller                  |
 * | aphub:replies:send                         | POST /api/replies/:id/send                          | runSendReply                         | runAction (index.ts:267)                | owner_controller                  |
 * | aphub:reply-drafts:create                  | POST /api/reply-drafts                              | runCreateReplyDraft                  | mutation() (reply-drafts/http.ts:52)    | owner_controller, bookkeeper      |
 * | aphub:reply-drafts:update                  | PATCH /api/reply-drafts/:id                         | runUpdateReplyDraft                  | mutation() (reply-drafts/http.ts:52)    | owner_controller, bookkeeper      |
 * | aphub:reply-drafts:discard                 | DELETE /api/reply-drafts/:id                        | runDiscardReplyDraft                 | inline readContext (reply-drafts:122)   | owner_controller, bookkeeper      |
 * | aphub:statements:correct                   | POST /api/statements/:id/correct                    | runCorrectStatement                  | action() (statements/http.ts:24)        | owner_controller, bookkeeper      |
 * | aphub:statements:file                      | POST /api/statements/:id/file                       | runFileStatement                     | action() (statements/http.ts:24)        | owner_controller, bookkeeper      |
 * | aphub:statements:match-line                | POST /api/statements/:id/lines/:lineId/match         | runMatchStatementLine                | action() (statements/http.ts:24)        | owner_controller, bookkeeper      |
 * | aphub:statements:exclude-line              | POST /api/statements/:id/lines/:lineId/exclude       | runExcludeStatementLine              | action() (statements/http.ts:24)        | owner_controller, bookkeeper      |
 * | aphub:tax-mappings:create                  | POST /api/tax-mappings                              | runCreateTaxMapping                  | runTaxMappingAction (taxMappings:54)    | owner_controller                  |
 * | aphub:tax-mappings:edit                    | POST /api/tax-mappings/:id/edit                     | runEditTaxMapping                    | runTaxMappingAction (taxMappings:54)    | owner_controller                  |
 * | aphub:tax-mappings:disable                 | POST /api/tax-mappings/:id/disable                  | runDisableTaxMapping                 | runTaxMappingAction (taxMappings:54)    | owner_controller                  |
 * | aphub:tax-mappings:replace                 | POST /api/tax-mappings/:id/replace                  | runReplaceTaxMapping                 | runTaxMappingAction (taxMappings:54)    | owner_controller                  |
 * | aphub:tax-mappings:revalidate              | POST /api/tax-mappings/:id/revalidate               | runRevalidateTaxMapping              | runTaxMappingAction (taxMappings:54)    | owner_controller                  |
 * | aphub:tax-mappings:discover                | GET  /api/tax-mappings/discover                     | runDiscoverTaxCodes                  | runTaxMappingRead (taxMappings:77)      | owner_controller                  |
 * | aphub:dimension-mappings:accept            | POST /api/dimension-mappings/:id/accept             | runAcceptDimensionMapping            | runDimensionMappingAction (dim.:49)     | owner_controller                  |
 * | aphub:dimension-mappings:correct           | POST /api/dimension-mappings/:id/correct            | runCorrectDimensionMapping           | runDimensionMappingAction (dim.:49)     | owner_controller                  |
 * | aphub:dimension-mappings:reject            | POST /api/dimension-mappings/:id/reject             | runRejectDimensionMapping            | runDimensionMappingAction (dim.:49)     | owner_controller                  |
 * | aphub:dimension-mappings:save-rule         | POST /api/dimension-mappings/:id/save-rule          | runSaveRuleDimensionMapping          | runDimensionMappingAction (dim.:49)     | owner_controller                  |
 * | aphub:dimension-mappings:select-alternate  | POST /api/dimension-mappings/:id/select-alternate   | runSelectAlternateDimensionMapping   | runDimensionMappingAction (dim.:49)     | owner_controller                  |
 * | aphub:provider-jobs:retry                  | POST /api/provider-jobs/:id/retry                   | (none — inline in the route)         | inline requireSession (route.ts:11)     | owner_controller                  |
 *
 * NOT registered, deliberately: `/api/auth/login`, `/api/auth/callback`, `/api/auth/logout` and
 * `/api/connections/{gmail,qbo}/start`. The first three are pre-auth or redirect flows, and
 * `auth/callback` is replaced by CHUNK_5's loopback callback — it must never become an IPC
 * channel (`docs/build/route-to-service-map.md:156-157`).
 */

import type { ChannelContribution, RegistryEntry } from '../registry.js';
import { ACTION_CHANNELS } from './channels.js';
import { accountingDocumentEntries } from './accountingDocuments.js';
import { correctionEntries } from './corrections.js';
import { dimensionMappingEntries } from './dimensionMappings.js';
import { notificationEntries } from './notifications.js';
import { onboardingEntries } from './onboarding.js';
import { proposalEntries } from './proposals.js';
import { providerJobEntries } from './providerJobs.js';
import { replyDraftEntries } from './replyDrafts.js';
import { replyEntries } from './replies.js';
import { statementEntries } from './statements.js';
import { taxMappingEntries } from './taxMappings.js';
import { writeGateEntries } from './writeGates.js';

export { ACTION_CHANNELS } from './channels.js';
export { RECIPIENT_DENY_LIST } from './replies.js';

/** Every action channel's entry. Order is presentational; `buildRegistry` keys by channel. */
export const ACTION_ENTRIES: readonly RegistryEntry[] = Object.freeze([
  ...proposalEntries,
  ...correctionEntries,
  ...accountingDocumentEntries,
  ...notificationEntries,
  ...onboardingEntries,
  ...writeGateEntries,
  ...replyEntries,
  ...replyDraftEntries,
  ...statementEntries,
  ...taxMappingEntries,
  ...dimensionMappingEntries,
  ...providerJobEntries,
]);

/** The contribution `desktop/main.ts` hands to `createDispatcher`. */
export const ACTION_CONTRIBUTION: ChannelContribution = Object.freeze({
  channels: ACTION_CHANNELS,
  entries: ACTION_ENTRIES,
});
