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

[2026-07-14] Iteration 3 — CHUNK_3_READ (all 6 tasks).
Built the read-only projection layer. ALL testable logic in src/services/read/* (gate-covered);
app/api/** handlers are thin GET wrappers (app/ is outside lint/typecheck/test per guardrail).
Every query tenant-scoped through src/db/scoped.ts; nothing here mutates; no audit rows written.
 - src/services/read/http.ts: runRead(request, handler, {role?}) — resolves the session (cookie or
   Bearer), maps a null/undefined handler result → 404 NOT_FOUND, AuthError → its 401/403, value →
   200 {data}. So a cross-tenant id yields no scoped row → handler null → 404 (never foreign rows).
   Also jsonResponse/errorResponse/tokenFromRequest/readContext and the data-driven sandboxLink().
 - src/services/read/today.ts: getTodayCounts (exceptions open / postings posted_sandbox / proposals
   review=held / proposals exception=failed via ::int sub-selects — equals independent SELECT counts)
   + getTodayItems (from v_proposal_review) + getToday.
 - src/services/read/exceptions.ts: listExceptions({status?}) + getExceptionById → null cross-tenant.
 - src/services/read/transactions.ts: listTransactions/getTransactionById — proposal status → UX
   status (prepared/held/posted/reconciled/rejected/exception), LATERAL join to the latest
   posted_sandbox posting for qbo_type/id/realm → sandbox qboLink; reconciled = EXISTS matched recon.
 - src/services/read/evidence.ts: getEvidence(tenantId, proposalId) → source email ref, attachment
   ref+sha256 (or 'attachment' in missing[]), extracted fields+confidence, prior vendor mapping rule
   (matched on lower(vendor_name)), proof_refs across extraction/proposal/posting, posting + qboLink.
   Cross-tenant proposal → null. Reuses v_proposal_review semantics via explicit tenant-scoped joins.
 - src/services/read/audit.ts: listAudit({action?,entity?,limit?}) newest-first, tenant-scoped (read
   only; audit rows are written by the CHUNK_2 service layer).
 - app/api: today, exceptions, exceptions/[id], transactions, transactions/[id],
   items/[id]/evidence, audit — each one call to runRead + the matching read function.
Tests: test/read.test.ts (+13) — today counts == DB SELECT counts and are tenant-scoped; exceptions
status filter + cross-tenant getById → null; transactions status mapping + qboLink + reconciled, and
cross-tenant → null; evidence returns every present field incl. sha256/prior rule/proofs/qboLink;
missing attachment → 'attachment' marker with other fields intact; cross-tenant evidence → null;
audit tenant-scoped; runRead 401 (no session), 404 (null), 200 (value), cookie-session end-to-end 404.
Guardrails honored: src/qbo/write.ts, src/gatekeeper/forwarder.ts, pipeline UNTOUCHED (empty git diff);
read-only (no create/update/delete); no recipient/send path; no tenant-specific value in code.
Judgment calls: (a) "item" id = proposal id (the evidence subject); (b) held=proposals.review,
failed=proposals.exception, posted=postings.posted_sandbox, exceptions=open — counts fixed so a test
recomputes the same SELECTs; (c) prior rule = vendor mapping matched on lower(vendor_name);
(d) sandboxLink duplicated as a pure formatter in the read layer (realm is data-driven) rather than
importing from CHUNK_2 approve.ts, keeping the read layer self-contained; (e) runRead accepts a Bearer
token in addition to the signed cookie to make the wrapper unit-testable.
Gate: `migrate:up && lint && typecheck && test` exit 0 — 114/114 tests (was 101/101), +13 new.
<promise>CHUNK COMPLETE: CHUNK_3_READ</promise>

[2026-07-14 CHUNK_4_ACTION] BUILD complete — role-gated action routes over the CHUNK_2 service layer.
Files created:
 - src/services/action/index.ts (gate-covered): runApprove/runReject/runRetry/runRemap/runLearn/runSendReply
   + internal runAction wrapper (auth-guard→parse-body→role-gate→service→JSON), postResultResponse
   (posted→201, duplicate→409 ALREADY_POSTED, held→202 HELD_FOR_REVIEW, skipped→404), qboRetryOnThrow
   (QBO throw→202 QBO_RETRY), serviceErrorResponse (*_not_found→404), and the RECIPIENT_FIELDS lockdown check.
 - app/api/proposals/[id]/approve/route.ts, .../reject/route.ts, .../retry/route.ts (thin POST wrappers)
 - app/api/mappings/remap/route.ts, app/api/corrections/learn/route.ts, app/api/replies/[id]/send/route.ts
 - test/action.test.ts (14 DB/integration tests)
Judgment calls:
 - Role gating enforced at TWO layers: requireSession(role) in runAction + ensurePermission inside each service (defence in depth). Bookkeeper approve → 403 before any writer call.
 - numOrUndef coerces numeric-string ids (proposal ids are bigint → pg/JSON present them as strings) so body proposalId/exceptionId scope-check runs (else proposal_id stored NULL).
 - Concurrent double-approve asserts the true invariant: exactly ONE posting row; loser is 201 (idempotent upsert) / 409 (dedup) / 202 (safe retry on row contention) — never a 5xx, never a second post.
 - Fail-safe hold (missing proof coverage / below threshold / verify mismatch) → 202 HELD_FOR_REVIEW (never fail-open).
Gate: migrate:up && lint && typecheck && test → exit 0. Tests: 128 passed (128) — up from 114. Six-guarantee suite (lockdown, posting dedup, proof_fail_safe, gatekeeper_hold, no_prod_write, white_label) all green.
Guardrail check: src/qbo/write.ts, src/gatekeeper/forwarder.ts, and src/pipeline/* UNTOUCHED (git-confirmed). No new QBO-write or email-send path. No recipient parameter anywhere in new code.
<promise>CHUNK COMPLETE: CHUNK_4_ACTION</promise>
