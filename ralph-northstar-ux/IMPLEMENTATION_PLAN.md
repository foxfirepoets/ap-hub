# IMPLEMENTATION_PLAN.md

Project: northstar-ux-v1 — Next.js human UX layer over the existing ap-hub pipeline.
Brownfield: DO NOT modify the CHUNK_1-8 pipeline, `src/qbo/write.ts`, or `src/gatekeeper/forwarder.ts`.
Every action route calls `src/services/*`. Every query is tenant-scoped. Every action appends `audit_log`.
Validation gate (every chunk): `npm run lint && npm run typecheck && npm test` — must exit 0, existing six-guarantee suite green.

## Chunk Order

1. CHUNK_1_AUTH — Google-SSO login with tenant-scoped, role-based sessions (foundation; blocks all others).
2. CHUNK_2_SERVICES — shared service layer both the CLI and API call (single code path to guarded effects).
3. CHUNK_3_READ — read-only Today, Exceptions, Transactions, Evidence, Audit endpoints.
4. CHUNK_4_ACTION — role-gated approve/reject/remap/learn/retry/reply routes over the service layer.
5. CHUNK_5_FRONTEND — Next.js shell, core pages, shared Evidence panel.
6. CHUNK_6_ONBOARDING — first-run wizard with a dry-run that posts nothing.
7. CHUNK_7_DIGEST — daily digest + immediate risk alerts, reusing the severity classifier.

---

## Chunk 1: CHUNK_1_AUTH
### Tasks (in order)
1. **Framework bootstrap (do first — Next.js is not yet installed).** Add `next`, `react`, `react-dom`, and dev types (`@types/react`, `@types/react-dom`) to package.json; create a minimal Next.js App Router skeleton under `web/` (or root `app/`) with `app/layout.tsx` + a placeholder `app/page.tsx`; add `next lint`/`next build` wiring that the existing `npm run lint`/`typecheck`/`build` gate still passes (do NOT break the existing `tsc`/eslint/vitest config — extend, don't replace). Record the new deps in AGENTS.md. Verify `npm install && npm run lint && npm run typecheck` stays green.
2. Create `migrations/003_auth.sql`: `users` (id, tenant_id FK tenants ON DELETE CASCADE, email, name, role default 'cpa', google_sub, status default 'invited', created_at; UNIQUE(tenant_id,email)) and `sessions` (id, user_id FK users ON DELETE CASCADE, token_hash, expires_at, revoked default false, created_at; UNIQUE(token_hash)); add `idx_users_tenant`, `idx_sessions_user`. Include reversible DOWN that drops sessions then users. Verify `npm run migrate:up` is idempotent.
3. Create `src/auth/session.ts`: `createSession(userId)` (generate random token, store sha256 hash, set expiry from `SESSION_TTL_HOURS` default 12), `validateSession(rawToken)` (hash-compare, check expiry + revoked), `revokeSession(id)`. Raw token never stored.
4. Create `src/auth/google-sso.ts`: login redirect + callback reusing the existing Google OAuth client; on callback, upsert `users` row (match google_sub/email within tenant), create session, set httpOnly+Secure+SameSite=Lax cookie signed with `SESSION_COOKIE_SECRET`.
5. Create `src/auth/guard.ts` (`requireSession(role?)` → resolves user + tenant_id, returns 401 UNAUTHENTICATED / 401 SESSION_EXPIRED / 403 FORBIDDEN) and `src/db/scoped.ts` (query helper that injects `tenant_id` filter; throws if a caller forgets it).
6. Add Next.js route handlers `app/api/auth/login`, `app/api/auth/callback`, `app/api/auth/logout`; extend `src/logger.ts` redaction to session tokens. Write Vitest unit tests (token hash/validate/revoke, role matrix) + DB integration tests (401 unauth, 403 wrong role, cross-tenant → 404, expiry → 401, disabled user → 401).

> NOTE (build environment): code is written into the ap-hub repo root (`C:\Users\Administrator\Desktop\ap-hub`); ralph state files live under `ralph-northstar-ux/.ralph`. The build subagent runs with cwd = the ap-hub repo root. The validation gate `npm test` requires a Postgres reachable at `DATABASE_URL` (default `postgres://aphub:aphub@127.0.0.1:5433/aphub`) — it must be running before any iteration, or DB-backed tests fail regardless of code correctness.
### Validation
- Command: `npm run lint && npm run typecheck && npm test`
- Expected: exit 0, all tests green (including the existing six-guarantee suite)
### Promise
<promise>CHUNK COMPLETE: CHUNK_1_AUTH</promise>

---

## Chunk 2: CHUNK_2_SERVICES
### Tasks (in order)
1. Create `src/services/index.ts` defining `ActorContext { userId, tenantId, role }` and a shared `withAudit(ctx, action, entity, fn)` wrapper that appends an `audit_log` row with the real human actor around every mutation.
2. Create `src/services/approve.ts` — `approveProposal(ctx, proposalId)` routing through the EXISTING propose/post_sandbox path → `src/qbo/write.ts` (sandbox, idempotent). No new QBO-write code. Returns posting + QBO link; on SwarmSync outage returns a held/review result (never fail-open).
3. Create `src/services/proposals.ts` — `rejectProposal(ctx, id, {reason, markDuplicate})` and `retryProposal(ctx, id)` (safe re-post via the existing idempotency key).
4. Create `src/services/mappings.ts` — `remapMapping(ctx, {kind, sourceKey, targetQboType, targetQboId, remember})` and `learnCorrection(ctx, {proposalId?, exceptionId?, field, newValue, remember})` writing `corrections` (became_rule when remember) + `mappings` upsert via the existing corrections path.
5. Create `src/services/reply.ts` — `sendReply(ctx, replyId)` invoking `src/gatekeeper/forwarder.ts` with NO recipient parameter.
6. Refactor `src/cli.ts` proposal/gatekeeper commands to call these service functions (no CLI behavior change). Add unit tests proving CLI + services share one path, audit rows are written, and the six-guarantee suite stays green.
### Validation
- Command: `npm run lint && npm run typecheck && npm test`
- Expected: exit 0, all tests green (including the six-guarantee suite)
### Promise
<promise>CHUNK COMPLETE: CHUNK_2_SERVICES</promise>

---

## Chunk 3: CHUNK_3_READ
### Tasks (in order)
1. Create `src/services/read/` query modules using the `src/db/scoped.ts` helper — all tenant-scoped, read-only.
2. Add `app/api/today` (GET, requireSession any role) → digest + exception/posted/held/failed counts + item list; counts must equal SELECT-derived counts.
3. Add `app/api/exceptions` (GET, filter by status) and `app/api/exceptions/[id]` (GET).
4. Add `app/api/transactions` (GET) and `app/api/transactions/[id]` (GET) listing prepared/posted/held/reconciled items with status.
5. Add `app/api/items/[id]/evidence` (GET) returning source email ref, attachment ref+sha256, extracted fields, confidence, prior rule (if any), QBO link (if posted) — reuse `v_proposal_review` + attachments/extractions/proof_refs/postings.
6. Add `app/api/audit` (GET, read). Write integration tests: today counts == DB, cross-tenant → 404, evidence returns every present-in-DB field, missing attachment → "missing" marker.
### Validation
- Command: `npm run lint && npm run typecheck && npm test`
- Expected: exit 0, all tests green
### Promise
<promise>CHUNK COMPLETE: CHUNK_3_READ</promise>

---

## Chunk 4: CHUNK_4_ACTION
### Tasks (in order)
1. Add `app/api/proposals/[id]/approve` (POST, requireSession('owner_controller')) → `approveProposal`; return 201 {posting_id, qbo_type, qbo_id, qbo_link, mode:'sandbox'}; 409 ALREADY_POSTED on replay; 202 QBO_RETRY on QBO failure.
2. Add `app/api/proposals/[id]/reject` (owner_controller|bookkeeper) and `app/api/proposals/[id]/retry` (owner_controller).
3. Add `app/api/mappings/remap` and `app/api/corrections/learn` (owner_controller|bookkeeper) → service functions; return became_rule.
4. Add `app/api/replies/[id]/send` (owner_controller) → `sendReply`; if the request body contains any recipient field, return 400 VALIDATION; otherwise invoke the locked forwarder.
5. Integration tests: Owner approve → exactly one posting (mode=sandbox) + one audit_log (human actor) + QBO link; Bookkeeper approve → 403, zero postings; concurrent double-approve → one posting; reply with recipient → 400; learn with remember → rule applied to next matching item; run the full six-guarantee suite and confirm green.
### Validation
- Command: `npm run lint && npm run typecheck && npm test`
- Expected: exit 0, all tests green (six-guarantee suite is the critical gate here)
### Promise
<promise>CHUNK COMPLETE: CHUNK_4_ACTION</promise>

---

## Chunk 5: CHUNK_5_FRONTEND
### Tasks (in order)
1. Scaffold the Next.js App Router app shell + top nav (Today, Exceptions, Transactions, Settings, Audit Trail) behind a session-guarded layout; unauthenticated → redirect to `/login`.
2. Build the Today page consuming `GET /api/today` (digest, counts, item list).
3. Build the Exceptions queue with keyboard triage (J/K navigate, A approve if permitted, R reject, E edit mapping, O open source); clearing an item removes it from the queue.
4. Build Transactions list + detail pages consuming the read API.
5. Build the shared `EvidencePanel` component (email, PDF page, extracted fields, confidence, prior rule, QBO link) used by Today, Exceptions, and Transactions detail.
6. Build Settings (connections + automation level + thresholds view) and read-only Audit Trail; hide/disable action buttons per role (Bookkeeper: no Approve→post, shows "Send to Owner"; CPA: read-only).
7. Write a Playwright E2E: mock Google login → Today → open exception → view evidence → approve → see Posted + QBO link.
### Validation
- Command: `npm run lint && npm run typecheck && npm test`
- Expected: exit 0, all tests green (Playwright E2E included)
### Promise
<promise>CHUNK COMPLETE: CHUNK_5_FRONTEND</promise>

---

## Chunk 6: CHUNK_6_ONBOARDING
### Tasks (in order)
1. Create `migrations/004_onboarding.sql`: `onboarding_state` (tenant_id PK FK tenants, step default 'connect_gmail', dry_run_complete default false, automation_level, updated_at) with reversible DOWN.
2. Add `app/api/onboarding` (GET current state) and `app/api/onboarding/step` (POST advance/persist a choice).
3. Add `app/api/onboarding/dry-run` (POST) triggering the pipeline through `propose` only — assert zero `postings` rows created for the tenant; produce a business-specific summary (email/invoice/vendor-match counts).
4. Build the onboarding wizard UI (connect Gmail → connect QBO → select company → mode/date range → automation level → dry-run → review sample via EvidencePanel → approve initial rules); discovery-before-asking (pull QBO/Gmail/prior data first); render setup blockers as grouped exact-fix cards.
5. Implement enable-auto-post via thresholds and a DRY_RUN_LOCKED guard (any post attempt before automation_level is set away from 'off' → 403). Tests: full wizard leaves 0 postings; post during setup → 403 DRY_RUN_LOCKED; approving rules writes via the CHUNK_2 service path.
### Validation
- Command: `npm run lint && npm run typecheck && npm test`
- Expected: exit 0, all tests green
### Promise
<promise>CHUNK COMPLETE: CHUNK_6_ONBOARDING</promise>

---

## Chunk 7: CHUNK_7_DIGEST
### Tasks (in order)
1. Create `migrations/005_notifications.sql`: `notifications` (id, tenant_id FK tenants, user_id FK users nullable, kind, severity default 'info', payload jsonb, digest_batch date, read_at, created_at) + `idx_notifications_tenant_batch`; reversible DOWN.
2. Create `src/services/digest.ts` computing the daily digest (posted/held/failed/exception counts) from the same `exceptions`/severity source the pipeline uses — reuse `src/swarmsync/severity.ts`; register a daily job in `src/pipeline/register.ts` (one batch/day/tenant).
3. Generate an immediate `risk_alert` notification when the severity classifier flags a material-risk item; routine success generates NO notification.
4. Add `app/api/notifications` (GET) and `app/api/notifications/[id]/read` (POST); render the digest on the Today page.
5. Tests: exactly one digest batch/day with correct counts; routine posting → no notification; bank-change/high-risk item → risk_alert; digest counts match the source (no separate list).
### Validation
- Command: `npm run lint && npm run typecheck && npm test`
- Expected: exit 0, all tests green
### Promise
<promise>CHUNK COMPLETE: CHUNK_7_DIGEST</promise>

---

## Build Complete
When all 7 chunks are done and validation is green, emit:
<promise>BUILD COMPLETE</promise>
Then run spec-vs-build-brutal-audit against `specs/SPEC-northstar-ux-v1.md`.
