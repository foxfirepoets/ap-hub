# SPEC: AP-hub North Star UX Layer v1

## Metadata
- Version: 1.0 | Date: 2026-07-14 | Tier: FULL | Greenfield/Brownfield: Brownfield (new UX layer over a built backend)
- Status: Ready for Build
- Success measure: A non-accountant completes onboarding in dry-run (zero QBO postings during setup), then clears one exception and approves one posting end-to-end with full evidence — with all six backend guarantees still green.
- Architecture grounding: `architecture-decision-packet-ap-hub-northstar-ux-2026-07-14.md` (verdict READY_FOR_SPEC)
- Open questions: 2

## Tech Stack
- Language: TypeScript (ESM, `moduleResolution: Bundler` — matches existing repo)
- Frontend: Next.js (App Router) + React 18 + TypeScript, in the **same repo** (`web/` app dir)
- API: Next.js Route Handlers (`app/api/**`) — the read/action API. These CALL existing `src/` services; they never re-implement pipeline logic.
- Backend (existing, unchanged): Node 20, pg-boss, Postgres, `src/qbo/write.ts`, `src/gatekeeper/forwarder.ts`, `src/swarmsync/*`
- DB: PostgreSQL (existing) — new migration `003_ux_auth.sql`
- Auth: Google OAuth (SSO) reusing existing Google OAuth client infra; server-side sessions (httpOnly cookie, token hash in DB)
- Testing: Vitest (unit + DB-backed), Playwright (E2E)
- Hosting: single Node process for backend/workers (unchanged) + Next.js server (same repo, same host or Vercel-compatible). Env-driven config.

## Architecture Grounding Summary

**Systems touched (new):** `web/` Next.js app; `app/api/**` read+action routes; new tables `users`, `sessions`, `notifications`, `onboarding_state`; a thin shared service layer extracted from CLI/pipeline (`src/services/*`).

**Systems touched (read-only projection):** `messages`, `proposals`, `postings`, `exceptions`, `mappings`, `extractions`, `attachments`, `proof_refs`, `audit_log`, `forwards`, `v_proposal_review`.

**Systems NOT touched (left alone):** the CHUNK_1–8 pipeline, `src/qbo/write.ts`, `src/qbo/client.ts`, `src/gatekeeper/forwarder.ts`, `src/swarmsync/*`. The UX layer calls these; it does not modify them.

**Source of truth (from packet §5):**
| Entity | SoT | UX role |
|---|---|---|
| Accounting objects | QBO sandbox | read + trigger write via `write.ts` |
| Pipeline state (message→posting) | Local Postgres | read |
| Mapping rules | Local `mappings` | write via existing corrections path only |
| Audit trail | Local `audit_log` (append-only) | every UX action appends |
| Human identity | New `users` (this spec) | owns |

**Must NOT break (→ regression tests in §10):**
1. No QBO write before/outside `write.ts`; Gmail never modified (guarantee 1).
2. Only send path is the locked gatekeeper forward; no recipient param (guarantee 2).
3. QBO writes sandbox-only (guarantee 3).
4. No double-post / double-forward (guarantee 4).
5. Nothing unscanned/proof-gated gets through; SwarmSync outage → hold, never fail-open (guarantee 5).
6. White-label = config only, no tenant-specific values in code (guarantee 6).

**Reuse decisions:** Google OAuth infra (reuse), `v_proposal_review` (reuse as read query), severity classifier (`src/swarmsync/severity.ts`) for digest, existing thresholds (`AUTO_THRESHOLD`, `REVIEW_THRESHOLD`, `AMOUNT_CEILING`).

---

## 1. Executive Summary

AP-hub already reads accounting email and prepares reviewable QuickBooks (sandbox) transactions, but it has no screen — only a command line and a database view. This project builds the **product people actually use**: a web app where an owner connects Gmail and QuickBooks, runs a safe "dry-run" that posts nothing, then day-to-day sees only the handful of items that need a human — each with the source email, the document, and a plain-English reason. They click Approve, and it posts through the same safe, already-built machinery. Success in 30 days: a non-accountant can onboard, clear an exception, and approve a posting end-to-end, and every existing safety guarantee still passes its test. Build size: about **3–4 weeks** of agent work, delivered in 7 phases starting with login.

---

## 2. Scope & Do Not Build

**In scope (v1):**
- **Auth foundation:** Google SSO login; `users`/`sessions` tables; 3 roles (Owner/Controller, Bookkeeper, CPA); session middleware scoping every request to one `tenant_id`.
- **Read API** (`app/api`): `GET /api/today`, `GET /api/exceptions`, `GET /api/exceptions/:id`, `GET /api/transactions`, `GET /api/transactions/:id`, `GET /api/items/:id/evidence`, `GET /api/audit` (read), `GET /api/notifications`.
- **Action API:** `POST /api/proposals/:id/approve`, `POST /api/proposals/:id/reject`, `POST /api/mappings/remap`, `POST /api/corrections/learn`, `POST /api/proposals/:id/retry`, `POST /api/replies/:id/send` (draft-approval → existing forwarder only).
- **Frontend pages:** Today, Exceptions (queue + keyboard triage), Transactions (list + detail), Evidence panel (shared component), Onboarding wizard (dry-run by default), Settings (connections + automation level + thresholds view), Audit Trail (read).
- **Onboarding:** connect Gmail → connect QBO → select company → mode/date range → automation level → dry-run scan → review sample → approve initial rules → enable auto-post. Zero QBO postings until explicitly enabled.
- **Daily digest:** one notification batch/day per tenant summarizing posted/held/failed + exception counts, reusing severity classifier. Immediate alert only for material risk.

### Do Not Build
- **Mobile app / responsive-beyond-basics** — deferred to v2; v1 is desktop web. Reason: North Star scopes mobile to a later, reduced surface; building it now doubles UI work before the core loop is proven.
- **AI coworker / chat assistant** — deferred to v2. Reason: depends on the read API + evidence surface existing and stable first; high complexity, not needed to prove the core loop.
- **Semantic / accounting-intent search** — deferred to v2. Reason: same dependency; v1 uses simple filters, not natural-language search.
- **Month-end / year-end / tax gap reports** — deferred to v2. Reason: read-only reporting layered on the same data; valuable but not required for the daily approve-loop.
- **Reconciliation UI** (beyond read of existing `reconciliation` rows) — deferred to v2. Reason: reconciliation matching logic is a separate workstream.
- **Xero / Outlook / Google Drive integrations** — deferred. Reason: North Star lists them as later-phase; QBO+Gmail is v1.
- **New QBO-write or Gmail-send code paths** — never build. Reason: guarantees 1/2/3; the UX must call `write.ts`/`forwarder.ts` only.
- **Changes to the CHUNK_1–8 pipeline** — out of scope. Reason: it is a stable dependency; touching it risks the guarantees.

---

## 3. Business Context & Acceptance Criteria

**Goal:** Give AP-hub a trustworthy human surface so a non-accountant can operate it safely — see only exceptions, verify evidence, approve postings — without breaking any backend guarantee.

**Success metric / target:** End-to-end demo passes: onboarding produces **0** postings; a user then clears ≥1 exception and approves ≥1 posting that lands in QBO sandbox with a source attachment and an audit row. All six guarantee tests green.

**Acceptance criteria (machine-verifiable):**
- [ ] Unauthenticated request to any `/api/*` (except auth) returns exactly `401 UNAUTHENTICATED` — FAIL if 200/302/500.
- [ ] A Bookkeeper calling `POST /api/proposals/:id/approve` returns exactly `403 FORBIDDEN` (role lacks post) — FAIL if it posts or 500s.
- [ ] User A's session requesting User B's tenant data returns `404 NOT_FOUND` (never B's rows) — FAIL if any B row returns.
- [ ] `GET /api/today` counts equal `SELECT`-derived counts on `exceptions`/`proposals`/`postings` for that tenant — FAIL on mismatch.
- [ ] `GET /api/items/:id/evidence` returns source email ref, attachment ref+sha256, extracted fields, confidence, prior rule (if any), and QBO link if posted — FAIL if any present-in-DB field is omitted.
- [ ] Onboarding through "review sample" creates ≥1 `proposals` row and exactly `0` `postings` rows for the tenant — FAIL if any posting exists.
- [ ] `POST /api/proposals/:id/approve` (as Owner) results in exactly one `postings` row with `mode='sandbox'`, one `audit_log` row with the human actor, and returns the QBO object link — FAIL on 0 or >1 postings, missing audit row, or actor='system'.
- [ ] Double-clicking Approve (two concurrent calls) yields exactly one posting (idempotency) — FAIL if two.
- [ ] `POST /api/replies/:id/send` cannot specify a recipient; it invokes the existing forwarder (locked address) — FAIL if any recipient field is accepted or a second send path is used.
- [ ] A correction submitted with "remember" creates a `corrections` row with `became_rule=true` and a `mappings` upsert; the next matching item uses it — FAIL if not applied.
- [ ] Full existing guarantee suite (`npm test`) stays green with the UX layer present — FAIL on any regression.

**DONE means ALL true in the DEPLOYED environment, with an artifact per item (HTTP response, DB row, screenshot, log line):**
1. Each acceptance criterion above, observed live.
**NOT done if:**
- Verified only locally ("works on my machine" is not done)
- "Code looks correct" / "tests should pass" — only observed behavior counts
- Any must-not-break item is untested

---

## 4. Architecture & System Integration

```
Browser (Next.js React pages)
   │  httpOnly session cookie
   ▼
Next.js Route Handlers (app/api/**)   ── session middleware: authn + role + tenant_id scope
   │  (thin client — no pipeline logic here)
   ▼
src/services/* (shared service layer, extracted from CLI/pipeline)
   ├── read: query Postgres (messages, proposals, exceptions, postings, v_proposal_review, ...)
   ├── approve → existing propose/post_sandbox path → src/qbo/write.ts (sandbox, idempotent) → postings + audit_log
   ├── remap/learn → existing corrections + mappings path
   └── reply send → src/gatekeeper/forwarder.ts (locked recipient)
   ▼
Postgres  ◄── pg-boss pipeline workers (unchanged)  ──► QBO sandbox / Gmail / SwarmSync
```

- **New infra:** Next.js app in-repo; `003_ux_auth.sql`; shared service layer module.
- **Integration points:** Google OAuth (login); all external I/O (QBO/Gmail/SwarmSync) remains behind existing adapters. The UX never calls QBO/Gmail directly.
- Agrees with grounding summary: single write path, single send path, tenant scoping, thin client.

---

## 5. User Flows & Happy Path

**Flow A — Onboarding dry-run.** Actor: Owner (human). Precondition: account created, logged in via Google. Steps: 1) Connect Gmail (existing OAuth). 2) Connect QBO (existing OAuth, sandbox). 3) Select company. 4) Choose accounting mode + date range. 5) Choose automation level. 6) Run dry-run scan (pipeline runs classify→extract→map→propose, **no post**). 7) Review business-specific summary + sample proposals with evidence. 8) Approve initial mapping rules. 9) Enable auto-post by confidence threshold. Postcondition: `onboarding_state.dry_run_complete=true`, 0 postings. Alt: Gmail scope denied → blocker card "Reconnect Gmail with label access." Alt: QBO company not selected → blocker card.

**Flow B — Daily exception review.** Actor: Bookkeeper. Precondition: logged in, items in queue. Steps: 1) Open Today → see digest + exception count. 2) Open Exceptions queue. 3) Select an exception → Evidence panel (email, PDF page, extracted fields, confidence, recommended fix). 4) Fix (remap / add project) → choose "apply once" or "remember." 5) Item leaves queue. Postcondition: exception resolved, optional rule created. Keyboard: J/K navigate, A approve (if permitted), R reject, E edit mapping, O open source. Alt: Bookkeeper hits an approve-required item → sees "Send to Owner" (no post permission).

**Flow C — Approve → post.** Actor: Owner/Controller. Precondition: a Ready proposal. Steps: 1) Open Transactions or Today. 2) Open proposal → evidence. 3) Approve. 4) System routes to post_sandbox → `write.ts` → QBO. 5) UI shows Posted + QBO link + audit entry. Postcondition: one posting, one audit row. Alt: QBO validation error → item becomes Exception with plain-English reason + safe retry.

**Flow D — Evidence lookup.** Actor: CPA (read-only). Steps: open any item → Evidence panel; export evidence package (read-only). Postcondition: nothing changes; audit logs the view/export.

**Flow E — Fix once, learn forever.** Actor: Bookkeeper. Steps: correct a mapping → "remember for next time" → `corrections.became_rule=true` + `mappings` upsert → next matching item auto-applies the rule. Postcondition: future exceptions of that type reduced.

---

## 6. Data Models & Schema

**New tables (migration `003_ux_auth.sql`):**

```
users(
  id bigserial PK,
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email text NOT NULL,
  name text,
  role text NOT NULL DEFAULT 'cpa',      -- 'owner_controller' | 'bookkeeper' | 'cpa'
  google_sub text,                       -- Google subject id
  status text NOT NULL DEFAULT 'invited',-- 'invited' | 'active' | 'disabled'
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email)
)

sessions(
  id bigserial PK,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL,              -- sha256 of the cookie value; raw token never stored
  expires_at timestamptz NOT NULL,
  revoked boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (token_hash)
)

notifications(
  id bigserial PK,
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id bigint REFERENCES users(id) ON DELETE CASCADE,  -- null = tenant-wide
  kind text NOT NULL,                    -- 'daily_digest' | 'risk_alert'
  severity text NOT NULL DEFAULT 'info', -- reuse severity vocabulary
  payload jsonb NOT NULL,
  digest_batch date,                     -- groups a day's digest
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
)

onboarding_state(
  tenant_id bigint PK REFERENCES tenants(id) ON DELETE CASCADE,
  step text NOT NULL DEFAULT 'connect_gmail',
  dry_run_complete boolean NOT NULL DEFAULT false,
  automation_level text,                 -- 'off' | 'high_confidence' | 'aggressive'
  updated_at timestamptz NOT NULL DEFAULT now()
)
```

Indexes: `idx_users_tenant ON users(tenant_id)`, `idx_sessions_user ON sessions(user_id)`, `idx_notifications_tenant_batch ON notifications(tenant_id, digest_batch)`.

**Request/response shapes (examples):**

Valid approve request: `POST /api/proposals/42/approve` body `{}` (proposal id in path; actor from session). Response `201 { "posting_id": 88, "qbo_type": "Bill", "qbo_id": "145", "qbo_link": "https://.../145", "mode": "sandbox" }`.

Invalid: `POST /api/proposals/42/approve` where proposal already `posted_sandbox` → `409 { "error": "ALREADY_POSTED", "posting_id": 88 }`.

Validation rules: `role` ∈ enum; `automation_level` ∈ enum; session cookie required and unexpired; all queries filtered by `session.tenant_id`.

---

## 7. Error Handling & Edge Cases

| Scenario | Status | Code | Response / Recovery |
|---|---|---|---|
| No/invalid session | 401 | UNAUTHENTICATED | Redirect to Google login |
| Session expired | 401 | SESSION_EXPIRED | Re-auth; old session revoked |
| Role lacks permission (e.g. Bookkeeper approve) | 403 | FORBIDDEN | "Send to Owner" affordance; no state change |
| Cross-tenant access attempt | 404 | NOT_FOUND | Never leak existence; log security event |
| Proposal already posted | 409 | ALREADY_POSTED | Return existing posting_id (idempotent) |
| Concurrent double-approve | 201 once / 409 | ALREADY_POSTED | Existing `UNIQUE(tenant,idempotency_key)` + replay-adopt |
| QBO validation/API failure on approve | 202 | QBO_RETRY | Item → Exception, plain-English reason, safe retry |
| SwarmSync outage during action | 202 | HELD_FOR_REVIEW | Hold, never fail-open (guarantee 5) |
| Reply send with recipient field present | 400 | VALIDATION | Reject; forwarder has no recipient param |
| Extraction/attachment missing for evidence | 200 | (partial) | Show available evidence + "missing: X" |
| Onboarding tries to post before enabled | 403 | DRY_RUN_LOCKED | Blocked; dry-run default |

**Edge cases:** duplicate invoice flagged → show duplicate banner + merge/reject; unreadable PDF → exception with "unsupported/corrupted"; vendor bank-change email → never auto-post, always held; a user disabled mid-session → next request 401.

---

## 8. Performance & Scalability

Realistic solo/SMB scale: tens of tenants, thousands of items/month each.
- `GET /api/today`, `/api/exceptions`: p95 < 500ms (indexed queries on `(tenant_id, status)` — indexes already exist).
- Evidence panel: p95 < 800ms including attachment metadata (blob streamed separately).
- Approve action (excluding QBO round-trip): p95 < 400ms server-side; QBO round-trip surfaced as streaming status ("Posting to QuickBooks…").
- Dry-run scan is async (pipeline jobs) — UI streams progress ("Scanning Gmail", "Preparing 9 bills"), never a blank spinner.
- Cost: no new paid API in v1 (auth via Google is free; extraction/proof costs are pre-existing pipeline costs).

---

## 9. Security & Compliance

- **Who can do what (RBAC):** Owner/Controller = read + approve→post + send drafts + settings + manage rules. Bookkeeper = read + review + remap + learn-rule + propose (NO post, NO send). CPA = read + evidence/export only.
- **Session security:** httpOnly, Secure, SameSite=Lax cookie; only the sha256 hash stored in `sessions`; expiry (default 12h) + revoke on logout; disabled user → sessions invalid.
- **Tenant isolation:** every query filtered by `session.tenant_id`; cross-tenant returns 404. Row-scope tests mandatory (§10).
- **Secrets:** Google client secret, DB URL, existing service secrets live in env/platform secret store — never in git or spec. Existing logger already redacts `ssk_`, Telegram, bearer tokens; extend redaction to session tokens.
- **Irreversible-action guard:** approve and send both flow through existing guarded paths; UI exposes no bypass, no recipient field, no prod-write toggle.
- **Compliance:** No formal regime applies (sandbox accounting data, no real payments, no PCI). Handles business financial documents → treat as sensitive: least-privilege scopes (guarantee), no PII/bank fields in logs.

---

## 10. Testing Strategy

Tests the loop can actually run (Vitest + Playwright):

**Unit (Vitest):** session token hashing/validation; role→permission matrix (each role × each action route); tenant-scope query builder; digest severity grouping; onboarding step machine.

**Integration (Vitest + real DB):**
- Approve as Owner → exactly one `postings` (mode=sandbox) + one `audit_log` (human actor) + QBO link. Maps to §3 criterion.
- Approve as Bookkeeper → 403, zero postings.
- Cross-tenant read → 404, zero foreign rows.
- Double-approve concurrency → one posting (idempotency).
- Reply send with recipient field → 400; forwarder invoked with no recipient.
- Correction "remember" → `corrections.became_rule=true` + `mappings` upsert applied to next item.
- Onboarding through review → ≥1 proposal, 0 postings.

**Regression — must-not-break (run existing suite unchanged):** `no_prod_write`, `send_lockdown`, `proof_fail_safe`, `gatekeeper_hold`, `proof_gate_posting`, `white_label_install`. Guarantee: `npm test` stays green with UX layer present.

**E2E (Playwright):** login (mock Google) → Today → open exception → view evidence → approve → see Posted + QBO link. Onboarding wizard → dry-run → zero postings assertion via API.

No coverage-percentage theater; every §3 criterion and every must-not-break item maps to a named test above.

---

## 11. Deployment & Rollout

- **Platform:** existing Node backend/workers process stays as-is. Next.js app runs in the same repo; deploy as a Node server (self-host) or Vercel-compatible target.
- **Deploy:** `npm run build` (adds Next build) → start backend process + Next server. Migration `003_ux_auth.sql` runs via existing `npm run migrate:up` (idempotent custom runner) BEFORE serving.
- **Env vars (exact names):** existing set + `GOOGLE_SSO_CLIENT_ID`, `GOOGLE_SSO_CLIENT_SECRET`, `SESSION_COOKIE_SECRET`, `SESSION_TTL_HOURS` (default 12), `WEB_BASE_URL`. Values in platform secret store, never git.
- **Verify live:** `GET /health` → 200; visit `WEB_BASE_URL/login` → Google button; complete login → `/today` renders; run one approve → posting appears in QBO sandbox.
- **Rollback:** revert to previous deploy (platform redeploy of prior build). `003_ux_auth.sql` has a DOWN script (drops new tables only; no pipeline tables touched) — safe because new tables have no inbound FKs from pipeline tables.

---

## 12. API Documentation

```
GET /api/today — Auth: session, any role
200: { digest: {...}, exceptions_count, posted_count, held_count, failed_count, items: [...] } | 401 UNAUTHENTICATED

GET /api/exceptions?status=open — Auth: session, any role
200: { items: [{ id, reason_code, detail, entity_ref, severity, recommended_fix }] } | 401

GET /api/items/{id}/evidence — Auth: session, any role
200: { email:{subject,from,thread_id}, attachment:{filename,sha256}, extracted_fields, confidence, prior_rule, qbo_link } | 401 | 404 NOT_FOUND

POST /api/proposals/{id}/approve — Auth: session, role owner_controller only
Req: {} (actor from session)
201: { posting_id, qbo_type, qbo_id, qbo_link, mode:"sandbox" } | 401 | 403 FORBIDDEN | 409 ALREADY_POSTED | 202 QBO_RETRY

POST /api/proposals/{id}/reject — Auth: owner_controller | bookkeeper
Req: { reason, mark_duplicate?:bool }
200: { status:"rejected" } | 401 | 403

POST /api/mappings/remap — Auth: owner_controller | bookkeeper
Req: { kind, source_key, target_qbo_type, target_qbo_id, remember:bool }
200: { mapping_id, became_rule } | 400 VALIDATION | 401 | 403

POST /api/corrections/learn — Auth: owner_controller | bookkeeper
Req: { proposal_id?, exception_id?, field, new_value, remember:bool }
200: { correction_id, became_rule } | 401 | 403

POST /api/proposals/{id}/retry — Auth: owner_controller
200: { status } | 401 | 403 | 409

POST /api/replies/{id}/send — Auth: owner_controller only
Req: {}  (NO recipient field — locked to gatekeeper forwarder)
200: { forward_id, status } | 400 VALIDATION (if recipient supplied) | 401 | 403

GET /api/audit?entity=... — Auth: any role (read)
200: { events: [{ actor, action, entity, at }] } | 401
```

---

## 13. Database Migrations

Migration file: `migrations/003_ux_auth.sql`. Agent runs it via `npm run migrate:up` (existing idempotent runner); test on a DB branch first; never DROP pipeline tables.

**UP:** create `users`, `sessions`, `notifications`, `onboarding_state` (DDL in §6) + the three indexes.

**DOWN:**
```sql
DROP TABLE IF EXISTS onboarding_state;
DROP TABLE IF EXISTS notifications;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS users;
```
Safe because no existing pipeline table references these (they reference `tenants`, not vice versa).

**Verification query:**
```sql
SELECT to_regclass('public.users'), to_regclass('public.sessions'),
       to_regclass('public.notifications'), to_regclass('public.onboarding_state');
-- all four non-null after UP; all null after DOWN
```

---

## 14. Known Limitations, Open Questions & Future Work

**Limitations:** v1 is desktop web only; single Google-SSO provider; digest is once/day (no per-user cadence); search is filter-based, not natural-language; reconciliation is read-only.

**Open Questions (2):**
1. **User invitation flow** — how does a second user (e.g., the CPA) get added to a tenant: owner-invites-by-email vs. domain-auto-join? Resolution action: owner decides in Settings design review before Phase 6. (Not money/auth-blocking — default: owner invites by email; new user starts `invited`.)
2. **Session TTL + refresh** — 12h fixed expiry vs. sliding refresh. Resolution action: pick during Phase 1 auth build; default to 12h fixed, logout revokes. (Auth-adjacent but has a safe default, so non-blocking.)

**Future work (v2+):** mobile surface, AI coworker, semantic search, month/year/tax gap reports, reconciliation UI, Xero/Outlook.

## Risks
- **Auth-first ordering:** any UI action route shipped before session+RBAC middleware is an ungoverned irreversible action. Mitigation: Phase 1 = auth; no action route merges without the middleware.
- **Thin-client violation:** an agent re-implementing pipeline logic in a route handler creates a second QBO-write/send path. Mitigation: route handlers may only call `src/services/*`; code review + guarantee tests catch bypasses.
- **Audit gaps:** a UX action that forgets to append `audit_log`. Mitigation: the shared approve/reject/remap service writes audit centrally; routes cannot skip it.
- **Cross-tenant leak:** a query missing `tenant_id` scope. Mitigation: a single scoped query helper + mandatory row-scope integration tests.
- **Guarantee regression:** UX changes accidentally touch write.ts/forwarder.ts. Mitigation: those files are out of scope; existing guarantee suite must stay green in CI.

---

## 15. Glossary

- **Proposal:** a prepared, not-yet-posted QBO transaction (`proposals` table).
- **Posting:** a completed QBO sandbox write (`postings` table).
- **Exception:** a first-class item needing a human (`exceptions` table) — "the product."
- **Gatekeeper forward:** the single locked-recipient email send path (guarantee 2).
- **Dry-run:** pipeline runs through propose but never posts.
- **Fix once, learn forever:** a correction that becomes a reusable mapping rule.

---

## 16. Monitoring & Metrics

- **Health:** existing `GET /health` (db + queue). Add `web` readiness on the Next server.
- **Logs:** existing pino logger (redaction extended to session tokens); platform log stream.
- **Alerts:** one email/webhook alert on `risk_alert` notifications and on QBO posting error-rate spike (simple threshold). No Grafana/PagerDuty.
- **Success-metric query:** count postings with source attachment / total postings; exceptions cleared per day; onboarding→first-approve time.

---

## 17. Alternative Designs Considered

1. **Separate Node API + standalone React SPA** — rejected: two deploy targets and more glue for a solo operator; Next.js same-repo API routes cover it with one deploy. (Packet Blocking Decision 2.)
2. **Server-rendered HTMX** — rejected: cannot hit the keyboard-fast, Superhuman-speed triage the North Star demands.
3. **UI writes directly to QBO/DB for speed** — rejected outright: violates guarantees 1/3 and the thin-client rule; all writes go through existing services.

---

## 18. Build Phases & Final Checklist

### Build Phases
1. **Auth foundation** — `003_ux_auth.sql`; Google SSO login; session middleware (authn + role + tenant scope); logout/revoke. Verifiable: unauth→401, login works, session scoped. *(Everything depends on this; no action routes before it.)*
2. **Shared service layer** — extract approve/reject/remap/learn/reply from CLI/pipeline into `src/services/*` that route handlers call. Verifiable: CLI still works via the same functions; unit tests pass.
3. **Read API + Evidence** — `today`, `exceptions`, `transactions`, `items/:id/evidence`, `audit`, `notifications`. Verifiable: counts match DB; evidence returns full chain; all tenant-scoped.
4. **Action API** — approve/reject/remap/learn/retry/reply, each gated by role, each writing audit_log, each calling only existing guarded paths. Verifiable: §3 criteria + regression suite green.
5. **Frontend shell + core pages** — Today, Exceptions (keyboard triage), Transactions (list/detail), Evidence panel component, Settings, Audit Trail. Verifiable: Playwright login→approve flow.
6. **Onboarding dry-run** — wizard, discover-before-asking, dry-run scan, sample review, enable auto-post. Verifiable: 0 postings during setup.
7. **Daily digest** — notification generation (reuse severity), Today digest render, risk alert. Verifiable: one batch/day; risk alerts immediate.

### Build Checklist
- [ ] `003_ux_auth.sql` UP/DOWN + verification query pass on a DB branch
- [ ] Session middleware gates every `/api/*` route
- [ ] Role matrix enforced and unit-tested
- [ ] Every action route writes `audit_log` via shared service
- [ ] Every query tenant-scoped; cross-tenant test green
- [ ] Existing guarantee suite green (`npm run lint && npm run typecheck && npm test`)
- [ ] Playwright E2E: login→exception→evidence→approve→posted
- [ ] Onboarding zero-posting assertion green
- [ ] Deployed: `/health` 200, `/login` renders, one live sandbox approve verified

### AI Agent Execution Contract
The building agent must:
- [ ] Read the full spec + Architecture Grounding Summary before writing code
- [ ] Produce a plan/file-tree first — not code
- [ ] Test every "must not break" item before marking any phase complete
- [ ] Treat the Definition of Done as the ONLY completion signal
- [ ] Stop and escalate if a must-not-break guarantee is at risk — never ship around it
- [ ] Attach a concrete artifact per done condition (test output, HTTP log, DB row)
- [ ] Never mark done on local-only verification — deployed-environment proof required
