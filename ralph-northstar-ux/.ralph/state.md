# Ralph State

**Current Iteration:** 9

Current chunk: none — BUILD COMPLETE
Current task: none
Last completed: CHUNK_8_REVIEWDASH — all 4 tasks; gate GREEN (179/179) + web:build GREEN (25 routes,
unchanged — no UI in this chunk). No new migration (none required).
Status: BUILD COMPLETE — all 8 chunks done (CHUNK_1 087c97a, CHUNK_2 46a5a8c, CHUNK_3 32c252e,
CHUNK_4 247556f, CHUNK_5 366841f, CHUNK_6 42a4672, CHUNK_7 5a6aca8, CHUNK_8 pending commit this
session — see progress.md Iteration 9). Both HKO-audit gaps closed (plan fix b4fc3a4, first-owner
provisioning 20e788a). Next: spec-vs-build-brutal-audit / HKO-truth-audit, then open a PR — do not
merge without the owner (per operator instructions).
NOTE (session continuity, 2026-07-15): this file's CHECKPOINT block below (originally written after
CHUNK_5) was STALE relative to disk — two commits landed after it without updating this file:
c91e624 (CHUNK_8 scaffold: specs/SPEC-reviewer-dashboard.md, specs/08_CHUNK_8_REVIEWDASH.md, guardrail
signs — spec only, no code) and 9de30fc (HKO-audit CRITICAL fix: SSO login is now invite-gated/
UPDATE-only; activateUserForLogin refuses a non-invited email; first-owner provisioning explicitly
called out as out-of-band). Both gaps flagged by that audit are now closed: IMPLEMENTATION_PLAN.md
has a CHUNK_8_REVIEWDASH section (commit b4fc3a4), and src/services/provisioning.ts:bootstrapTenant
+ `cli bootstrap-tenant` closes first-owner provisioning (commit 20e788a). CHUNK_6_ONBOARDING is now
also done. Remaining: CHUNK_7_DIGEST, CHUNK_8_REVIEWDASH (spec exists, code does not). Always trust
`git log`/`git diff` over this file when they disagree — this file is best-effort narration.

--- superseded (kept for history; see NOTE above) ---
Current chunk: CHUNK_5_FRONTEND
Current task: 7 of 7 (all complete)
Last completed: CHUNK_5_FRONTEND — all 7 tasks; gate GREEN (128/128) + web:build GREEN + E2E 4/4 GREEN
Status: COMPLETE — CHUNK_5_FRONTEND done. Full gate `migrate:up && lint && typecheck && test && web:build` exit 0; `npm run e2e` (Playwright/Chromium, all /api + Google login stubbed) 4/4 passed INCLUDING the mandatory happy path (mock Google login → Today → open exception → view evidence → approve → Posted + QBO link). Built the Next.js App Router UX under app/: root redirect→/today, /login (client, Google SSO link), (app)/ route group with a client SessionGuard (fetches /api/me; anon→/login) + top nav (Today/Exceptions/Transactions/Settings/Audit Trail). Pages: Today (GET /api/today digest+counts+items), Exceptions queue with keyboard triage J/K/A/R/E/O (A approve owner-only, R reject, E edit-mapping form, O open source email), Transactions list+detail, Settings (read-only connections/automation/thresholds, owner-gated mgmt buttons disabled), read-only Audit Trail. Shared EvidencePanel (email/attachment+sha256/extracted fields+confidence/prior rule/proof refs/QBO link) reused by Today+Exceptions+Transactions-detail. Role gating via app/lib/permissions.ts mirroring ROLE_PERMISSIONS (bookkeeper→"Send to Owner" not Approve; cpa read-only). NEW /api/me route (thin runRead echo of ctx). Build wiring: tsconfig.web.json (jsx+DOM, web-only) via next.config typescript.tsconfigPath + webpack extensionAlias (.js→.ts) so next build typechecks app/ WITHOUT touching the src gate's tsconfig.json (still src/test only, git-confirmed). Added @playwright/test devDep + `e2e` script + playwright.config.ts; AGENTS.md + .gitignore updated. write.ts/forwarder.ts/pipeline UNTOUCHED (git-confirmed); no new QBO-write/send path; UI only calls existing routes. Next: CHUNK_6_ONBOARDING.

========================================================================
CHECKPOINT (operator-requested pause after CHUNK_5). RESUME HERE next session.
========================================================================
Chunks 1–5 built, green, independently validated, committed on branch `northstar-ux-v1`:
  CHUNK_1_AUTH      087c97a   91/91
  CHUNK_2_SERVICES  46a5a8c  101/101
  CHUNK_3_READ      32c252e  114/114
  CHUNK_4_ACTION    247556f  128/128
  CHUNK_5_FRONTEND  366841f  128/128 + web:build (20 routes) + Playwright e2e 4/4
Remaining: CHUNK_6_ONBOARDING → CHUNK_7_DIGEST (see IMPLEMENTATION_PLAN.md + specs/).

To resume in a FRESH Claude Code session:
  1. Confirm DB reachable and baseline green:
     export DATABASE_URL=postgres://aphub:aphub@127.0.0.1:5432/aphub
     npm run migrate:up && npm run lint && npm run typecheck && npm test && npm run web:build
     (expect 128 pass; role/db `aphub` on local :5432 was created this session — if gone, recreate:
      psql -h 127.0.0.1 -p 5432 -U postgres -w -c "CREATE ROLE aphub LOGIN PASSWORD 'aphub' CREATEDB;"
      psql -h 127.0.0.1 -p 5432 -U postgres -w -c "CREATE DATABASE aphub OWNER aphub;" )
  2. .iteration is already 6. Spawn ONE builder subagent for CHUNK_6_ONBOARDING (Mode A) with the same
     guardrails: six guarantees; do NOT touch src/qbo/write.ts, src/gatekeeper/forwarder.ts, or the pipeline.
     CHUNK_6 = migration 004_onboarding.sql (onboarding_state) + dry-run scan (produces proposals, ZERO
     postings) + wizard; dry-run-locked → 403 before automation enabled. Gate includes `npm run web:build`.
  3. Independently re-validate, commit on northstar-ux-v1, then CHUNK_7_DIGEST (migration 005_notifications.sql).
========================================================================

--- prior ---
CHUNK_4_ACTION — all 5 tasks; gate GREEN (128/128, was 114/114). COMPLETE. Gate `migrate:up && lint && typecheck && test` exit 0. DATABASE_URL=postgres://aphub:aphub@127.0.0.1:5432/aphub. Action service layer src/services/action/index.ts (runApprove/runReject/runRetry/runRemap/runLearn/runSendReply) built as the thin auth-guard→parse→service→JSON wrapper (analogous to runRead); ALL logic gate-covered. Thin app/api/** POST wrappers added: proposals/[id]/approve|reject|retry, mappings/remap, corrections/learn, replies/[id]/send. Role gating via requireSession (owner_controller for approve/retry/reply; +bookkeeper for reject/remap/learn). Approve→201 {posting_id,qbo_type,qbo_id,qbo_link,mode:sandbox}; 409 ALREADY_POSTED on dedup; 202 HELD_FOR_REVIEW on fail-safe hold; 202 QBO_RETRY on QBO throw. Reply send-lockdown: any recipient field → 400 VALIDATION; forwarder gets messageId only (no recipient param). Approve reaches QBO only via approveProposal→postOnce→write.ts; send only via forwarder. write.ts/forwarder.ts/pipeline UNTOUCHED. Six-guarantee suite green. Next: CHUNK_5_FRONTEND.

## Instructions for ralph

Update this file after every task. Never delete history — append below.
Keep the `**Current Iteration:**` line intact and in that exact format — loop scripts update it via sed.
