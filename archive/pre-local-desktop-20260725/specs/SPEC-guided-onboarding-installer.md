# SPEC: Guided Onboarding Installer (graphical wrapper for CHUNK_6_ONBOARDING)

## Metadata
- Version: 1.0 | Date: 2026-07-15 | Tier: LEAN | Greenfield/Brownfield: Brownfield (wraps existing CHUNK_6_ONBOARDING)
- Status: Ready for Build
- Success measure: A first-time owner completes setup (welcome → connect → configure → dry-run → review → automation choice) without needing outside help, and any failure they hit shows a plain-English explanation + a concrete next action instead of a raw error code.
- Architecture grounding: `architecture-decision-packet-ap-hub-northstar-ux-2026-07-14.md` (verdict READY_FOR_SPEC, covers the whole northstar-ux-v1 initiative including onboarding) — no re-derivation; this feature adds no new systems, so no new grounding decisions are needed.
- Open questions: 1

## Tech Stack
Next.js App Router (existing `app/(app)/onboarding/page.tsx`), React client components, existing `app/globals.css` design tokens (`--bg`, `--panel`, `--border`, `--radius`, `--accent`, `--accent-fg`, `--muted`, `--good/--warn/--bad` + `-bg` variants). No new runtime dependency, no new backend, no new database. TypeScript (ESM), Vitest for logic-level tests, `npm run web:build` for the `app/` compile gate (unchanged from the rest of this repo).

## Architecture Grounding Summary
**Systems touched:** `app/(app)/onboarding/page.tsx` (rewritten to a graphical step-through shell) + `app/globals.css` (new installer-specific styles, additive) + one new small presentational component file (error/help panel) + one new small presentational component file (stepper). **Systems explicitly NOT touched:** `src/services/onboarding.ts`, `app/api/onboarding/**`, `migrations/`, any auth/session code, `src/qbo/write.ts`, `src/gatekeeper/forwarder.ts`, `src/pipeline/**`. **Source of truth:** unchanged — `onboarding_state` (Postgres) remains the only source of truth for wizard progress; this feature adds a purely client-side, non-persisted "welcome" overlay (dismissed state lives in a `useState`, not the database) — there is no second source of truth for step position. **Must not break:** the existing 11 `test/onboarding.test.ts` service/action-layer tests (untouched, since no service/action code changes), and `npm run web:build`'s route count (25 routes; this feature adds no new route, only changes the existing `/onboarding` page's rendering).

---

## 1. Executive Summary

The existing onboarding wizard (CHUNK_6) is functionally complete — it connects Gmail/QBO, runs a safe dry-run, and locks posting until automation is explicitly turned on — but it drops a first-time user straight into "Connect Gmail" with no explanation of what's about to happen, shows raw error text when something fails, and has no visual sense of progress through the 9 steps. This spec adds a graphical installer layer on top of the *same* backend: a welcome screen explaining what AP Hub will do and what it needs before the user commits to anything, a visual progress stepper across all 9 steps, and a friendly help panel that translates every failure into plain English with a concrete next action — instead of a raw `res.error?.message`. Nothing in the data model, API, or auth changes. Estimated build: 1–2 days of agent work.

## 2. Scope & Do Not Build

**In scope:**
- A one-time (per page load, not persisted) **welcome screen** shown before the wizard body: what AP Hub is about to do, the two prerequisites it will ask for (Gmail access, a QuickBooks sandbox company), and a "Get Started" action that reveals the existing step flow.
- A **visual progress stepper** across all 9 existing steps (`connect_gmail` → `complete`), replacing the current plain "Step X of Y: Label" text line — shows completed / current / upcoming state.
- A **prerequisite explainer** on each step: one short sentence, shown above the existing step content, stating what this step needs and why (pure copy addition, reusing existing `state.connections` / `state.blockers` / `state.priorData` — no new data).
- A **friendly failure panel**: every error surfaced by the existing `notice.kind === 'bad'` path is mapped from its error code (`VALIDATION`, `FORBIDDEN`, `UNAUTHENTICATED`, `DRY_RUN_LOCKED`, network/fetch failure, or an unrecognized code) to a plain-English explanation + a suggested next action + a "Try again" button, instead of the raw message.
- Restyling the existing "Setup blockers" list into visually distinct cards (icon + group + message + fix), reusing the exact same `state.blockers` data — no new blocker types.
- New CSS only, additive to `app/globals.css` (no restructuring of existing classes other pages depend on).

### Do Not Build
- **No new backend endpoint, service function, or database column** — reason: the entire feature is presentational; the existing 3 endpoints (`GET /api/onboarding`, `POST /api/onboarding/step`, `POST /api/onboarding/dry-run`) already return everything this UI needs.
- **No "recovery key" or account-recovery step of any kind** — reason: explicitly out of scope per owner decision (2026-07-15); AP Hub has no local-password/wallet-key concept — auth is Google SSO only.
- **No new onboarding step added to `ONBOARDING_STEPS`** — reason: the welcome screen is a client-side-only overlay shown before the first real step, not a ninth backend-tracked step; adding a backend step would require a migration/service change, which is out of scope for a purely graphical feature.
- **No changes to `DRY_RUN_LOCKED` enforcement, `automation_level` semantics, or the dry-run's `propose`-only guarantee** — reason: those are guarantee-bearing backend behaviors (already audited, see `.claude/audits/HKO/`), untouched by a presentational layer.
- **No Playwright/E2E rewrite** — reason: the existing CHUNK_5 E2E happy path is out of scope here; this spec's testing strategy (§10) covers the new presentational logic at the component/unit level plus a `web:build` compile check.

## 3. Business Context & Acceptance Criteria

**Goal:** turn the functionally-complete onboarding wizard into one a non-technical first-time owner can complete without external help, and one that never leaves them staring at a raw error code.

**Success target:** every one of the acceptance criteria below observably holds; there is no numeric usage metric to instrument (no analytics system exists in this repo — see §16).

**Acceptance criteria (machine-verifiable):**
- [ ] On first render of `/onboarding`, a welcome overlay is shown before any step content is visible — FAIL if step content (e.g. the "Connect Gmail" button) is present in the DOM/queryable before "Get Started" is clicked.
- [ ] The welcome overlay names both prerequisites (Gmail, QuickBooks sandbox company) — FAIL if the text mentions neither.
- [ ] Clicking "Get Started" dismisses the overlay and reveals the existing step flow, starting at whatever `state.step` the backend reports — FAIL if it always resets to `connect_gmail` regardless of actual `state.step`.
- [ ] A progress stepper renders all 9 step labels with the current step visually distinguished from completed and upcoming ones — FAIL if fewer than 9 steps render or the current step isn't distinguishable in the rendered output (e.g. via a `data-current="true"`/class check).
- [ ] Each step shows a one-sentence prerequisite explainer above its existing content — FAIL if a step renders with no explainer text present.
- [ ] Triggering each of `VALIDATION`, `FORBIDDEN`, `DRY_RUN_LOCKED`, and an unrecognized/unknown error code produces a distinct plain-English message (not the raw code) plus a "Try again" action — FAIL if the raw code string is shown verbatim, or if all codes produce the same generic text.
- [ ] Setup blockers render as one card per blocker (icon + group + message + fix), grouped exactly as `state.blockers` groups them today — FAIL if any blocker present in `state.blockers` is missing from the rendered cards, or if blockers from different groups are merged into one card.
- [ ] `npm run web:build` compiles with the same 25 routes as before this change — FAIL if the route count changes or the build errors.
- [ ] The pre-existing `test/onboarding.test.ts` (11 tests, service/action layer) stays green, unmodified — FAIL if any of those tests needed a change to pass (that would mean a backend contract broke).

## 4. Architecture & System Integration
N/A — no new integration points. Data flow is unchanged from CHUNK_6: browser → `GET/POST /api/onboarding*` (existing routes) → `src/services/onboarding.ts` (existing, untouched) → `onboarding_state` (existing table, untouched). This feature only changes what the browser renders from the same responses.

## 5. User Flows & Happy Path

**Flow A — First-time owner, happy path.** Actor: `owner_controller` (human). Precondition: session valid, no completed onboarding. Steps: 1) Land on `/onboarding` → welcome overlay appears, names both prerequisites. 2) Click "Get Started" → overlay dismisses, stepper shows step 1 of 9 (Connect Gmail) highlighted, with a one-line explainer of why Gmail access is needed. 3) Proceed through connect_qbo → select_company → configure_mode → automation_level exactly as today (existing buttons/behavior unchanged), stepper advancing visually at each step. 4) At `dry_run`, run the scan; the existing summary counts render as today. 5) `review_sample` → `approve_rules` → `complete`: choose an automation level away from `off`. Postcondition: stepper shows all 9 steps complete; `state.automationLevel !== 'off'`.

**Flow B — Returning owner, mid-setup.** Actor: `owner_controller`. Precondition: `onboarding_state.step` already past `connect_gmail` from a prior session. Steps: land on `/onboarding` → welcome overlay still appears once (it is not persisted) → "Get Started" reveals the step flow starting at the backend-reported step (NOT step 1) → stepper shows earlier steps as completed. Postcondition: no progress lost, no re-prompt for already-connected services.

**Flow C — A step fails.** Actor: `owner_controller`. Precondition: any step action returns a non-2xx response (e.g. `VALIDATION` on an unexpected step transition, a network failure during dry-run). Steps: the friendly failure panel replaces the raw notice — plain-English explanation of what happened, a suggested next action in the same sentence, and a "Try again" button that re-issues the same action. Postcondition: the owner is never shown a bare error code or a stack trace.

**Flow D — Non-owner visits `/onboarding`.** Actor: `bookkeeper`/`cpa`. Unchanged from today: "Only the account owner can complete setup." (existing gate, `me.role === 'owner_controller'`) — the welcome overlay does not apply to this path (no reason to show setup prerequisites to a role that can't act on them).

## 6. Data Models & Schema
N/A — no schema changes. The welcome-dismissed flag is ephemeral React state (`useState<boolean>`, reset on every page load/reload) — deliberately not persisted, so returning users always see a brief welcome (by design, since it's cheap reassurance, not a nag) but never lose real wizard progress (which stays exactly where `onboarding_state.step` says).

## 7. Error Handling & Edge Cases

| Scenario | Status | Code | Response / Recovery |
|---|---|---|---|
| Unexpected step transition | 400 | `VALIDATION` | "That step isn't available yet — finishing the current step first." No raw code shown; "Try again" re-fetches current state. |
| Non-owner attempts an onboarding action | 403 | `FORBIDDEN` | "Only the account owner can change setup." No retry button (retrying won't help); links back to `/today`. |
| Session expired mid-wizard | 401 | `UNAUTHENTICATED` | "Your session expired — sign in again to continue where you left off." Link to `/login`; progress is safe (server-side, unaffected). |
| Post attempted while automation is off | 403 | `DRY_RUN_LOCKED` | "Posting is still locked — finish setup and choose an automation level to enable it." (Surfaced defensively; this page never itself triggers a post, but the copy exists in case a stale action fires.) |
| Dry-run scan throws / network failure | (fetch rejects) | — | "The scan didn't complete — this is usually temporary." "Try again" re-runs the dry-run; no partial state is left (dry-run is fail-safe by design, §CHUNK_6). |
| Unrecognized/unknown error code | any non-2xx | (other) | Generic fallback: "Something went wrong on that step." + the raw message shown in a collapsed "Details" disclosure (never hidden entirely — honesty over polish) + "Try again". |
| `state.blockers` is empty | — | — | Blockers panel does not render at all (unchanged from today). |
| JS disabled / `web:build`-time render | — | — | Out of scope — the existing app already requires client JS (session guard, all pages are `'use client'`); no change in this feature's posture. |

**Edge cases:** a blocker whose `code` isn't recognized by the friendly-copy map falls back to rendering its raw `message`/`fix` fields exactly as today (never silently dropped). The welcome overlay must not block the non-owner gate — role check happens first, before the overlay would ever render.

## 8. Performance & Scalability
N/A — a single-tenant, single-user wizard page; no new query, no new payload size of consequence (all data already fetched by the existing `GET /api/onboarding` call this page already makes).

## 9. Security & Compliance
N/A — no new auth surface, no new data access, no new write path. The welcome overlay and error copy render only from data the page already receives post-authentication; no additional field is fetched or displayed that wasn't already returned by the existing endpoints.

## 10. Testing Strategy

- **Unit (Vitest):** a pure function `friendlyOnboardingError(code: string, fallbackMessage: string): { text: string; retryable: boolean }` extracted from the page so it's testable without rendering — covers `VALIDATION`, `FORBIDDEN`, `UNAUTHENTICATED`, `DRY_RUN_LOCKED`, and an unrecognized code, asserting each produces distinct, non-raw-code text and the correct `retryable` flag (FORBIDDEN/UNAUTHENTICATED → not retryable via "Try again"; others → retryable).
- **Compile/regression:** `npm run web:build` must still compile with 25 routes (§3 acceptance criterion) — this is the same gate every prior chunk in this build used for `app/` code, since `app/` sits outside the `lint`/`typecheck`/`test` gate.
- **Regression (must not break):** the pre-existing `test/onboarding.test.ts` (11 tests, service/action layer) must pass unmodified — proves this feature touched no backend contract.
- **Manual/visual verification (documented, not automated):** run `npm run web:dev`, visit `/onboarding` as an `owner_controller`, confirm the welcome overlay appears once, the stepper reflects 9 steps, and triggering a `VALIDATION` response (e.g. by racing two step-advance clicks) shows the friendly panel not a raw code. This is the honest limit of this repo's current test tooling for a purely visual change (no Playwright coverage for this page — disclosed in §14).

## 11. Deployment & Rollout
N/A — no service to deploy; ships as part of the existing `northstar-ux-v1` branch/PR, verified via `npm run web:build` locally exactly like every other chunk in this build. Rollback = revert the commit (no migration, nothing stateful to undo).

## 12. API Documentation
N/A — no new endpoint. Reuses, unchanged:
```
GET  /api/onboarding              → OnboardingState (existing)
POST /api/onboarding/step         → { step, automationLevel? } (existing)
POST /api/onboarding/dry-run      → DryRunSummary (existing)
```

## 13. Database Migrations
N/A — no schema change. `git diff` on `migrations/` must be empty after this feature ships; that emptiness is itself a verification point (mirrors the pattern used for `src/qbo/write.ts`/`src/gatekeeper/forwarder.ts` elsewhere in this build).

## 14. Known Limitations, Open Questions & Future Work

**Limitations:** the welcome overlay is not persisted, so it reappears every page load/reload (by design, per §6) — a returning owner mid-wizard will briefly see it again before continuing exactly where they left off. This page has no Playwright E2E coverage (CHUNK_5's happy-path E2E doesn't touch `/onboarding`); verification of the visual/interactive behavior is manual (§10) plus the extracted pure-function unit tests.

**Open Questions (1):**
1. **"Pop-up" interpretation** — the owner's request said "guided pop-up pages." This spec interprets that as a welcome/prerequisites screen and a failure-help panel presented with pop-up/overlay treatment (a dismissible layer over the page), while the step-by-step body itself stays as an enhanced inline flow (not a full modal-per-step wizard), to avoid a much larger rewrite for a LEAN-tier feature. Resolution action: if the owner meant a literal modal-per-step wizard (each of the 9 steps in its own dialog), say so before/during build and this spec's §2 scope will need a revision. Not money/auth/customer-data-blocking — has a safe, disclosed default.

**Future work:** persisting "welcome seen" per-user (would need a new column — out of scope here); a Playwright spec covering the full graphical wizard; extending the same friendly-error pattern to other wizard-like flows in the app (e.g. the reviewer dashboard CLI output).

## Risks
- **Scope creep into backend/auth territory** — a builder "helpfully" adding a persisted welcome-seen flag or a new onboarding step would require a migration/service change, breaking this spec's core promise (presentational-only, zero guardrail risk). Mitigation: §2 Do Not Build is explicit; the Definition of Done requires an empty `git diff` on every backend path.
- **Breaking the non-owner gate** — the welcome overlay must render strictly after the `owner_controller` role check, never before it; getting the render order wrong would show setup prerequisites to a bookkeeper/CPA who can't act on them. Mitigation: Flow D (§5) states this explicitly; manual verification (§10) includes a non-owner check.
- **Regressing `test/onboarding.test.ts`** — since that suite exercises the action/service layer this feature must not touch, any red test there is a signal scope crept past presentational. Mitigation: it's a named Definition-of-Done gate (§18), run unmodified.
- **Misreading "pop-up" and over-building a full modal wizard** — see Open Question #1; the disclosed default avoids this, but a builder should re-read that question rather than silently picking the bigger interpretation.

## 15. Glossary
- **Installer / wizard:** this repo's existing term is "onboarding" (`CHUNK_6_ONBOARDING`); "installer" in this spec refers to the same flow, graphically enhanced — not a separate concept.
- **Welcome overlay:** the new, non-persisted first screen shown before wizard step content.

## 16. Monitoring & Metrics
N/A — no analytics/monitoring system exists in this repo for UI interactions; success is verified via the acceptance criteria in §3, not a live metric.

## 17. Alternative Designs Considered
1. **A literal modal-per-step wizard** (each of the 9 steps as its own `<dialog>`) — considered but not chosen for this LEAN spec; a much larger visual rewrite than the owner's request needs, and it would risk regressing the existing inline flow's tested structure (`data-testid` hooks used implicitly by the manual verification steps). Flagged as Open Question #1 if this is actually what's wanted.
2. **A dedicated onboarding-only design system** (new component library) — rejected: this repo already has a small, consistent token/class set (`app/globals.css`); reusing it keeps the installer visually consistent with the rest of the app rather than looking like a bolted-on product.

## 18. Build Phases & Final Checklist

### Build Phases
1. **Extract `friendlyOnboardingError`** — a pure function (new small module or top of the page file) mapping error codes to plain-English text + retryable flag; unit-tested in isolation. Verifiable: Vitest passes for all 5 code cases (§10).
2. **Welcome overlay** — a new presentational component, shown via local `useState` before step content renders; names both prerequisites; "Get Started" reveals the existing step body at whatever `state.step` is. Verifiable: manual check (§10) + the non-owner gate still fires before the overlay would.
3. **Progress stepper** — a new presentational component rendering all 9 `STEP_LABEL` entries with completed/current/upcoming visual states, replacing the "Step X of Y" text line. Verifiable: renders 9 items; current step has a distinguishing attribute/class.
4. **Prerequisite explainers + blocker cards** — one-sentence explainer per step (copy-only addition above existing step content); restyle the existing blockers list into cards (icon + group + message + fix) from the same `state.blockers` data. Verifiable: every step has explainer text; every blocker in `state.blockers` has a matching card.
5. **Wire the friendly failure panel into every existing failure path** (`goStep`, `runDryRun`, `approveRule`) — replace the raw `notice` bad-path text with `friendlyOnboardingError`'s output + "Try again" (except for non-retryable codes, per §7). Verifiable: each of §3's four error-code acceptance criteria.
6. **Gate + regression check** — `npm run web:build` (25 routes, compiles clean); `npx vitest run test/onboarding.test.ts` unmodified and green; new Vitest file for `friendlyOnboardingError` green.

### Build Checklist
- [ ] Welcome overlay names both prerequisites, dismissible, non-persisted
- [ ] Stepper renders all 9 steps with distinguishable current/completed/upcoming state
- [ ] Every step has a one-sentence prerequisite explainer
- [ ] Every error code in §7's table produces distinct, plain-English, non-raw-code text
- [ ] Blockers render as one card per blocker, grouped as today
- [ ] No backend file touched (`git diff` on `src/services/onboarding.ts`, `app/api/onboarding/**`, `migrations/**` empty)
- [ ] `npm run web:build` green, 25 routes; `test/onboarding.test.ts` green unmodified

```markdown
DONE means ALL true, with an artifact per item (rendered output, test output, git diff):
1. Each §3 acceptance criterion, observed via the manual verification steps in §10 or the
   extracted unit tests.
NOT done if:
- Verified only by reading the component code ("looks right") — must be run via web:dev or the
  unit tests
- Any backend file shows a diff (would mean scope crept past "presentational only")
- test/onboarding.test.ts needed a change to keep passing
```

```markdown
The building agent must:
- [ ] Read this spec + the Architecture Grounding Summary before writing code
- [ ] Produce a plan/file-tree first — not code
- [ ] Test every "must not break" item before marking any phase complete
- [ ] Treat the Definition of Done above as the ONLY completion signal
- [ ] Stop and escalate if backend/auth/data scope creep is at risk — never build around it
- [ ] Attach a concrete artifact per done condition (test output, web:build output, git diff)
- [ ] Never mark done on "the code looks right" — run web:build and the tests
```
