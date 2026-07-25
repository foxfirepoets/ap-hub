# Architecture Decision Packet
## System: AP-hub North Star UX Layer
## Date: 2026-07-14
## Verdict: NEEDS_ARCHITECTURE_DECISION
## Confidence: HIGH — the backend pipeline is fully readable and the North Star docs are explicit; the gaps are decisions not yet made, not facts not yet known.

> Governance target: `NorthStarUX.md` + `AP-hub_North_Star_UX_Sheet.xlsx` (8 sheets: Manifesto, UX Principles, Workflows, Status Model, Acceptance Criteria, Review Checklist, Metrics, Anti-Patterns), governed against the existing `ap-hub` codebase (CHUNK_1–8 backend pipeline).
>
> **Mode: EXTENSION.** A complete headless backend exists. The North Star docs specify a **human-facing product/UX layer that does not exist yet** (no UI, no read/action API, no human-user identity). This packet governs building that layer on top of the pipeline without breaking the six guarantees.

---

## 1. System Summary

AP-hub is an AI accounting hub: it reads accounting email from Gmail, proof-gates it through SwarmSync, and produces reviewable QuickBooks Online (QBO **sandbox**) transactions. The **backend pipeline is built** (`poll → gatekeep → classify → extract → map → propose → post_sandbox` + `audit_anchor`, wired through pg-boss, with a full Postgres schema). What does **not** exist is everything the North Star UX describes: the human product surface — onboarding wizard, the 9 nav areas (Today, Inbox, Transactions, Exceptions, Mappings, Reconciliation, Reports, Settings, Audit Trail), daily digest, exception queue, evidence panels, AI coworker, search, approval-by-exception, notifications, mobile, accessibility.

Users are four personas: Business Owner, Controller, Bookkeeper, CPA (plus the Implementer). This governance session covers **the UX/interaction layer and the read/action API it requires** — not changes to the accounting pipeline itself, which is treated as a stable dependency. The central design law of the docs: *"Exceptions are the product"* — the UI's primary job is to surface only what needs a human, with evidence and a one-click fix.

`[ASSUMPTION: the North Star docs are a product-philosophy + acceptance-standard spec, not a request to rebuild the pipeline. The pipeline stays; the UX is the new build.]`

---

## 2. Current-System Map

| Component | Type | Status | Notes |
|---|---|---|---|
| pg-boss pipeline (`src/pipeline/*`) | Jobs | Live | `poll → gatekeep → classify → extract → map → propose → post_sandbox` + daily `audit_anchor` |
| Postgres schema (`migrations/001,002`) | DB | Live | tenants, oauth_tokens, messages, attachments, extractions, mappings, proposals, postings, reconciliation, exceptions, audit_log, corrections, llm_calls, proof_refs, forwards |
| `src/qbo/write.ts` | Service | Live | ONLY QBO write path; sandbox-hard-refused otherwise |
| `src/qbo/client.ts` | Service | Live | QBO READ only — no create/update/delete |
| `src/gatekeeper/forwarder.ts` | Service | Live | Locked single-recipient forward; no recipient param |
| `src/swarmsync/*` | Service | Live | Proof client, severity classifier, proof_refs |
| `src/auth/*` (gmail/qbo oauth, tokens, routes) | Service | Live | **Service** OAuth only (Gmail + QBO connections). No human login. |
| `src/http.ts` | API | Live | `/health` + OAuth callbacks. No framework, no read/action API. |
| `src/cli.ts` | CLI | Live | Operator CLI (env, proposals, gatekeeper) — the ONLY current human surface |
| `v_proposal_review` (SQL view) | DB view | Live | The only human-readable review surface today |
| **Human web/mobile UI** | UI | **NONE** | Does not exist |
| **Read/action API (Today/Inbox/Exceptions/etc.)** | API | **NONE** | Does not exist |
| **Human user identity / session / RBAC** | Auth | **NONE** | No `users` table; multi-tenant but not multi-user-per-tenant |
| **Notification system** | Service | **PARTIAL** | Only Telegram gatekeeper alerts exist; no digest/email/leadership summary |

---

## 3. Target Architecture

The UX layer is a **new read/action API + frontend** that sits on top of the existing DB and pipeline. It does **not** get its own copy of accounting state — it reads the pipeline's tables and issues **commands** (approve, reject, remap, learn-rule, send-draft, retry) that flow back into the existing pipeline stages and safeguards.

| Concern | Current (before) | Target (after) |
|---|---|---|
| Human surface | CLI + one SQL view | Web app (9 nav areas), mobile-lite, daily digest |
| Read access | Direct DB / CLI | Read API over existing tables (Today feed, exception queue, evidence, search) |
| Human actions | CLI commands | Action API → routes commands into existing pipeline (approve → post_sandbox; correction → mappings/corrections; reply → gatekeeper draft) |
| Human identity | None | `users` + `sessions` + role model, scoped to `tenant_id` |
| Notifications | Telegram (gatekeeper) | Digest engine (daily/weekly/close-gap) + immediate-risk alerts, reusing severity |
| Trust surface | `v_proposal_review` | Evidence panel per item (email, PDF page, extracted fields, QBO link, prior rule, confidence, reasoning) |

**Boundary rule (load-bearing):** the UX layer is a *client* of the pipeline. Every irreversible effect (QBO write, email send) continues to pass through `src/qbo/write.ts` and `src/gatekeeper/forwarder.ts` and their existing guards. The UI never gets a second, direct path to QBO or Gmail-send.

---

## 4. Domain Entities

Existing pipeline entities (already in schema) that the UX **reads**:

| Entity | Key fields | Status field? | Owner (writer) |
|---|---|---|---|
| tenant | id, name, gmail_email, qbo_realm_id, paused | no | onboarding/config |
| message | gmail_message_id, thread_id, doc_type, direction, status | yes | poll/ingest |
| attachment | sha256 (unique), storage_key, is_duplicate | no | ingest |
| extraction | fields (jsonb), confidence, missing_fields, flags | no | extract |
| mapping | kind, source_key, target_qbo_id, confidence, learned_from | no | mapping/corrections |
| proposal | proposed_txn, idempotency_key, confidence, status, flags | yes | propose |
| posting | qbo_id, idempotency_key, mode, status, request/response | yes | post_sandbox (write.ts) |
| reconciliation | kind, left_ref, right_ref, match_status | via match_status | recon |
| exception | reason_code, detail, status, resolution | yes | any stage |
| correction | field, old/new value, became_rule | no | UX action (learn-forever) |
| audit_log | actor, action, entity, before/after_hash | no | all stages |
| proof_ref | entity_kind, product, verdict, chain_hash | via verdict | swarmsync |
| forward | sha256, status, hold_reason, subject_tag | yes | gatekeeper |

New entities the UX layer **must add** (all `[PROPOSED — confirm before building]`):

| Entity | Key fields | Status field? | Owner |
|---|---|---|---|
| user `[PROPOSED]` | id, tenant_id, email, name, role, auth_provider | active/invited/disabled | auth layer |
| session `[PROPOSED]` | id, user_id, token_hash, expires_at | valid/expired/revoked | auth layer |
| notification `[PROPOSED]` | id, tenant_id, user_id, kind, severity, read_at, digest_batch | unread/read/digested | digest engine |
| saved_view / search_query `[PROPOSED]` | id, tenant_id, user_id, query, filters | — | UX (search) |
| onboarding_state `[PROPOSED]` | tenant_id, step, dry_run_complete, automation_level | per-step | onboarding |

`[G2 note: every table in the current schema appears above. New entities are the gap the UX layer creates.]`

---

## 5. Source-of-Truth Matrix

| Entity | SoT Location | Writers | Readers | Conflict Resolution | Risk |
|---|---|---|---|---|---|
| Accounting objects (bills, vendors, accounts…) | **QBO (sandbox)** | `qbo/write.ts` only | UX (via read API), pipeline | QBO wins; local is a projection | LOW — already enforced by guarantee 1/3 |
| Processing state (message→posting lifecycle) | **Local Postgres** | pipeline stages | UX read API | Local DB is authoritative for *pipeline* state | LOW — single writer per stage |
| Mapping rules | **Local `mappings`** | mapping stage + UX corrections | pipeline, UX | `UNIQUE(tenant,kind,source_key)`; last approved wins | MED — UX + pipeline both write; needs write-through the same path |
| Exceptions | **Local `exceptions`** | any stage + UX resolve | UX | status transitions only forward | LOW |
| Audit trail | **Local `audit_log`** (append-only) | all stages + UX actions | UX, audit anchor | append-only; never mutated | MED — UX actions MUST write audit rows or trail has gaps |
| Human identity `[PROPOSED]` | **New `users` table** | auth layer | all | single writer | **HIGH — does not exist yet; blocking** |
| Forward decisions | **Local `forwards`** | gatekeeper | UX | `UNIQUE(tenant,sha256)` | LOW |

**No competing-writer conflict on core accounting data** — QBO is unambiguously SoT and only `write.ts` touches it. The one real SoT concern the UX introduces: mapping-rule writes and audit writes must go **through the pipeline's existing write paths**, not a parallel UI-only path, or the "fix once / learn forever" loop and the audit trail split-brain.

---

## 6. State Machines

**Pipeline item status** (from `messages`/Status Model sheet — the spine of the UX):

| State | Transitions To | Triggered By | Irreversible? | Notes |
|---|---|---|---|---|
| Received | Classified | poll | no | detail view only |
| Classified | Attachment saved / Extracted | classify | no | |
| Attachment saved | Extracted | ingest | no | hashed + linked |
| Extracted | Mapped / Exception | extract | no | confidence + missing_fields |
| Mapped | Ready to post / Exception | mapping | no | |
| Ready to post | Posted / Exception | auto-threshold **or human Approve** | no (pre-write) | **UX approval enters here** |
| Posted | Synced | `qbo/write.ts` | **YES — QBO write** | idempotency-protected |
| Synced | Reconciled | recon | no | |
| Reconciled | (terminal-ish) | recon | no | close item |
| Exception | any prior / Rejected | user/system fix | no | the action queue |
| Duplicate | Rejected / Confirmed | dedup | no | |
| Rejected | Archived | user/system | soft | learn option |

**proposal.status:** `review → ready → posted_sandbox` / `→ exception` / `→ rejected`.
**forward.status:** `pending → scanning → held/released → forwarding → forwarded/failed`.
**user `[PROPOSED]`:** `invited → active → disabled`. **session `[PROPOSED]`:** `valid → expired/revoked`.

The single irreversible transition the UX can trigger is **Ready → Posted** (QBO write) and the gatekeeper **release → forward** (email send). Both already have safeguards; the UX must not add a bypass.

---

## 7. Critical Workflows

1. **First-run onboarding (dry-run).** Trigger: new tenant. Steps: connect Gmail → connect QBO → select company → mode/date range → automation level → **dry-run scan** → review sample findings → approve initial mapping rules → enable auto-post by confidence. System: imports QBO objects, scans Gmail, classifies, builds candidate mappings, prepares proposals **without posting**. Output: business-specific summary ("found 312 emails, 143 invoices, 96 vendors matched…"). Error path: setup blockers grouped by exact fix (Gmail scope denied, QBO company not selected).
2. **Daily operations (exception-driven).** Trigger: poll cycle. Happy path: routine items auto-flow; user sees a digest + exception queue only. Error path: SwarmSync outage → items go to review/hold, never fail-open (guarantee 5).
3. **Exception review + fix-once-learn-forever.** Trigger: item enters Exception. Steps: plain-English issue → evidence → recommended fix → one-click action → "handle this way next time?" → correction becomes a mapping rule. Output: exception cleared + optional rule. Error path: unresolvable → stays queued with owner.
4. **Approve → post.** Trigger: human approves a Ready item. Steps: UI action → action API → existing propose/post_sandbox path → `qbo/write.ts` (sandbox) → attach source → QBO link returned. Error path: QBO validation/API failure → safe retry or exception with plain-English reason.
5. **Evidence lookup (trust).** Trigger: user opens any item. Output: source email, PDF page/region, extracted fields, prior rule, confidence, reasoning, QBO link. Never "AI says so."
6. **Draft/send vendor reply.** Trigger: missing W-9 / invoice number. Steps: AI drafts → **stays draft by default** → human approves send → gatekeeper forwarder (locked recipient). Error path: sensitive/high-risk reply cannot auto-send (guarantee 2).
7. **Month-end / tax gap report.** Trigger: close. Output: evidence-based close-gap report (missing source docs, unmatched payments, duplicates, 1099/W-9 gaps) — not a generic checklist. Error path: n/a (read-only report).

---

## 8. Integration Boundaries

| Integration | Direction | Auth Method | What We Send | What We Receive | Failure Mode | Cost/Limit |
|---|---|---|---|---|---|---|
| Gmail | inbound + draft/send | OAuth (service) | draft/forward (locked recipient) | messages, attachments | poll fails → items stall (not lost) | Gmail API quota |
| QBO (sandbox) | read + write | OAuth (service) | bills/expenses/etc. via `write.ts` | objects, sync tokens | API failure → safe retry / exception | QBO sandbox rate limits |
| SwarmSync | outbound | API key `[SECRET — see .env]` | proof requests | verdict, chain_hash | outage → review/hold (fail-safe) | proof-suite cost |
| Telegram | outbound | bot token `[SECRET — see .env]` | gatekeeper alerts | — | send fail → logged | — |
| Anthropic (vision) | outbound | API key `[SECRET — see .env]` | doc images/text | extracted fields | fail → extraction exception | per-call cost |
| **UX read/action API** `[PROPOSED]` | inbound (browser) | **UNDECIDED — human session** | commands | feed/evidence/queue | **auth gap if unbuilt** | — |
| **Notification/digest** `[PROPOSED]` | outbound | reuse channels | digest/alerts | — | miss → user unaware | — |

Contract owner for all pipeline↔external boundaries: existing adapters. The UX layer owns **one new contract** — the browser↔read/action API — and that contract's auth is currently undefined.

---

## 9. Money / Auth / Proof Boundaries

### MONEY

| Location | Action | Trigger | Guard Condition | Idempotent? | Audit Log? |
|---|---|---|---|---|---|
| `src/qbo/write.ts` | create bill/expense/invoice/payment/deposit | auto-threshold OR **UX approve** | `QBO_ENV=sandbox` hard-refuse else; mapping validation; dry-run default | Yes — `UNIQUE(tenant,idempotency_key)` + replay-adopt | Yes — `postings` + `audit_log` |
| `src/gatekeeper/forwarder.ts` | forward email (send) | gatekeeper release | single locked recipient, no recipient param; `UNIQUE(tenant,sha256)` | Yes — subject-tag replay | Yes — `forwards` + `audit_log` |

No real-money movement anywhere (QBO sandbox only; no Stripe/billing). The "money boundary" here is **accounting-record integrity**, not payment. The UX layer must not create a second write path — it calls the same guarded function.

### AUTH

| Check Point | Token Type | Validates | Failure Behavior | Rate Limited? |
|---|---|---|---|---|
| Gmail/QBO OAuth callbacks (`auth/routes.ts`) | OAuth service token (encrypted) | service connection | connection error | — |
| **Human UI session** `[PROPOSED — DOES NOT EXIST]` | **UNDECIDED** | who the human is; which tenant; which role | **currently: nothing — no gate** | **UNDECIDED** |
| **Role/permission gate on approve/send** `[PROPOSED]` | session claim | can this persona post/send? | **currently: none** | — |

**This is the central gap.** Today the only human surface is a local CLI (implicitly trusted, operator-run). The North Star introduces a networked UI whose users can approve QBO postings and trigger sends. There is **no human authentication, session, or RBAC model**. Building the approve/send UI before deciding this = an auth gap on the system's irreversible actions.

### PROOF

| Proof Type | Generated At | Storage Location | User-Visible? | Tamper-Proof? |
|---|---|---|---|---|
| SwarmSync proof (verify/invoice/audit) | pipeline stages | `proof_refs` (chain_hash) | must be, in evidence panel | chain-hashed |
| Source-doc evidence (email+PDF+fields) | ingest/extract | attachments + extractions | **UX must surface** | sha256 |
| Audit trail | every action | `audit_log` (append-only, before/after hash) | Audit Trail nav area | hash-chained via daily anchor |
| Daily audit anchor | `pipeline/audit-anchor.ts` | audit_log | Reports | anchored |

Proof infrastructure **already exists**; the UX layer's job is to *display* it (evidence panel, audit trail view), not generate new proof. Guarantee 5 (nothing unscanned gets through) already covers proof-gating; the UX must not offer an action that bypasses it.

---

## 10. Data Flow

Core "approve an invoice" flow through the system:

1. **poll** reads Gmail → writes `messages` (status Received). Read: oauth_tokens. External: Gmail.
2. **gatekeep** → `forwards`; SwarmSync severity check. External: SwarmSync.
3. **classify/extract** → `extractions` (fields, confidence). External: Anthropic vision.
4. **map** → `mappings` lookup → `proposals` (status review/ready). Read: mappings, QBO read client.
5. **UX read API** serves the item to Today/Exceptions with full evidence (email, PDF, fields, rule, confidence).
6. **Human approve** (UX action API) → routes to post_sandbox → **`qbo/write.ts`** (sandbox guard, idempotency). Write: `postings`, `audit_log`. External: QBO write.
7. **recon** later → `reconciliation`. **audit-anchor** daily hashes `audit_log`.

Failure points: Gmail quota (step 1, stall), SwarmSync outage (step 2, hold/review), extraction fail (step 3, exception), mapping miss (step 4, exception), **missing human auth (step 6, currently ungated)**, QBO API fail (step 6, safe retry).

---

## 11. Failure Modes (technical / operational)

| Scenario | Trigger | System State After | Detectable? | Recoverable? | Mitigation |
|---|---|---|---|---|---|
| UI issues approve, human not authenticated | no session model | posting created by unknown actor | audit_log actor='system'/blank | yes | **Build auth before approve UI (blocking)** |
| UX writes mapping via a UI-only path | parallel write path | mapping split-brain vs pipeline | via `UNIQUE` conflict | partial | Route all writes through existing mapping/corrections path |
| UX action skips `audit_log` | dev omission | audit trail gap on human decision | reconciliation of counts | no (gap permanent) | Wrap every action API call in the same audit writer stages use |
| Double-approve (double-click / retry) | UI retry | duplicate posting attempt | idempotency_key conflict | yes | Reuse existing `UNIQUE(tenant,idempotency_key)` + replay-adopt |
| UI offers "send reply" to arbitrary address | new UI field | send outside locked recipient | code review | n/a | Forwarder has no recipient param — keep it; UI cannot pass one (guarantee 2) |
| UI exposes a direct QBO write | new adapter | write bypasses sandbox guard | code review / `no_prod_write` test | n/a | UI calls `write.ts` only; test guarantee 3 |
| Digest engine misses a material risk | severity misclassification | user unaware of held item | queue count vs digest | yes | Digest derives from same `exceptions`/severity source, never a separate list |
| Session token leak | XSS / logging | account takeover | — | partial | httpOnly cookies, redact tokens (logger already redacts `ssk_`/bearer) |
| Read API leaks another tenant's data | missing tenant scope | cross-tenant disclosure | test | no | Every query filtered by session `tenant_id`; add row-scope tests |

---

## 12. Duplicate / Sprawl Analysis

| Redundancy Found | Type | Risk Level | Recommendation |
|---|---|---|---|
| `v_proposal_review` view vs. new read API | code | LOW | REUSE the view as the read API's proposal-review query; don't hand-roll a second join |
| CLI proposal/gatekeeper commands vs. UI actions | code | MEDIUM | Both call the SAME service functions; UI must not re-implement pipeline logic — extract shared service layer if needed |
| Telegram alerts vs. new digest engine | integration | MEDIUM | MERGE under one notification/severity source; digest reuses gatekeeper severity, doesn't fork it |
| Mapping write from UX vs. mapping pipeline stage | data | HIGH | Single write path only; UX correction → existing `corrections`/`mappings` flow |
| No frontend today | — | n/a | Greenfield — no UI sprawl to clean (clean slate) |

No CRITICAL duplicate. No competing accounting-data writers. The sprawl risk is *future*: the UX layer re-implementing pipeline logic instead of calling it. Governance rule: **UX is a thin client of existing services.**

---

## 13. Build / Reuse / Delete Decisions

| Component | Decision | Rationale | Priority | Dependencies |
|---|---|---|---|---|
| Existing pipeline + `write.ts` + forwarder | REUSE AS-IS | Guarantees live here; do not touch | — | — |
| `v_proposal_review` | REUSE AS-IS | Ready-made review surface | High | — |
| Human auth (users/sessions/RBAC) | **BUILD NEW** | Prerequisite for any networked approve/send UI | **Critical (blocking)** | schema migration |
| Read API (Today/Inbox/Exceptions/Transactions/Search/Audit) | BUILD NEW | No read API exists | High | auth |
| Action API (approve/reject/remap/learn/send/retry) | BUILD NEW | Routes commands into pipeline | High | auth, service layer |
| Shared service layer (extract from CLI/pipeline) | REUSE WITH CHANGES | So UI + CLI + pipeline share one code path | High | — |
| Frontend app (9 nav areas, evidence panel, digest) | BUILD NEW | Core deliverable | High | read/action API |
| Notification/digest engine | BUILD NEW (reuse severity) | Only Telegram exists | Medium | severity classifier |
| Mobile-lite surface | BUILD NEW (later slice) | Approve/evidence/receipt-capture only | Low | frontend, API |
| AI coworker / semantic search | BUILD NEW (later slice) | High value, high complexity | Low | read API, evidence |
| `qbo/write.ts`, `gatekeeper/forwarder.ts` | LEAVE ALONE | Guarantee-bearing; changing them risks 1/2/3 | — | — |

---

## 14. Non-Scope

- We are **not** rebuilding the accounting pipeline, because CHUNK_1–8 already implement it and the guarantees depend on it.
- We are **not** adding QBO production write, because guarantee 3 hard-refuses non-sandbox and config refuses `production`.
- We are **not** adding new email-send capability, because guarantee 2 locks sending to the single gatekeeper forward.
- We are **not** modifying Gmail, because guarantee 1 forbids it.
- We are **not** building Xero/Outlook integrations now, because North Star lists them as later-phase.
- We are **not** shipping mobile, AI-coworker, or semantic search in v1, because they depend on the read API and evidence surface existing first (deferred slice).
- We are **not** replacing QBO as system of record, because North Star §9.2 mandates QBO stays the ledger.
- We are **not** touching `write.ts` or `forwarder.ts` internals, because they carry guarantees 1/2/3.

---

## 15. Risk Register (strategic)

| Risk | Likelihood | Impact | Mitigation | Owner |
|---|---|---|---|---|
| **(G9 top risk) UI ships approve/send before a human auth+RBAC model → ungoverned irreversible actions** | HIGH | HIGH | Build users/sessions/RBAC as the FIRST slice; gate every action route by session+role before any approve/send UI | Architect |
| UX re-implements pipeline logic → split-brain / broken guarantees | MED | HIGH | Thin-client rule: UI calls existing services; extract shared service layer | Architect |
| Scope sprawl — trying to build all 9 areas + mobile + AI at once | HIGH | MED | Slice to v1 (Today, Exceptions, Transactions, Evidence, Onboarding dry-run); defer rest | PM |
| Human action bypasses audit_log → trail gaps | MED | HIGH | Every action API call writes audit_log via the same writer | Backend |
| Cross-tenant data leak in read API | MED | HIGH | Mandatory `tenant_id` scope + row-scope tests on every query | Backend |
| Frontend stack choice mismatched to solo-operator build | MED | MED | Pick one opinionated stack (see Blocking Decision 2) and stick to it | Architect |

`[G7 CHECK: 1 risk is Likelihood=HIGH AND Impact=HIGH (the auth-gap G9 risk). Its mitigation is listed, so it is a mitigated risk, not an unresolved CRITICAL — but because the mitigation ("build auth first") is a prerequisite decision not yet made, the verdict is NEEDS_ARCHITECTURE_DECISION and this appears as Blocking Decision 1 in Section 20.]`

---

## 16. Definition of Done

The North Star UX layer v1 is done when all are true and independently checkable:

1. A human can authenticate, gets a session scoped to exactly one `tenant_id`, and every read/action query is filtered by it (test: user A cannot read user B's tenant data).
2. Every action route (approve/reject/remap/learn/send/retry) rejects unauthenticated and unauthorized calls (test: role matrix).
3. Approving a Ready item posts through `qbo/write.ts` only, in sandbox, idempotently, and writes both `postings` and `audit_log` (test: `no_prod_write`, `proof_gate_posting`, audit row present).
4. No action route can send email to any address other than the locked gatekeeper recipient (test: `send_lockdown` still passes; UI exposes no recipient field).
5. The Today view and Exception queue render only from `exceptions`/pipeline status — same source as the pipeline (test: counts match `SELECT` on the tables).
6. Every item's evidence panel shows source email, attachment, extracted fields, confidence, prior rule (if any), and QBO link when posted (acceptance: North Star §16 checklist yes on all).
7. First-run is dry-run by default: no QBO write occurs during onboarding until automation is explicitly enabled (test: onboarding produces proposals, zero postings).
8. A correction can become a mapping rule through the existing `corrections`/`mappings` path, and the next matching item uses it (test: fix-once-learn-forever).
9. All six existing guarantees still pass (`npm run lint && npm run typecheck && npm test`), unchanged.
10. No new direct QBO-write or Gmail-send path exists outside `write.ts`/`forwarder.ts` (test: grep + guarantee tests).

---

## 17. Handoff to Spec-Superstar

**Confirmed scope (v1 slice):** the human product surface over the existing pipeline, limited to: **(a)** human auth + session + role model; **(b)** read API for Today, Exceptions, Transactions, and item Evidence; **(c)** action API for approve / reject / remap / learn-rule / retry (send stays draft-only via existing forwarder); **(d)** onboarding wizard with dry-run-by-default; **(e)** daily digest (reusing severity).

**Entities to spec:** `user`, `session`, `notification`, `onboarding_state` (new); read-projections over `messages`, `proposals`, `postings`, `exceptions`, `mappings`, `extractions`, `attachments`, `proof_refs`, `audit_log`.

**Workflows to spec:** onboarding dry-run (§7.1), daily exception review (§7.2/7.3), approve→post (§7.4), evidence lookup (§7.5), fix-once-learn-forever (§7.3).

**Constraints to preserve (non-negotiable):** the six guarantees; UX is a thin client calling existing services; single QBO-write path (`write.ts`, sandbox); single send path (`forwarder.ts`, locked recipient); every action writes `audit_log`; every query scoped by `tenant_id`; white-label config-only (no tenant-specific values in code).

**Explicitly out of scope for v1:** mobile, AI coworker/chat, semantic search, month/year/tax gap reports, Xero/Outlook, reconciliation UI beyond read, notifications beyond daily digest. (Spec these as v2+ milestones, not v1.)

**Blocking inputs spec-superstar needs from the user first:** auth model, frontend stack, and confirmation of the v1 slice (see Section 20).

---

## 18. Handoff to O2O

Build order (dependency-correct):

1. **Auth foundation** (users/sessions/RBAC migration + session middleware) — everything depends on it; no parallel work until schema lands.
2. **Shared service layer** — extract approve/reject/remap/learn from CLI/pipeline so UI + CLI share one path. (Parallel-safe with #3 read models once schema exists.)
3. **Read API** (Today, Exceptions, Transactions, Evidence) — depends on auth. Parallel with #4.
4. **Action API** (approve/reject/remap/learn/retry) — depends on auth + shared service layer.
5. **Frontend shell + nav + evidence panel** — depends on read API.
6. **Onboarding dry-run flow** — depends on read+action API.
7. **Daily digest** — depends on severity + notification entity. Parallelizable late.

**Circular-dependency note:** frontend needs the API, and the API's action contract is validated by the frontend's needs. Break the cycle by building the **action API against the DoD test matrix (Section 16) first with a stubbed UI caller**, then build the real frontend against the now-frozen API contract.

**Risky steps needing human review:** the auth model migration; the approve→post route (touches the QBO-write boundary); any change near `write.ts`/`forwarder.ts`.

---

## 19. Handoff to QA / Audit

**Critical paths to test end-to-end:** authenticate → view Today → open exception → approve → verify sandbox posting + audit row + QBO link.

**Integration scenarios:** SwarmSync outage during review (must hold, not fail-open); QBO API failure on approve (safe retry/exception); double-approve (idempotency holds); Gmail draft reply (stays draft).

**Irreversible actions that MUST be gated by a test:** approve→QBO write (guarantee 3 `no_prod_write`, proof-gate posting, sandbox-only, idempotency); any send (guarantee 2 `send_lockdown`, locked recipient).

**Money/auth/proof flows needing e2e proof:** cross-tenant isolation (user A ≠ user B data); role matrix (bookkeeper vs owner action permissions); every human action produces an `audit_log` row with a real actor; evidence panel shows the real source chain; first-run performs zero postings.

**Regression gate:** the existing six-guarantee suite must remain green with the UX layer present.

---

## 20. Final Architecture Verdict

### VERDICT: NEEDS_ARCHITECTURE_DECISION

The backend is sound and the North Star is a strong, coherent product vision — but three prerequisite architecture decisions must be made before a build-ready spec can be written. The UX layer introduces a **networked human surface that can approve QBO postings and trigger sends**, and the system today has **no human identity, session, or role model** — only service OAuth and a trusted local CLI. Specifying the approve/send UI before that model is decided would produce an internally-consistent spec that is architecturally unsafe. The scope is also a philosophy document spanning far more than one solo-operator build can absorb at once, so a v1 slice must be confirmed.

The good news: source-of-truth is clean (QBO = ledger, local DB = pipeline state), the guarantees are well-isolated, and the UX can be a thin client of existing services. Once the three decisions below are made, this flips to READY_FOR_SPEC with the Section 17 handoff.

### BLOCKING DECISIONS

1. **Human authentication + session + RBAC model.** How do the four personas (Owner, Controller, Bookkeeper, CPA) authenticate, and which roles may approve postings vs. only review? (No `users` table exists; multi-tenant schema has no multi-user-per-tenant concept.) This must be built as the first slice.
2. **Frontend + API stack.** The repo is Node 20 / TypeScript ESM backend with a no-framework HTTP server. What stack serves the UI and the read/action API (e.g., same-repo Node API + React SPA, or a full-stack framework)? This determines the entire build shape.
3. **v1 scope slice confirmation.** Confirm v1 = auth + Today + Exceptions + Transactions + Evidence panel + Onboarding dry-run + daily digest, deferring mobile, AI coworker, semantic search, and month/year/tax reports to v2+.

### RESOLUTION (2026-07-14) — Blocking decisions answered → VERDICT UPGRADED TO READY_FOR_SPEC

1. **Auth:** Google SSO + 3 roles. Owner/Controller = approve→post, send drafts, settings; Bookkeeper = review/remap/learn-rule/propose (no post); CPA = read + evidence/export only. Every session scoped to one `tenant_id`. Reuses existing Google OAuth infra.
2. **Stack:** Next.js (App Router) + React + TypeScript in the same repo. API routes serve read/action and call the existing pipeline services (thin-client rule preserved).
3. **v1 scope:** Auth + Today + Exceptions + Transactions + Evidence panel + Onboarding dry-run + daily digest. Deferred to v2+: mobile, AI coworker, semantic search, month/year/tax gap reports, reconciliation UI, Xero/Outlook.

With these decided, all Section 20 blockers are cleared and the Section 16 Definition of Done is achievable. **Verdict: READY_FOR_SPEC.** Proceed to spec-superstar with the Section 17 handoff + the three resolutions above.

---
*Generated by system-architecture-governor. Secrets referenced as `[SECRET — see .env]` only. Verdict upgraded NEEDS_ARCHITECTURE_DECISION → READY_FOR_SPEC after blocking decisions resolved 2026-07-14.*
