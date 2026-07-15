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

## Iteration 6 — CHUNK_5_FRONTEND (COMPLETE)
Built the Next.js App Router human-review UX under app/ (desktop web; thin client — renders API data + calls existing action routes; no business logic, no new QBO-write/send path).
Files created:
 - Build wiring: tsconfig.web.json (jsx+DOM libs, web-only), next.config.mjs (typescript.tsconfigPath→tsconfig.web.json, eslint.ignoreDuringBuilds, webpack extensionAlias .js→.ts/.tsx), app/globals.css
 - Shell: app/page.tsx (redirect→/today), app/login/page.tsx, app/(app)/layout.tsx (SessionGuard shell), app/(app)/Nav.tsx, app/lib/session.tsx (client SessionGuard+useSession; GET /api/me, anon→/login)
 - Pages: app/(app)/today, /exceptions (keyboard triage J/K/A/R/E/O), /transactions (+/[id] detail), /settings, /audit
 - Shared: app/components/EvidencePanel.tsx (email/attachment+sha256/extracted fields+confidence/prior rule/proof refs/QBO link; onLoaded callback), app/components/ActionBar.tsx (role-gated), app/components/RemapForm.tsx
 - Lib: app/lib/types.ts (response-shape mirrors, type-only), app/lib/api.ts (apiGet/apiPost + proposalRefId), app/lib/permissions.ts (mirrors ROLE_PERMISSIONS), app/lib/format.ts
 - API: app/api/me/route.ts (thin runRead echo of ctx.email/role/tenantId)
 - E2E: playwright.config.ts (webServer next build+start :3100, reuseExistingServer), e2e/app.spec.ts (4 tests, all /api + Google login stubbed)
 - Modified: app/layout.tsx (import globals.css), package.json (+@playwright/test devDep, +e2e script), AGENTS.md (Web UI section), .gitignore (.next/next-env/test-results)
Validation (all GREEN):
 - lint: exit 0 (eslint src/**+test/** — app/ intentionally outside src gate)
 - typecheck: exit 0 (tsc --noEmit; tsconfig.json still src/test only — git-confirmed untouched)
 - test: 128 passed (128), 16 files — six-guarantee suite green
 - web:build: Compiled successfully, 20 routes, typechecks all app/ via tsconfig.web.json
 - e2e: 4/4 passed (Playwright/Chromium headless) INCLUDING mandatory happy path: mock Google login → Today → open exception → view evidence → approve → Posted notice + QBO sandbox link. Edge tests: anon→/login redirect; bookkeeper shows "Send to Owner" + no approve-btn; cpa read-only (no approve/reject/edit).
E2E EXECUTION STATUS: AUTHORED AND EXECUTED GREEN in this environment (Chromium binaries present). `npm run e2e` builds+serves the prod app on :3100 with all /api and the Google login redirect stubbed via page.route, so it runs without a live DB or Google — CI-ready.
Judgment calls:
 - Client-fetch pages (not RSC) so the API contract is consumed literally ("GET /api/today") AND the E2E can stub every /api call via page.route without a DB/Google. Auth guard is client-side (fetch /api/me → redirect); real authZ is still enforced server-side by every route (403/401). This is UX redirect, not the security boundary.
 - app/ typechecking: added tsconfig.web.json + next.config typescript.tsconfigPath so `next build` fully typechecks React/pages WITHOUT modifying the src gate's tsconfig.json (Next auto-added isolatedModules to the WEB tsconfig only). Closes the "app/ is outside the gate" guardrail: app/ now has real type coverage via web:build + behavioral coverage via E2E.
 - webpack extensionAlias (.js→.ts) added so pre-existing CHUNK_3/4 route handlers (which use .js ESM specifiers resolving to .ts) compile under next build; route files untouched.
 - "Mock Google login" = stub GET /api/auth/login → 302 /today (the real Google consent/callback is CHUNK_1's job and out of scope for a UI E2E). Clicking the real "Sign in with Google" link exercises that seam.
 - "Send to Owner" (bookkeeper) is a client-only escalation notice — there is no server escalation endpoint and none may be invented (no new QBO-write/send path). Label differs per role per spec; server still forbids bookkeeper approve→post (403).
 - Settings is read-only (no settings-mutation API in this phase); owner-only "Manage" buttons rendered disabled (connections are config-provisioned). No tenant-specific value hard-coded.
 - Action notice hoisted above the queue/detail split so a "Posted" result survives the approved item leaving the queue; notice cleared only on explicit J/K/click navigation.
Guardrail check: src/qbo/write.ts, src/gatekeeper/forwarder.ts, src/pipeline/* UNTOUCHED (git-confirmed). No new QBO-write or email-send path; UI only calls existing CHUNK_3 read + CHUNK_4 action routes. No recipient field introduced. tsconfig.json (src gate) unchanged.
<promise>CHUNK COMPLETE: CHUNK_5_FRONTEND</promise>

## Iteration 7 — CHUNK_6_ONBOARDING (COMPLETE)
Built via ralph Mode A (Agent-tool subagent), orchestrator independently re-ran the full gate
before committing (did not trust the subagent's own report).
Files created:
 - migrations/004_onboarding.sql + .down.sql (onboarding_state: tenant_id PK FK tenants, step,
   dry_run_complete, automation_level, updated_at)
 - src/services/onboarding.ts — state/discovery (Gmail/QBO/prior-data read before prompting),
   blocker cards, advanceOnboardingStep, runOnboardingDryRun (reuses the EXISTING proposeOnce from
   src/pipeline/mapping.ts with no enqueuePost dependency — structurally cannot reach post_sandbox),
   isDryRunLocked/assertNotDryRunLocked (DRY_RUN_LOCKED gate)
 - src/services/action/onboarding.ts (thin HTTP bridge) + app/api/onboarding{,/step,/dry-run}/route.ts
 - app/(app)/onboarding/page.tsx — wizard UI (discovery panel, grouped exact-fix blocker cards,
   dry-run summary, EvidencePanel review, RemapForm for approving initial rules, automation selector)
 - test/onboarding.test.ts (11 tests)
Files modified:
 - src/auth/guard.ts (+'onboard' permission, owner_controller only)
 - src/services/approve.ts, src/services/proposals.ts (call assertNotDryRunLocked before posting)
 - src/services/action/index.ts (dry_run_locked → 403), app/lib/types.ts, app/(app)/Nav.tsx (+Setup link)
Judgment call (disclosed): DRY_RUN_LOCKED only gates a tenant that has an onboarding_state row —
a tenant with no row (e.g. pre-existing CHUNK_4 tests) is not gated, for backward compatibility.
Tested explicitly.
Gate (orchestrator-verified independently): lint clean, typecheck clean, 145/145 tests (was 134/134,
+11 new), migrate:up idempotent, web:build 24 routes (was 20). Protected-file diff (write.ts,
forwarder.ts, src/pipeline/) empty vs 9858eaa.
<promise>CHUNK COMPLETE: CHUNK_6_ONBOARDING</promise>

## Iteration 8 — CHUNK_7_DIGEST (COMPLETE)
Built via ralph Mode A (Agent-tool subagent), orchestrator independently re-ran the full gate
before committing.
Files created:
 - migrations/005_notifications.sql + .down.sql (notifications table + idx_notifications_tenant_batch
   + a partial unique index uq_notifications_daily_digest on (tenant_id, digest_batch) WHERE
   kind='daily_digest' — enforces one batch/day/tenant at the DB level)
 - src/services/digest.ts — generateDailyDigest (reuses getTodayCounts from CHUNK_3, the same source
   Today uses; defers with no row written if the counts source throws — never emits wrong/zero counts),
   maybeRaiseRiskAlert (fires only for bank_change_warning/duplicate/fraud_flag — the material-risk
   reason codes the severity classifier produces), digestHandler/scheduleDigest (pg-boss job)
 - src/services/notifications.ts + action bridge (mark-read, audited) + src/services/read/notifications.ts
 - app/api/notifications{,/[id]/read}/route.ts
 - test/digest.test.ts (12 tests)
Files modified:
 - src/exceptions.ts (raiseException now calls maybeRaiseRiskAlert — the only way to catch
   mapping.ts's severity-classifier-driven exceptions without touching the forbidden pipeline/mapping.ts)
 - src/pipeline/register.ts (additive only: registers the digest job), src/queue.ts (+digest to JOBS)
 - app/(app)/today/page.tsx, app/lib/types.ts (Today renders digest/risk_alert panel + mark-read)
Gate (orchestrator-verified independently): lint clean, typecheck clean, 157/157 tests (was 145/145,
+12 new), migrate:up idempotent, web:build 25 routes (was 24). Protected-file diff (write.ts,
forwarder.ts, src/pipeline/mapping.ts, src/pipeline/posting.ts) empty vs 9858eaa; register.ts diff
reviewed and confirmed small/additive.
<promise>CHUNK COMPLETE: CHUNK_7_DIGEST</promise>

## Iteration 9 — CHUNK_8_REVIEWDASH (COMPLETE — final chunk)
Built via ralph Mode A (Agent-tool subagent), orchestrator independently re-ran the full gate,
reviewed the two new service files line-by-line (idempotency reason string cross-checked against
src/pipeline/posting.ts:58/155; redaction confirmed in snapshot.ts), and confirmed a real end-to-end
run (snapshot -> generator -> HTML -> replay) before committing. No schema change (none required).
Files created:
 - src/services/review/snapshot.ts — buildReviewSnapshot (tenant-scoped via scopedQuery, minor-unit
   amount_cents from proposed_txn, deriveRisk reusing the existing severity flag vocabulary
   bank_change_warning/duplicate/fraud_flag=high, confidence<REVIEW_THRESHOLD=med else low, whole
   snapshot passed through src/logger.ts redact() before return)
 - src/services/review/apply-decisions.ts — applyDecisions: approved->approveProposal,
   rejected->rejectProposal, pending/unknown->skip; every id resolved under the caller's tenant via
   scopedQuery BEFORE any action (foreign/nonexistent id -> skipped); idempotent replay detected via
   held reason 'status=posted_sandbox' (posting.ts's own re-run gate) counted as posted, not error;
   any other held (e.g. missing_proof_coverage) -> error + drives non-zero CLI exit; postDeps (needs
   a connected QBO client) built LAZILY only when an approved decision is actually reached, so a
   reject-only replay never requires a QBO connection (bug found+fixed during the subagent's own
   manual E2E verification, before reporting done)
 - scripts/build-review-dashboard.mjs — zero-dependency Node generator; self-contained HTML,
   textContent-only rendering, `<` escaped in embedded DATA, localStorage key aphub-review-<runId>,
   JSON+CSV export keyed by proposal_id
 - src/cli.ts: `review-snapshot --tenant <id> --out <path>` and `apply-review-decisions <file>
   --tenant <id>` subcommands (thin wrappers over the two services above)
 - test/review-snapshot.test.ts (10), test/review-apply-decisions.test.ts (6),
   test/review-dashboard-generator.test.ts (6) — 22 new tests
Real E2E verification performed by the subagent (not just unit tests): seeded a live tenant/proposal,
ran review-snapshot -> real JSON, ran the generator -> single self-contained HTML file, grepped it for
zero external hosts and correct <script>-payload neutralization, ran apply-review-decisions for real
(reject path succeeded; approve path correctly fail-safed non-zero since this synthetic tenant has no
live QBO sandbox OAuth connection — expected, no unproven write).
Gate (orchestrator-verified independently): lint clean, typecheck clean, 179/179 tests (was 157/157,
+22 new), web:build still exactly 25 routes (zero new UI surface, as expected — no app/ work in this
chunk), no new migration (confirmed: none added). Protected-file diff (write.ts, forwarder.ts,
src/pipeline/) empty vs 9858eaa except the already-committed CHUNK_7 register.ts addition (no further
change from this chunk). Six-guarantee suite green.
<promise>CHUNK COMPLETE: CHUNK_8_REVIEWDASH</promise>

<promise>BUILD COMPLETE</promise>
All 8 chunks green. Next: spec-vs-build-brutal-audit / HKO-truth-audit, then PR (per operator instructions — do not merge without the owner).

## HKO-truth-audit (post-build) — FAIL -> PASS
Independent fresh-context security review of the full 9de30fc..HEAD diff found 1 HIGH (automatic
propose->post_sandbox pipeline path bypassed the CHUNK_6 DRY_RUN_LOCKED guard — only the manual
approve/retry actions checked it) + 1 MEDIUM (CSV formula-injection in the reviewer-dashboard export)
+ 1 LOW (disclosed, not fixed). Both HIGH and MEDIUM fixed this session (commit 66d999f): a new
guardedPostSandboxHandler in src/pipeline/register.ts gates every post_sandbox job on
isDryRunLocked without touching mapping.ts/posting.ts; csvEscape now neutralizes formula-trigger
leading characters (self-caught a regex range bug in the first attempt before committing). 183/183
green. Full findings + verified-safe list + residual risks in .claude/audits/HKO/HKO-certificate.md.
Verdict: PASS (post-remediation). Next: open a PR, do not merge without the owner.
