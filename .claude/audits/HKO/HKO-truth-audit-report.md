# HKO-Truth-Audit Report: AP-hub North Star UX
**Date:** 2026-07-15 | **Threshold:** HIGH | **Scope:** CHUNK_1–5 (built) + CHUNK_8 (scaffold) on branch northstar-ux-v1 | **Base:** 9858eaa

Initial verdict **FAIL** (1 CRITICAL) → all findings remediated + re-validated → **PASS**. Full findings, verified-safe list, and residual risks are in `HKO-certificate.md`. This report is the remediation ledger.

## Findings & Remediation (all applied this session)

| # | Sev | Finding | Fix (file) | Outcome |
|---|-----|---------|-----------|---------|
| 1 | CRITICAL | SSO self-provisions an `active` user into any attacker-chosen tenant → cross-tenant financial-data read | `src/auth/google-sso.ts`: `upsertUser` (INSERT active) → `activateUserForLogin` (UPDATE-only, refuses non-invited) | FIXED — new test `REFUSES a stranger with no invite`; gate green |
| 2 | MEDIUM | OAuth `state` had no CSRF nonce | `app/api/auth/login/route.ts` + `callback/route.ts`: random nonce in HttpOnly `sso_state` cookie, `timingSafeEqual` verify, numeric-tenant check, cookie cleared | FIXED — web:build compiles |
| 3 | LOW | Unscoped attachment read (`WHERE id=$1`) | `src/services/approve.ts` `loadPdf` → `WHERE tenant_id=$1 AND id=$2` | FIXED |
| 4 | LOW | Non-numeric route id → 500 not 400 | `src/services/index.ts` `isValidId`/`assertEntityId`; guards in approve/reject/retry/reply (→400) + getById/evidence (→404) | FIXED (regressed 16 tests on first attempt — too-strict guard rejected pg string bigint ids — corrected to coerce numeric strings) |

## Verification Summary

| Command | Result | Scope |
|---|---|---|
| `npm run lint && npm run typecheck && npm test` | passed — **129/129** (was 128; +1 auth test) | in-scope |
| `npm run web:build` | passed — compiled, 25 routes | in-scope |
| `git diff 9858eaa -- src/qbo/write.ts src/gatekeeper/forwarder.ts src/pipeline/` | empty (UNCHANGED) | guarantee check |
| six-guarantee tests (lockdown/gatekeeper/posting/mapping/anchor) | green, files unmodified vs base | regression |

## Crux
The green gate did not catch the CRITICAL because it was a design flaw (auto-provision), not a failing test — the auth tests asserted the vulnerable behavior. The independent fresh-context review caught it; the fix converted login to invite-gated (UPDATE-only) and added the missing negative test. Lesson folded into residual risk #2 (first-owner provisioning must be built by onboarding, never re-opened as auto-provision).

## Handoff
PASS (post-remediation) — eligible input to `truth-before-launch` when shipping; NOT launch approval by itself. Residual risks (see certificate) require live Google SSO verification + an out-of-band first-owner invite path (CHUNK_6).
