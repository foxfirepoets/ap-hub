# Guardrails — Known Risks and Scope Exclusions

ralph: before taking any action, scan this file. If your action matches a SIGN, stop and report.

## THE SIX GUARANTEES — NEVER BREAK (from CLAUDE.md; existing guarantee tests must stay green)

### SIGN: QBO write outside src/qbo/write.ts, or any Gmail modification
No QBO write may exist before/outside `src/qbo/write.ts`; Gmail is never modified. UX action routes call `write.ts` only.
Mitigation: route handlers call `src/services/*` which call `write.ts`; never add a create/update/delete elsewhere. Test: `no_prod_write`, guarantee 1.

### SIGN: adding a recipient parameter or a second email send path
The ONLY send is the locked gatekeeper forward (`src/gatekeeper/forwarder.ts`), single recipient, no recipient param.
Mitigation: reply-send route accepts NO recipient field; it invokes the existing forwarder. Test: `send_lockdown`, guarantee 2.

### SIGN: QBO write with QBO_ENV != sandbox
Phase 2 writes only to the QBO sandbox; config refuses 'production' at load.
Mitigation: never bypass the sandbox guard in write.ts. Test: `no_prod_write`, guarantee 3.

### SIGN: double-post or double-forward
Two-layer dedup + replay-adopt for posting; UNIQUE(tenant,sha256) + subject-tag replay for forwarding.
Mitigation: reuse existing idempotency keys; never invent a parallel posting path. Guarantee 4.

### SIGN: letting anything unscanned/unproofed through, or fail-open on SwarmSync outage
Nothing reaches ready/posts/forwards without proof coverage; SwarmSync outage → review/hold, never fail-open.
Mitigation: actions that hit an outage return HELD_FOR_REVIEW (202), never proceed. Test: `proof_fail_safe`, `gatekeeper_hold`, `proof_gate_posting`, guarantee 5.

### SIGN: tenant-specific value hard-coded in code
White-label = config only. No tenant-specific value in code.
Mitigation: everything tenant-specific comes from DB/config. Test: `white_label_install`, guarantee 6.

## Pre-Loaded Risks (from spec §14)

### SIGN: an action route shipped before auth middleware exists
Any UI action route shipped before session+RBAC middleware is an ungoverned irreversible action.
Mitigation: CHUNK_1_AUTH must complete first; no action route merges without the session middleware.

### SIGN: pipeline logic re-implemented inside a route handler
Re-implementing pipeline logic in a route creates a second QBO-write/send path (thin-client violation).
Mitigation: route handlers may ONLY call `src/services/*`; code review + guarantee tests catch bypasses.

### SIGN: a UX action that does not append audit_log
A human action that forgets to write audit_log creates a permanent audit-trail gap.
Mitigation: the shared approve/reject/remap service writes audit_log centrally; routes cannot skip it.

### SIGN: a query missing tenant_id scope
A query without tenant_id scope can leak another tenant's data.
Mitigation: use a single scoped query helper; mandatory cross-tenant row-scope integration tests.

### SIGN: changes touching write.ts or forwarder.ts
UX changes that touch write.ts/forwarder.ts can regress guarantees 1/2/3.
Mitigation: those files are OUT OF SCOPE; the existing guarantee suite must stay green in CI.

## Scope Exclusions — Do Not Build (from spec §2)

- DO NOT BUILD: mobile app / responsive-beyond-basics (v2 — desktop web only in v1).
- DO NOT BUILD: AI coworker / chat assistant (v2 — depends on stable read+evidence surface).
- DO NOT BUILD: semantic / accounting-intent search (v2 — v1 uses simple filters).
- DO NOT BUILD: month-end / year-end / tax gap reports (v2).
- DO NOT BUILD: reconciliation UI beyond reading existing reconciliation rows (v2).
- DO NOT BUILD: Xero / Outlook / Google Drive integrations (later phase — QBO+Gmail only in v1).
- DO NOT BUILD: any new QBO-write or Gmail-send code path (guarantees 1/2/3 — call write.ts/forwarder.ts only).
- DO NOT BUILD: any change to the CHUNK_1-8 pipeline (stable dependency — do not touch).

## Standing Guardrails (always active)

- DO NOT add npm dependencies without updating AGENTS.md.
- DO NOT skip the validation gate, even for trivial changes.
- DO NOT commit with --no-verify.
- DO NOT generate code for a future chunk's domain.
- DO NOT modify files outside the current task's scope.
- DO NOT hard-code secrets, API keys, or credentials.

## Accumulation Instructions

When ralph encounters a new failure pattern, append below:

### Sign: A reachable Postgres is a hard prerequisite for the validation gate
- **Trigger**: about to run `npm test` / start an iteration.
- **Instruction**: confirm a Postgres is reachable at DATABASE_URL (default 127.0.0.1:5433, user/db `aphub`) BEFORE building. `npm test` runs DB-backed vitest; without a DB every iteration fails validation for environmental reasons, not code, and will burn all 3 strikes. Do not spawn a builder until the DB responds.
- **Added after**: pre-build confidence check, 2026-07-14.

### Sign: Next.js is not pre-installed in this repo
- **Trigger**: writing `app/api/**` route handlers or React pages.
- **Instruction**: CHUNK_1 task 1 installs next/react and scaffolds the App Router skeleton first. Do not author route handlers before the framework exists. Extend the existing tsc/eslint/vitest config — never replace it (the six-guarantee suite runs under it).
- **Added after**: pre-build confidence check, 2026-07-14.

### Sign: the Next.js `app/` tree is OUTSIDE the validation gate
- **Trigger**: writing route handlers or React pages under `app/` (heavy in CHUNK_5_FRONTEND; also CHUNK_3/4/6/7 route handlers).
- **Instruction**: the gate (`npm run lint`/`typecheck`/`test`) only covers `src/**` + `test/**`, so `app/` code is currently UNVALIDATED. Keep all testable logic in `src/services/*` / `src/auth/*` (gate-covered) and keep `app/` handlers thin wrappers. BEFORE CHUNK_5 lands UI, add a web check (`npm run web:build` and/or a web tsconfig typecheck) to the gate so frontend code is not shipped unvalidated. Playwright E2E (CHUNK_5) is the behavioral cover for `app/`.
- **Added after**: CHUNK_1 independent validation, 2026-07-14.
