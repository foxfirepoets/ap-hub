# HKO-Truth-Audit Certificate: AP-hub North Star UX (CHUNK_1–5 + CHUNK_8 scaffold)
**Date:** 2026-07-15 | **Branch:** northstar-ux-v1 | **Base:** 9858eaa

| Layer | Findings | Critical/High |
|-------|----------|--------------|
| HK (Code — delegated independent review) | 4 | 1 CRIT / 0 HIGH |
| OTA (Claim honesty — empirical) | 1 | 0 / 0 (minor overstatement) |
| RIO (Integration — empirical) | 1 | 0 / 0 (known gap) |
| MULTI (overlap) | 0 | — |
| CAUSAL LINKs | 0 | — |
| HK Coverage | COMPLETE (independent subagent, fresh context) | — |

**Method note:** HK layer run as an independent security subagent (fresh context) rather than nesting the hudson-kraken-audit SKILL.md inline late in a long session; OTA/RIO run as direct empirical checks against the repo, tests, and git history (not against the orchestrator's own reports).

## Findings (initial verdict: FAIL — 1 CRITICAL)

1. **CRITICAL — Cross-tenant self-provisioning via SSO** (`src/auth/google-sso.ts:80` `upsertUser` INSERT `status='active'`; tenant from attacker-controlled login `state`). Any Google account could mint an active `cpa` session in ANY tenant and read its financial data. The migration's `status DEFAULT 'invited'` invite-gate was dead. **STATUS: FIXED** — login is now UPDATE-only (`activateUserForLogin`); a non-invited email is refused (no row, no session). New regression test `REFUSES a stranger with no invite`. First-owner provisioning must be out-of-band (seed/CLI/onboarding invite).
2. **MEDIUM — Missing OAuth CSRF state nonce** (`app/api/auth/login|callback`). `state` carried only the tenant, no session-bound nonce. **STATUS: FIXED** — random nonce set as an HttpOnly `sso_state` cookie at login, verified with `timingSafeEqual` on callback; non-numeric tenant rejected; state cookie cleared after use.
3. **LOW — Unscoped attachment read** (`src/services/approve.ts` `loadPdf` `WHERE id=$1`). Parameterized + tenant-owned id, so not exploitable, but a defense-in-depth gap. **STATUS: FIXED** — now `WHERE tenant_id=$1 AND id=$2`.
4. **LOW — Non-numeric route id → 500 instead of 400** (`app/api/**/[id]`). **STATUS: FIXED** — `assertEntityId`/`isValidId` guard (accepts numeric-string bigint ids); actions → 400 VALIDATION, reads → 404. (A too-strict first version regressed 16 tests by rejecting pg's string bigint ids; caught by the gate and fixed same-pass.)

**OTA minor:** claimed "web:build 20 routes"; actual is 25 route lines — an undercount, not a fabrication. No material dishonesty found: "128/128 green", "guarantees intact", "forbidden files untouched", "CHUNK_8 merged / only 2 files changed" all verified TRUE against the repo.

**RIO known gap (already flagged to user):** `IMPLEMENTATION_PLAN.md` does not list CHUNK_8; the loop would skip it until added. Not a defect in shipped code — a build-sequencing to-do.

## Overall result: PASS (post-remediation)
Initial audit was **FAIL** (1 CRITICAL). All 4 findings remediated and re-validated in-session: gate **129/129** green (was 128; +1 new auth test), lint + typecheck clean, `web:build` compiled, six-guarantee suite green, `src/qbo/write.ts` / `src/gatekeeper/forwarder.ts` / pipeline UNCHANGED vs base `9858eaa`.

**Verified safe (independent review, cited):** SQL injection — none (all params bound); tenant scoping — enforced on every read/mutation; role gate — server-side + service-level `ensurePermission`; single QBO-write path (`approveProposal→postOnce→write.ts`) and single send path (`sendReply→forwarder`, no recipient param, 11-field recipient blocklist); session — only `sha256(token)` stored, cookie HttpOnly/Secure/SameSite, `timingSafeEqual` compare; XSS — no `dangerouslySetInnerHTML`; no hardcoded secrets; no connection leaks.

**Residual risks (undetectable without live execution / real transcript):**
1. Real Google SSO end-to-end (token exchange, cookie behavior across a real browser redirect) is not exercised by the DB-backed tests — verify against a live Google client before production.
2. The offline first-owner provisioning path (seed/CLI) does not exist yet — until onboarding (CHUNK_6) ships an invite flow, a tenant's first user must be inserted manually; document this so no one re-adds auto-provisioning "to make login work".
3. `app/` route handlers are covered by typecheck (`web:build`) + Playwright happy-path only, not unit tests — the CSRF nonce flow itself has no automated regression test (verified by reasoning + build).
