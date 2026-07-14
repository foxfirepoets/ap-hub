# Progress Log (append-only)

Project: northstar-ux-v1
Initialized: 2026-07-14
Total chunks: 7

## Log

[2026-07-14T00:00:00Z] Planning complete — IMPLEMENTATION_PLAN.md written (7 chunks, 40 tasks)
<promise>PLANNING COMPLETE</promise>

[2026-07-14T00:10:00Z] Pre-build confidence check (orchestrator). Baseline lint + typecheck GREEN.
Blockers found before iteration 1:
 - ENV: no Postgres at DATABASE_URL (5433); .env missing; Docker daemon not running → gate `npm test` cannot pass.
 - PLAN: Next.js/React not installed; CHUNK_1 reordered to bootstrap the framework first (now 6 tasks, 41 total).
Loop NOT started — awaiting a reachable DB. No builder subagent spawned (would fail validation for environmental reasons, not code).

[2026-07-14] Iteration 1 — CHUNK_1_AUTH (all 6 tasks).
Framework bootstrap: added next/react/react-dom (+@types) and Next App Router skeleton under app/
(layout.tsx, page.tsx) plus next.config.mjs and web:dev/web:build/web:lint scripts. app/ is kept
outside the existing lint/typecheck/test globs so the six-guarantee suite runs unchanged.
DB: migrations/003_auth.sql (users + sessions, UNIQUE(tenant_id,email) / UNIQUE(token_hash),
idx_users_tenant + idx_sessions_user) with IF NOT EXISTS (idempotent) + 003_auth.down.sql.
Auth: src/auth/session.ts (create/validate/revoke; stores only sha256(token); signed httpOnly+
Secure+SameSite=Lax cookie), src/auth/google-sso.ts (Google SSO login URL + verified-callback
upsert + session, reuses google.auth.OAuth2 pattern), src/auth/guard.ts (requireSession →
401 UNAUTHENTICATED / 401 SESSION_EXPIRED / 403 FORBIDDEN + role→permission matrix),
src/db/scoped.ts (tenant-scoped query helper; throws on missing tenant / unscoped SQL).
Config: added GOOGLE_SSO_CLIENT_ID/SECRET, SESSION_COOKIE_SECRET, SESSION_TTL_HOURS, WEB_BASE_URL
(all defaulted). Logger redaction extended to session_token/token_hash/cookie.
Routes: app/api/auth/login|callback|logout (thin wrappers over src/auth/*).
Tests: test/auth-session.test.ts + test/auth-guard.test.ts (+29 tests). Guardrails honored —
write.ts/forwarder.ts/pipeline untouched; no new QBO-write/Gmail-send path; every session carries
one tenant_id. Judgment calls: (a) validateSession treats status!='active' as disabled;
(b) scopedQuery accepts numeric-string tenant ids (pg returns bigint as string);
(c) added 003_auth.down.sql for reversibility though the repo had no prior .down.sql convention.
Gate GREEN: lint + typecheck clean; 91/91 tests pass (was 62/62); migrate:up idempotent.
<promise>CHUNK COMPLETE: CHUNK_1_AUTH</promise>

[2026-07-14] Iteration 2 — CHUNK_2_SERVICES (all 6 tasks).
Built the shared service layer src/services/* — ONE code path to every guarded effect, called
by the CLI now and the API later.
 - src/services/index.ts: ActorContext { userId, tenantId, role, email?, actor? } + withAudit(ctx,
   action, entity, fn) wrapper that appends exactly one human-actor audit_log row (actor = email
   or user:<id>, or 'cli' override) around each mutation; ensurePermission(ctx, perm) enforces the
   CHUNK_1 role→permission matrix inside the service (defence in depth); toActorContext(AuthContext).
 - src/services/approve.ts: approveProposal(ctx, id, deps?) routes through the EXISTING postOnce →
   src/qbo/write.ts (sandbox, idempotent). No new QBO-write code. defaultPostDeps() mirrors the
   post_sandbox job wiring; runPostAndMap() shared with retry; returns posted/held/duplicate/skipped
   + sandbox qboLink. Missing/unavailable proof coverage (SwarmSync outage) → held, never fail-open.
 - src/services/proposals.ts: rejectProposal(ctx, id, {reason, markDuplicate}) (status=rejected +
   optional duplicate exception) and retryProposal(ctx, id) (re-post via the same idempotency key
   through runPostAndMap; already-posted → held, zero second txn).
 - src/services/mappings.ts: remapMapping() upserts a mappings rule; learnCorrection() writes a
   corrections row (became_rule when remember) and, with a mapping payload + remember, upserts the
   mappings rule via the shared upsertMapping() path. Cross-tenant proposal refs refused.
 - src/services/reply.ts: sendReply(ctx, replyId, deps?) invokes createLockedForwarder(...).forward()
   — NO recipient parameter; caller chooses WHICH held forward, never WHERE it goes.
 - src/cli.ts: `correct` now calls learnCorrection; `gatekeeper release` now calls sendReply
   (actor='cli'). No parallel send/write path remains in the CLI.
Tests: test/services.test.ts (10 tests) — approve→one sandbox posting via write.ts + one human audit
row; CPA approve→403 + zero postings; missing proof→held (fail-safe); retry idempotent (no 2nd txn);
reject + duplicate exception; remap rule; learn+remember→became_rule + mapping; cross-tenant learn
refused; sendReply→locked address only, forwarder called with just a messageId; CLI-delegates-to-
services source assertion.
Guardrails honored: src/qbo/write.ts, src/gatekeeper/forwarder.ts, and the pipeline (posting.ts/
mapping.ts) UNTOUCHED (empty git diff). Every mutation tenant-scoped + audited. No tenant-specific
value in code. Six-guarantee suite green.
Gate: `migrate:up && lint && typecheck && test` exit 0 — 101/101 tests (was 91/91), +10 new.
<promise>CHUNK COMPLETE: CHUNK_2_SERVICES</promise>
