# HKO-Truth-Audit Report: Guided Onboarding Installer
**Date:** 2026-07-15 | **Threshold:** HIGH | **Scope:** guided-onboarding-installer feature (5 chunks), on branch northstar-ux-v1 | **Base range:** `174eb4c..4642b9b`

Verdict: **PASS** (0 CRITICAL/HIGH/MEDIUM findings; 1 LOW, fixed opportunistically). This report is the audit ledger for this feature, separate from `.claude/audits/HKO/HKO-truth-audit-report.md` (the earlier CHUNK_6-8 audit) to keep the two build efforts' audit trails distinct.

**Method note (same as prior audits):** HK layer run as an independent, fresh-context `security-engineer` subagent reviewing the real diff `174eb4c..HEAD` (before the LOW-finding fix landed), with no stake in having built this code. OTA and RIO are direct empirical checks against the repo and command output.

## Findings

| # | Sev | Finding | Fix (file) | Outcome |
|---|-----|---------|-----------|---------|
| 1 | LOW | `OnboardingStepper` rendered every item as `upcoming` (not a distinguishable state) if `currentStep` matched no entry in `steps` (`findIndex` returns `-1`) — not currently reachable, since the backend (`src/services/onboarding.ts`) validates `step` against the same closed set before it ever reaches the client, but a silent-misleading fallback rather than an explicit one | `app/components/OnboardingStepper.tsx` — an unmatched step now renders `data-status="unknown"` explicitly instead of falling through to `upcoming` | FIXED (commit `4642b9b`) — one-line, defensive, opportunistic |

**No CRITICAL, HIGH, or MEDIUM findings.** The independent reviewer specifically checked (and found clean): scope creep into any of the six guarantee-bearing subsystems (confirmed empty diff on `src/qbo/write.ts`, `src/gatekeeper/forwarder.ts`, `src/pipeline/`, `src/services/onboarding.ts`, `app/api/onboarding/`, `migrations/`); the non-owner render-order gate (executes and returns before the welcome overlay and all new UI); XSS/unsafe rendering (no `dangerouslySetInnerHTML`/`eval` anywhere, all dynamic content via plain JSX text interpolation); whether `friendlyOnboardingError` is genuinely a pure function (confirmed — no fetch/DOM/DB/global-state); whether the "Details" disclosure could leak sensitive backend detail (traced end-to-end through `apiPost` → `runAction`'s hardcoded generic 500 message → `ServiceError`'s templated-only text — no path from a raw exception/stack trace to the user-visible panel); the retry mechanism's scope (can only ever re-invoke one of the three pre-existing, already server-guarded actions with their original arguments); the welcome-dismissed state's ephemerality (`useState`, no persistence anywhere); and CSS additivity (`app/globals.css` diff is purely new, uniquely-named selectors).

## Verification Summary

| Command | Result | Scope |
|---|---|---|
| `npm run lint && npm run typecheck && npm test && npm run web:build` | passed — **189/189** throughout every chunk and after the LOW-finding fix | in-scope |
| `npx vitest run test/onboarding.test.ts` | passed — **11/11**, unmodified across all 5 chunks (re-verified after each) | backend regression proof |
| `git diff 174eb4c..HEAD -- src/qbo/write.ts src/gatekeeper/forwarder.ts src/pipeline/ src/services/onboarding.ts app/api/onboarding/ migrations/` | empty | guarantee check |
| `npm run web:build` route count | 25 (unchanged from before this feature) | in-scope |

## Crux
This feature was scoped and built to be presentational-only from the start (see `specs/SPEC-guided-onboarding-installer.md`'s explicit "Do Not Build" list and guardrails), and the independent audit confirms that discipline held across all 5 chunks — the only finding was a cosmetic edge case in client-side rendering logic, not a guarantee violation. This is a useful contrast with the earlier CHUNK_6-8 audit (which found a real HIGH-severity integration gap): a narrowly-scoped, backend-untouched feature is materially easier to audit clean than one that adds new automatic pipeline behavior.

## Handoff
PASS — eligible input to `truth-before-launch` when shipping; NOT launch approval by itself. Next step per operator instruction: push to GitHub (updating the existing open PR #1) — do not merge without the owner.
