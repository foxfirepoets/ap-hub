# HKO-Truth-Audit Certificate: Guided Onboarding Installer
**Date:** 2026-07-15 | **Branch:** northstar-ux-v1 | **Range:** `174eb4c..4642b9b`

| Layer | Findings | Critical/High |
|-------|----------|--------------|
| HK (Code — independent fresh-context subagent) | 1 (LOW) | 0 CRIT / 0 HIGH |
| OTA (Claim honesty — empirical, against real command output) | 0 | 0 / 0 |
| RIO (Integration — empirical) | 0 | 0 / 0 |
| MULTI (overlap) | 0 | — |
| CAUSAL LINKs | 0 | — |
| HK Coverage | COMPLETE (independent subagent, fresh context, real diff review) | — |

**Method note:** see `HKO-truth-audit-report-guided-installer.md` for full method. HK run as an independent `security-engineer` subagent with no stake in the build; OTA/RIO run as direct empirical checks (gate re-runs, protected-file diffs, source reads) against the repo.

## Findings

1. **LOW — `OnboardingStepper` unmatched-step fallback** (`app/components/OnboardingStepper.tsx:17-22` pre-fix). If `currentStep` matched no entry in `steps`, every item silently rendered `upcoming` rather than a distinguishable state. Not currently reachable — the backend (`src/services/onboarding.ts`) validates `step` against the same closed 9-value set before it ever reaches the client — but a silently-misleading fallback rather than an honest one. **STATUS: FIXED** (commit `4642b9b`) — an unmatched step now renders `data-status="unknown"` explicitly.

**No CRITICAL, HIGH, or MEDIUM findings.**

## Overall result: PASS
This feature was scoped presentational-only from its spec onward, and the independent adversarial review confirms that held across all 5 chunks: zero touches to any of the six guarantee-bearing subsystems (`src/qbo/write.ts`, `src/gatekeeper/forwarder.ts`, `src/pipeline/**`, `src/services/onboarding.ts`, `app/api/onboarding/**`, `migrations/**` all byte-for-byte unchanged vs `174eb4c`), the owner-only gate renders before all new UI, no XSS-unsafe rendering anywhere, the error mapper is a genuine pure function whose "Details" disclosure cannot leak sensitive backend detail (traced end-to-end through the real error-shaping code, not assumed), and the retry mechanism only ever re-invokes one of the three pre-existing, already server-guarded actions. Gate **189/189** green throughout; `test/onboarding.test.ts` (11 tests, backend/action layer) re-verified unmodified and green after every chunk; `web:build` 25 routes (unchanged).

**Verified safe (independent fresh-context review, cited with file:line):** non-owner render order (`app/(app)/onboarding/page.tsx:160-176`); no `dangerouslySetInnerHTML`/`eval` in any new/modified `.tsx`; `friendlyOnboardingError` (`app/lib/onboardingErrors.ts:10-38`) is a pure switch with zero side-effect imports; error-message provenance traced through `apiPost` → `runAction`'s hardcoded generic 500 (`src/services/action/index.ts:94`) and `ServiceError`'s templated-only text (`src/services/onboarding.ts:183`) — no raw exception/stack trace can reach the user-visible "Details" panel; retry callbacks (`app/(app)/onboarding/page.tsx:98,128,148`) can only re-invoke the three pre-existing guarded actions; welcome-dismissed state is a plain `useState`, never persisted (`app/(app)/onboarding/page.tsx:69`); `app/globals.css` diff is additive-only, no existing selector touched; blocker-card icon lookup (`app/components/OnboardingBlockerCard.tsx:12-21`) is a fixed read-only object literal.

**Residual risks (undetectable without live execution / real transcript):**
1. No component-level (React Testing Library / Playwright) automated test exists for the welcome overlay, stepper, blocker cards, or retry flow — verification for this feature relied on the pure-function unit tests (CHUNK_1), the `web:build` compile gate, and independent code review of the JSX render order, not a rendered-DOM assertion. Disclosed as an explicit limitation in `specs/SPEC-guided-onboarding-installer.md` §14.
2. This feature was never manually exercised in a running browser (`npm run web:dev`) during this build — all verification was gate-based (lint/typecheck/test/build) plus static code review, per the spec's honest testing-strategy limits (§10).
3. Open Question #1 from the spec (whether "guided pop-up pages" meant a literal modal-per-step wizard rather than the overlay+enhanced-inline-flow interpretation actually built) remains unresolved by the owner — flagged again here in case it changes the desired UX before shipping.
