# HKO-Truth-Audit Report: AP-hub North Star UX — CHUNK_6/7/8 + gap fixes
**Date:** 2026-07-15 | **Threshold:** HIGH | **Scope:** CHUNK_6/7/8 + first-owner provisioning + plan fix, on branch northstar-ux-v1 | **Base range:** `9de30fc..66d999f` (this session's work; prior audit covered CHUNK_1-5 + CHUNK_8 scaffold up to `9de30fc`)

Initial verdict **FAIL** (1 HIGH) → both findings remediated + re-validated → **PASS**. Full findings, verified-safe list, and residual risks are in `HKO-certificate.md`. This report is the remediation ledger.

**Method note (same as the prior audit):** HK layer run as an independent, fresh-context `security-engineer` subagent (no stake in having built this code) reviewing the real diff `9de30fc..HEAD`, rather than nesting the `hudson-kraken-audit` SKILL.md late in an already-long orchestrating session. OTA and RIO are direct empirical checks against the repo, git history, and command output — not against any subagent's self-report. Every subagent-reported "done" in this session was independently re-verified by the orchestrator (re-running the full gate, diffing protected files, and reading the actual new service files) before being committed or accepted.

## Findings & Remediation (all applied this session)

| # | Sev | Finding | Fix (file) | Outcome |
|---|-----|---------|-----------|---------|
| 1 | HIGH | Automatic `propose→post_sandbox` pipeline path bypassed CHUNK_6's `DRY_RUN_LOCKED` guard — only the manual `approveProposal`/`retryProposal` service calls checked it; a tenant mid-onboarding could still be auto-posted by the existing high-confidence pipeline | `src/pipeline/register.ts`: extracted `guardedPostSandboxHandler` — checks `isDryRunLocked` before invoking the real `postSandboxHandler`; locked → raises a `dry_run_locked` exception, posts nothing. `src/exceptions.ts`: added the `dry_run_locked` reason code. Neither `src/pipeline/mapping.ts` nor `src/pipeline/posting.ts` was touched. | FIXED — 3 new tests (`test/dry-run-lock-pipeline.test.ts`): locked→0 postings+exception row; `automation_level` set away from off→posts normally; no `onboarding_state` row (pre-CHUNK_6 / freshly bootstrapped tenants)→posts normally (backward compat preserved) |
| 2 | MEDIUM | `scripts/build-review-dashboard.mjs`'s CSV export (`csvEscape`) only escaped quote/comma/newline, not leading formula-trigger characters (`=`,`+`,`-`,`@`) — vendor/finding/source strings originate from AP email content (attacker-influenced), so a crafted vendor name could execute as a formula in Excel/Sheets on open (CWE-1236) | `csvEscape`: prefix a field starting with `=`,`+`,`@`,tab,CR, or `-` with a neutralizing `'`. **Self-caught regression**: the first attempt placed `-` mid-character-class (`[=+\-@...]`), which — after the file's existing double-backslash template convention resolved — became the unescaped range `[+-@]` (charcodes 43–64), silently sweeping in every digit and corrupting numeric CSV columns. Caught by manually executing the generated regex in Node (`node -e`), not by grepping for its presence; fixed by moving `-` to the end of the character class where it is always literal. | FIXED — verified with a direct Node execution of the regex (`=cmd`/`+1`/`-5`/`@vendor`→true; `12345`/`Acme Co`→false) + a new source-pattern regression test |

## Verification Summary

| Command | Result | Scope |
|---|---|---|
| `npm run lint && npm run typecheck && npm test` | passed — **183/183** (was 179 pre-fix; +3 dry-run-lock, +1 CSV-guard) | in-scope |
| `npm run web:build` | passed — compiled, 25 routes (unchanged — this fix touches no `app/` code) | in-scope |
| `git diff 9de30fc..HEAD -- src/qbo/write.ts src/gatekeeper/forwarder.ts src/pipeline/mapping.ts src/pipeline/posting.ts` | empty (byte-for-byte unchanged) | guarantee check |
| `git diff 9de30fc..HEAD -- src/pipeline/register.ts` | small, additive: one new exported function wrapping the existing job registration; no existing job logic altered | guardrail-bearing but in-scope |
| direct `node -e` execution of the fixed `csvEscape` regex against `=cmd`, `+1`, `-5`, `@vendor`, `12345`, `Acme Co` | matches exactly the intended set (formula-trigger chars → true; ordinary numbers/text → false) | in-scope, manual proof beyond static grep |

## Crux
The build's own gate (183/183 across every chunk) never caught the HIGH finding because it is a cross-cutting integration gap, not a failing unit test: CHUNK_6's tests only exercised the *manual* approve/retry paths it directly touched, and the pre-existing automatic pipeline had no test asserting it respects a feature that didn't exist when it was written. This is the same failure shape the prior HKO audit found in CHUNK_1 (a design gap invisible to a green gate) — reinforcing that a new feature gating an *existing* automatic path needs an explicit test on that existing path, not just on the new manual one. Folded into a new standing guardrail (see certificate residual risks).

## Handoff
PASS (post-remediation) — eligible input to `truth-before-launch` when shipping; NOT launch approval by itself. Next step per operator instruction: open a PR (`gh pr create`) — do not merge without the owner.
