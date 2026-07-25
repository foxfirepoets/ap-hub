# CHUNK_5_PAGEREDESIGN: Collapse the wizard to one "Connect your accounts" screen; auto-complete the rest; final gate

## Summary

The final chunk. Replaces the `connect_gmail`/`connect_qbo`/`select_company`/`configure_mode`/`automation_level`(intro) screens with ONE "Connect your accounts" screen showing two real Connect actions (linking to CHUNK_4's start routes) with an inline guided pop-up per action. Once both connections are genuinely true (detected via `?connected=gmail|qbo` on return, and via `state.connections` on any load), the page automatically walks the remaining step machine and runs the dry-run with zero further required clicks, landing on one combined summary screen. Also runs the full repo gate and confirms zero drift into any guarantee-bearing file.

## Acceptance Criteria

- [ ] The onboarding page (after the existing welcome overlay) shows exactly ONE screen requiring user action before auto-completion: "Connect your accounts", with two real, distinct Connect links/buttons (`/api/connections/gmail/start`, `/api/connections/qbo/start`).
- [ ] Each connect action shows an inline guided pop-up/panel (via a new `app/components/ConnectPrompt.tsx`) explaining what will happen before the click, and a live status (Not connected / Connected ✓) after.
- [ ] On mount, if the URL has `?connected=gmail|qbo`, the page re-fetches `GET /api/onboarding` immediately and then strips the query param (no re-trigger on refresh).
- [ ] On mount, if the URL has `?connect_error=gmail|qbo&reason=...`, the relevant `ConnectPrompt` shows a friendly error (reusing the existing `friendlyOnboardingError`-style pattern where it fits, or a small dedicated mapping for connect-specific reason codes) with a retry link back to the start route.
- [ ] The instant `state.connections.gmailConnected && state.connections.qboConnected` are both true (checked on every load, not only right after a redirect — covers the "returning owner, one connection already done" case), the page automatically calls `POST /api/onboarding/step` through the remaining intermediate step values (existing endpoint, unchanged contract) and then `POST /api/onboarding/dry-run` (existing `runDryRun`, unchanged), with a brief "Setting up…" state shown meanwhile.
- [ ] The summary screen (replacing the old separate `review_sample`/`approve_rules`/`complete` screens) shows, all on one screen: the dry-run's real counts, an inline `EvidencePanel` for a sample proposal (existing component, reused), an inline `RemapForm` to optionally approve a rule (existing component, reused, optional — not blocking), and a note that `automationLevel === 'off'` with a link to Settings.
- [ ] `automation_level` is never set to anything other than `'off'` by this automatic flow — no screen asks the user to choose it here.
- [ ] `npm run web:build` compiles; route count increases by exactly 2 versus the pre-CHUNK_4 baseline (the two new start routes; no new page route).
- [ ] `test/onboarding.test.ts` (11 tests) passes unmodified.
- [ ] Full gate `npm run migrate:up && npm run lint && npm run typecheck && npm test && npm run web:build` exits 0.
- [ ] `git diff` on `src/qbo/write.ts`, `src/gatekeeper/forwarder.ts`, `src/pipeline/**`, `migrations/**` is empty for this ENTIRE feature (all 5 chunks combined).
- [ ] All tests pass with zero failures.

## Endpoints / Interfaces

No new HTTP endpoints in this chunk — consumes CHUNK_4's start routes and the pre-existing `GET /api/onboarding`, `POST /api/onboarding/step`, `POST /api/onboarding/dry-run`.

## Database Changes

No schema changes in this chunk (or anywhere in this feature).

## Test Scenarios

- **Happy path**: both connections true from a fresh load → automatic walk-through → summary screen with real dry-run counts, zero additional required clicks.
- **Edge case**: returning owner with exactly one connection already true from a prior session → only the remaining connection's `ConnectPrompt` requires action; the already-true one shows "Connected ✓" with no re-click needed.
- **Failure case**: a `connect_error` query param renders a friendly, retryable error on the correct `ConnectPrompt`, never a raw error code.
- **Integration**: this is the integration point for CHUNK_1-4 with the existing CHUNK_6_ONBOARDING backend and the earlier LEAN "guided installer" feature (welcome overlay, stepper, blocker cards, friendly-error pattern) — after this chunk, the full spec's acceptance criteria (SPEC-onboarding-real-connect-redesign.md §3) all hold simultaneously. Note: the stepper from the earlier LEAN feature will need its step list adjusted to reflect the new, shorter set of user-facing screens — do not leave it displaying 9 steps when only 2 real actions + 1 summary screen remain user-facing (use your judgment on the cleanest way to reconcile this: either the stepper shows the 2 real actions + "Setting up" + "Done", or it's removed in favor of the simpler two-block connect screen — favor removing/simplifying over keeping a stepper that no longer matches reality).

## Dependencies

- **Requires**: CHUNK_1_STATETOKEN, CHUNK_2_REDIRECT, CHUNK_3_CONFIG, CHUNK_4_STARTROUTES (all of them — this chunk wires the whole feature together).
- **Blocks**: None (final chunk).

## Completion Promise

<promise>CHUNK COMPLETE: CHUNK_5_PAGEREDESIGN</promise>
