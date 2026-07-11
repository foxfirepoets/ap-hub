# Phase 2 Spec — AI Accountant Hub: Controlled Posting (QBO Sandbox)

**automation-spec-grandmaster output · 2026-07-09 · for Ben Stone**
**Scope: take Phase 1 proposals → create real QBO transactions in a SANDBOX company only, idempotently, with source-doc attachment and read-back verification. NO production writes.**
Companion to `brainstorm-output.md` + `phase1-spec.md` (same folder). Delta-focused; inherits everything in Phase 1 unless overridden.

---

## ⚠️ QBO reality that shapes this whole spec (read first)

**QuickBooks Online has no "draft" status for Bills, Expenses, or Invoices in the Accounting API.** When you `POST` a Bill, it is a *live, posted* Bill that immediately affects AP and the general ledger. There is no unsent/draft/pending limbo for these entities (only Estimates have a `Pending` status; POs are non-posting). `[verify against current Intuit docs before relying — this is a known-stable behavior but Intuit evolves the API]`

Therefore "draft-first / controlled posting" does **not** mean "create a QBO draft." It means the two real controls this phase implements:

1. **Environment control** — Phase 2 writes go to a **QBO sandbox (disposable test) company only.** Real create calls, throwaway realm, zero risk to real books.
2. **Approve-before-create** — the reviewable object *is* the Phase 1 proposal. A transaction is only created *after* it clears the confidence gate (and, in Phase 3, human approval). Once created it's live; the reversal path is **void/delete** (per-entity, audited), not "discard a draft."

Everything below assumes this. Production writes + human approval-by-exception are **Phase 3**.

---

## A. Automation Name

**AP-Hub Phase 2 — Controlled Sandbox Poster** (`ap-hub`, `--env sandbox`)

## B. Plain-English summary

Phase 1 read the mail and wrote down what it *would* enter into QuickBooks. Phase 2 takes the entries it was most confident about and actually creates them — but only in a **practice copy of QuickBooks (a sandbox)**, never the real books. It creates the bill, attaches the original PDF to it, then reads it back to confirm it landed correctly, and records the QuickBooks ID so the same invoice can never be entered twice. If anything looks off, it stops and logs it instead of guessing. The purpose is to prove the *whole* path — read → map → create → verify → don't-duplicate — works end to end on a company where mistakes cost nothing, before Phase 3 ever touches real books.

## C. Current manual workflow (baseline)

Same bottleneck as Phase 1 (§C there). The step Phase 2 newly automates is **step 7 — keying the bill into QuickBooks and attaching the PDF** — but against sandbox, to validate correctness. Baseline for *this* step: ~1–2 min/doc of manual keying + attach `[assumed SMB-typical — verify]`. Phase 2's ROI is still *validation*, not hours saved (real hours land in Phase 3).

## D. Future automated workflow (Phase 2 delta)

Inherits Phase 1 steps 1–7 (poll→classify→hash→extract→map→propose). New:

8. **Gate:** select proposals with `status = ready` and `confidence ≥ auto_threshold`, no blocking flags (`duplicate`, `total_mismatch`, `bank_change_warning`, `unknown_vendor`, `unmapped_*`), **and (Amendment A1-P2.1) both SwarmSync proof refs present with no unresolved critical/high finding and no open `proof_scan_unavailable` exception.**
9. **Pre-create dedup:** check `postings.idempotency_key` (= attachment sha256); AND query QBO for an existing txn matching (vendor, DocNumber, TxnDate, TotalAmt). Either hit → skip, mark `duplicate_in_qbo`.
10. **Create** the QBO entity (Bill/Expense/Invoice/SalesReceipt) in **sandbox**, `minorversion` pinned, with an Intuit idempotency/request key.
11. **Attach** the source PDF via the `Attachable` entity, linked to the created txn.
12. **Read back:** fetch the created entity by id; assert vendor/amount/date match the proposal (catch silent coercion).
13. **Record** the QBO id + `SyncToken` + full request/response in `postings`; set proposal `status = posted_sandbox`.
14. **Reconcile:** proposal vs. created entity diff logged; mismatch → exception.

## E. Trigger

Two `pg-boss` jobs added: `post_sandbox` (runs after `propose` for gated proposals) and a manual `ap-hub post <proposal_id> --env sandbox`. Same 3-min cadence inherited.

## F. Inputs

Phase 1 inputs + QBO **write** access to the **sandbox realm** + the `proposals` marked `ready`.

## G. Outputs

- Created QBO **sandbox** transactions (Bills/Expenses/Invoices/SalesReceipts).
- `Attachable` source PDFs on those transactions.
- `postings` rows (external-ID map: attachment sha256 → QBO id + SyncToken).
- `reconciliation` diff rows (proposal vs. created).
- Exceptions for any create/verify failure.
- **No production QBO writes. No Gmail writes/sends** (still Phase 3).

## H. Systems involved (delta)

| System | Phase 2 role | Access change |
|---|---|---|
| QBO Accounting API | **Create** txns + Attachable + read-back | **Write scope, SANDBOX realm only** |
| (all others) | unchanged from Phase 1 | — |

## I. Recommended architecture

**Same single TypeScript service + `pg-boss`.** Phase 2 adds a `src/qbo/write.ts` module and two jobs. No new infrastructure, no workflow engine, no MCP — a `create Bill` call is a deterministic API write, not agent judgment. The `/batch` endpoint is used when a single email/statement yields multiple bills (one HTTP call, per-item error handling, still idempotency-keyed).

Explicitly rejected again: n8n/Temporal (unneeded), a separate "posting service" microservice (same process is fine at this scale), MCP for writes (fixed pipeline).

## J. Open-source / low-cost alternatives

No new paid tools. QBO write is native (free API). `intuit-oauth` + a thin fetch wrapper over the Accounting API — **no need for a heavy QBO SDK** if the official one is stale (`verify current SDK support`). Everything Phase-1's foss-scrubber concluded still holds.

## K. Data mapping (proposal JSON → QBO create payload)

| `proposed_txn` field | QBO Bill field (example) | Rule |
|---|---|---|
| vendor QBO id | `VendorRef.value` | must be resolved (no create-vendor in Phase 2 — unknown vendor stays exception) |
| invoice_number | `DocNumber` | used in dedup query |
| invoice_date | `TxnDate` | ISO date |
| due_date | `DueDate` | optional |
| total | `TotalAmt` (derived) | **must equal Σ line amounts + tax**; API recomputes — assert equality on read-back |
| line_items[] | `Line[].Amount` + `AccountBasedExpenseLineDetail.AccountRef` | account from mapping |
| class mapping | `Line[].*.ClassRef` | if tenant uses classes |
| location mapping | `DepartmentRef` (Location) | if tenant uses locations |
| project mapping | `CustomerRef` on line (Projects are customer sub-entities) | if applicable |
| attachment bytes | `Attachable` → linked to txn id | after create |
| attachment sha256 | `postings.idempotency_key` | dedup guard |

Type routing: AP invoice → **Bill**; AP paid-now receipt → **Purchase/Expense**; AR → **Invoice**; AR paid-now → **SalesReceipt**. (Never a Journal Entry — brainstorm §9.)

## L. Approval gates

- **The confidence gate is the automated gate** in Phase 2: only `ready` + `confidence ≥ auto_threshold` + no blocking flags get created. Because writes are sandbox-only and disposable, **auto-create-to-sandbox is acceptable without a per-item human tap** — that's the point (validate the path at volume).
- **Everything a human would need to approve in production is surfaced but held:** any proposal that is `review`/`exception`, over the amount ceiling, or carries `bank_change_warning` is **never auto-created**, even in sandbox — so the gate logic itself is tested exactly as it'll run in Phase 3.
- **The Phase 3 gates named now (out of scope to build):** production realm, human approval-by-exception before create, the bank-change hard stop, the auto-post amount ceiling on real books.

## M. Error handling (delta — the QBO write failure modes)

| Failure | Detection | Response |
|---|---|---|
| `6190` / duplicate-name-exists | QBO error code | treat as dedup hit; link existing; mark `duplicate_in_qbo`; do not retry blindly |
| Stale `SyncToken` (on any update) | QBO stale-object error | re-fetch entity, re-apply, retry once |
| `429` throttling | HTTP 429 | exponential backoff + retry (pg-boss) |
| `401` (wrong env / expired token) | HTTP 401 | **check sandbox-vs-prod token mismatch first**; refresh; if persists → `auth_failure`, pause tenant |
| Create succeeds but read-back mismatches | read-back assert fails | **do NOT retry** (would duplicate); flag `verify_mismatch`; human inspects; the created txn id is recorded so it can be voided |
| Attachable upload fails after txn created | attach error | txn exists without PDF → exception `attachment_failed`; retry attach only (idempotent on txn id), never re-create txn |
| Partial `/batch` (some items fail) | per-item batch response | apply successes, exception the failures individually — **never treat batch as all-or-nothing** |
| Network drop mid-create (unknown outcome) | timeout, no response | **before any retry, run the dedup query** — if the txn exists, adopt its id; else create. This is the critical replay-safety rule. |
| Any other QBO fault, or retries exhausted | non-retryable fault code / backoff limit hit | exception `qbo_api_error` with the fault payload — the umbrella code from brainstorm §12; never swallowed |

**Re-run safety:** `postings.idempotency_key` (attachment sha256) is checked *and written in the same transaction boundary* as the create-intent record, and the QBO dedup query is the second line of defense. Re-running `post_sandbox` never double-creates. Test this explicitly (`idempotent_double_post`).

## N. Security / permissions (delta)

- **QBO scope: accounting WRITE — but only ever pointed at the SANDBOX realm in Phase 2.** Sandbox and production use **different credential pairs**; store them separately; a config flag (`QBO_ENV=sandbox`) selects them and **there is no code path in Phase 2 that can select production.** (Enforced, not conventional.)
- **Confirm-realm on connect:** read `CompanyInfo`, assert it's the expected sandbox company name before any write. A user asserting "this is sandbox" is not verification.
- Log every write with realm, entity type, entity id, source-doc hash, request id, timestamp — **secrets redacted.**
- Gmail unchanged (`readonly`). No Gmail writes in Phase 2.
- Bank-change/PII still flagged-not-acted.

## O. Logging / audit trail (delta)

Add `postings` (request/response JSONB archived) + `reconciliation` diffs. Every create/attach/read-back is an `audit_log` row with realm + qbo_id. Archive raw QBO responses (transiently) for dispute/debugging. `llm_calls` unchanged.

## P. Admin controls (delta)

- `ap-hub post <proposal_id> --env sandbox` — force-create one.
- `ap-hub void <posting_id>` — void/delete the sandbox txn (reversal path), audited.
- `ap-hub postings --status posted_sandbox|verify_mismatch [--csv]`.
- `ap-hub reconcile --proposals-vs-postings` — show diffs.
- `ap-hub env` — print which realm is active (must say sandbox) — a guardrail command.
- Inherits Phase 1 CLI. Still no web UI.

## Q. Testing plan (delta — all against sandbox)

- **Idempotency:** create same proposal twice → exactly one QBO txn (`idempotent_double_post`).
- **Network-drop replay:** simulate create-then-timeout → retry adopts existing txn, doesn't duplicate (`replay_after_timeout`).
- **Dedup query:** pre-existing sandbox txn (vendor+docno+amount) → skip, `duplicate_in_qbo`.
- **6190 handling:** force a duplicate-name error → linked, not retried into a mess.
- **Read-back verify:** created amount/vendor/date match proposal; inject a mismatch fixture → `verify_mismatch`, no retry.
- **Attach:** PDF present on the created txn (fetch Attachable); attach-fail path retries attach only.
- **Batch partial:** multi-bill statement where item 2 is bad → items 1,3 created, item 2 exceptioned.
- **Gate enforcement:** a `review`/over-ceiling/`bank_change_warning` proposal is **never created**, even in sandbox (`gate_holds`).
- **Env guard:** assert no code path can target production; `QBO_ENV=production` in Phase 2 refuses to write (`no_prod_write`).
- **Reversal:** `void` removes/voids the sandbox txn and audits it.
- **Real pilot:** run against real last-30-days mail → create in *your* sandbox → manually inspect that the created bills match the source PDFs (the correctness gate for Phase 3).

## R. Rollout plan

1. **Fixtures + idempotency/replay tests green** on sandbox. *Gate:* zero duplicate creates across all replay tests.
2. **Small real pilot** — feed 20–50 real documents → sandbox. *Gate:* every created txn matches its source PDF on manual inspection; every skip/exception is correctly typed; read-back verify catches injected mismatches.
3. **Volume pilot** — run continuously on real mail → sandbox for 1–2 weeks. *Gate to advance to Phase 3:* auto-created-to-sandbox accuracy ≥ agreed % with zero duplicates and zero wrong-account creates that a human wouldn't catch pre-create. Only then design Phase 3 (production + human approval-by-exception + bank-change hard stop + amount ceiling).

## S. Simplicity audit (what was cut)

- **No "draft" abstraction invented** — we did not build a fake draft/staging layer to simulate a QBO draft state that doesn't exist; sandbox *is* the safe environment. *Safe:* matches QBO's real model, less code.
- **No production code path** — Phase 2 literally cannot write to prod. *Safe:* removes the highest-risk failure by construction.
- **No new service/queue/DB** — one module + two jobs on the existing stack. *Safe:* create-bill is a deterministic call.
- **No vendor/customer auto-creation** — unknown vendor stays an exception (creating master records unattended is a Phase 3 judgment call). *Safe:* avoids polluting the customer/vendor list.
- **No web UI, no reconciliation dashboard** — CLI + SQL. *Safe:* Phase 4.
- **No install wizard** — connect flows stay CLI commands; the guided wizard (brainstorm §14) is Phase 3. *Safe:* packaging, not capability.
- **No `/batch` unless multi-item** — single creates by default; batch only for multi-bill statements. *Safe:* simpler, batch is an optimization.

Preserved: idempotency (two layers), read-back verification, typed exceptions, env isolation, confirm-realm, audit archive, reversal path, gate enforcement.

## T. Final build checklist (delta on Phase 1)

- [ ] `src/qbo/write.ts` — create Bill/Expense/Invoice/SalesReceipt, `minorversion` pinned, idempotency key, `/batch` helper.
- [ ] `src/qbo/attach.ts` — `Attachable` upload linked to txn.
- [ ] `src/qbo/verify.ts` — read-back + assert.
- [ ] `src/qbo/dedup.ts` — sha256 map check + QBO (vendor,docno,amount,date) query.
- [ ] `src/qbo/reverse.ts` — void/delete.
- [ ] `src/jobs/post_sandbox.ts` — the gated posting job.
- [ ] `db/migrations` — `postings` (idempotency_key UNIQUE, qbo_id, sync_token, request/response JSONB, realm, mode), `reconciliation`.
- [ ] Config: separate sandbox vs prod credential slots; `QBO_ENV` guard that hard-refuses prod in Phase 2.
- [ ] Tests: idempotent_double_post, replay_after_timeout, duplicate_in_qbo, 6190, verify_mismatch, attach retry, batch_partial, gate_holds, no_prod_write, void reversal.

Env vars added: `QBO_ENV=sandbox`, `QBO_SANDBOX_CLIENT_ID/SECRET`, `QBO_SANDBOX_REALM_ID`, `QBO_MINOR_VERSION`, `AUTO_THRESHOLD`, `AMOUNT_CEILING`.

## U. Done looks like

- [ ] Feeding a `ready` proposal creates exactly one sandbox Bill with the right vendor/account/amount/date, PDF attached, and a `postings` row with the QBO id + SyncToken (test `create_and_verify`).
- [ ] Running the same proposal again creates **zero** additional QBO txns (test `idempotent_double_post`).
- [ ] Create-then-timeout, then retry → adopts the existing txn, no duplicate (test `replay_after_timeout`).
- [ ] A `review`/over-ceiling/`bank_change_warning` proposal produces **no** QBO txn (test `gate_holds`).
- [ ] `QBO_ENV=production` refuses to write anything in Phase 2 (test `no_prod_write`).
- [ ] Read-back mismatch fixture → `verify_mismatch` exception, **no retry** (test `verify_mismatch`).
- [ ] `ap-hub void <posting_id>` removes the sandbox txn and writes an audit row.
- [ ] Real-mail sandbox pilot: created bills match source PDFs on manual inspection; zero duplicates over the pilot window (the number that gates Phase 3).

## V. AI coder implementation prompt (copy-paste, extends Phase 1)

> Extend **ap-hub** to **Phase 2: controlled posting to a QuickBooks Online SANDBOX company only.** Inherit all Phase 1 behavior. **Critical QBO fact: there is no draft state for Bills/Expenses/Invoices — a create posts to the ledger. Therefore Phase 2 writes go ONLY to a disposable sandbox realm, and there must be NO code path that can write to production.**
>
> Add a `post_sandbox` pg-boss job that: selects `proposals` with status `ready` and `confidence ≥ AUTO_THRESHOLD` and no blocking flags (duplicate, total_mismatch, bank_change_warning, unknown_vendor, unmapped_*); runs a two-layer dedup (check `postings.idempotency_key` = attachment sha256, AND query QBO for an existing txn matching vendor+DocNumber+TxnDate+TotalAmt); creates the QBO entity (Bill for AP invoice, Purchase/Expense for paid receipt, Invoice/SalesReceipt for AR — never a Journal Entry) with `minorversion` pinned and an idempotency/request key; uploads the source PDF via the `Attachable` entity linked to the txn; reads the entity back and asserts vendor/amount/date match the proposal; records qbo_id + SyncToken + request/response in a new `postings` table and sets proposal status `posted_sandbox`; logs a proposal-vs-created diff to `reconciliation`.
>
> **Idempotency & replay safety (most important):** re-running the job or retrying after a mid-create network timeout must never create a duplicate — always run the dedup query before create, and on unknown-outcome timeouts adopt the existing txn if the query finds it. Handle QBO `6190` (duplicate) as a dedup hit (link, don't blind-retry), stale SyncToken (refetch+retry once), `429` (backoff). If create succeeds but read-back mismatches, do NOT retry — flag `verify_mismatch` and record the txn id so it can be voided. If Attachable upload fails after the txn exists, retry only the attach, never re-create the txn. For multi-bill statements use `/batch` and handle per-item partial failure.
>
> **Environment isolation (enforced, not conventional):** separate sandbox vs production credential slots; a `QBO_ENV` config that in Phase 2 hard-refuses to write when set to production; confirm the sandbox company via CompanyInfo (assert the expected name) before any write. Log every write with realm/entity/id/source-hash/request-id, secrets redacted.
>
> Add CLI: `post <proposal_id> --env sandbox`, `void <posting_id>` (reversal, audited), `postings --status`, `reconcile --proposals-vs-postings`, `env` (prints active realm). Do NOT auto-create vendors/customers (unknown vendor stays an exception). No production writes, no Gmail writes, no web UI — those are later phases.
>
> Tests that must pass: create_and_verify, idempotent_double_post, replay_after_timeout, duplicate_in_qbo, 6190_handling, verify_mismatch (no retry), attach_retry, batch_partial, gate_holds, no_prod_write, void_reversal. Reference `brainstorm-output.md` §9 and `phase2-spec.md`.

## W. Cost & payback

Build: ~1–2 weeks on top of Phase 1 (write path + dedup/replay + tests are the work; the tests are most of it). Running cost unchanged from Phase 1 (sandbox API calls are free; still <$40/mo + LLM). **Payback: still validation, not hours** — Phase 2 proves the create/dedup/verify path against a disposable company. Real hours saved arrive in Phase 3 when it posts to real books. **Do not quote hours-saved ROI for Phase 2.** Its deliverable is: "the full path works end-to-end with zero duplicates on real mail into sandbox" — the go/no-go for touching production.

## X. Runbook stub (for Ben)

**To pause:** `ap-hub pause` (stops the poller and therefore the posting job). Because Phase 2 only ever writes to the sandbox, pausing has no effect on your real books either way — it just stops populating the practice company.

**To run manually while paused:** work your real books by hand in QuickBooks as usual (Phase 2 never touched them). If you want to test a single proposal into sandbox, run `ap-hub env` to confirm it says *sandbox*, then `ap-hub post <proposal_id> --env sandbox`, then check the sandbox company. To undo anything it created in sandbox, `ap-hub void <posting_id>`.

**To restart:** `ap-hub resume`. On start it confirms the QuickBooks sandbox company name — if that name is wrong or it errors on auth, the sandbox token expired or the wrong credentials are loaded; re-run `ap-hub connect qbo --env sandbox`, confirm the company name it reads back, then `ap-hub resume`. **Never** set `QBO_ENV=production` in Phase 2 — the code will refuse it, but don't rely on that; production is Phase 3 with its own approval gates.

---

## AMENDMENT A1 — SwarmSync Proof Suite Integration (2026-07-11) — Phase 2 delta

**Status: ACTIVE. Inherits phase1-spec Amendment A1 in full (endpoints, `proof_refs` schema, env vars, gating rules, fail-safe invariant, do-not-build list). Where it conflicts with an original section, A1 wins.** Phase 2 additions:

### A1-P2.1 Posting gate extension (amends §D step 8 and §L)

`post_sandbox` selects a proposal only if — in addition to the existing gate — ALL of:
- both `proof_refs` rows exist for its document (invoiceproof + verify_api),
- the InvoiceProof scan has no unresolved critical or high finding,
- no `proof_scan_unavailable` exception is open for the document.

A proposal that reached `ready` before a SwarmSync outage cannot be posted while the outage exception is open. Nothing is ever created in QBO — even sandbox — without completed proof coverage.

### A1-P2.2 Posting anchor (amends §D steps 13–14 and §O)

After a successful create + read-back verify, submit an AuditProof record (`POST {SWARMSYNC_API_BASE}/api/verify`, `source_type: 'audit_proof'`) containing: realm, qbo_id, entity type, idempotency_key (attachment sha256), the proposal-vs-created diff hash, and timestamps → store `proof_id` + `chain_hash` in `proof_refs` (entity_kind = `posting`). **Anchor failure NEVER voids or re-creates the QBO transaction** — it writes `proof_scan_unavailable` and retries the anchor only (same pattern as attach-failure: never re-create the txn).

### A1-P2.3 paymentHistory upgrade

InvoiceProof `paymentHistory[]` now includes posted sandbox transactions (invoiceNo, vendor, amount, submittedAt from `postings`), giving `RECENT_DUPLICATE_IN_PAYMENT_HISTORY` real teeth as a third dedup layer alongside the sha256 map and the QBO query.

### A1-P2.4 Named tests (amends §Q and §U)

- `posting_anchor` — a successful sandbox posting yields a `proof_refs` row (posting × auditproof) with proof_id + chain_hash; a simulated anchor failure → exception + anchor-only retry, ZERO additional QBO transactions.
- `proof_gate_posting` — a `ready` proposal with a missing or failed proof ref is never posted.
- `chain_verify` (integration) — `GET /api/proof/:id/export/verify` passes for a recorded posting anchor.

---

*Saved: `Desktop/Ultimate Brainstorm Output/ai-accountant-hub_20260709/phase2-spec.md`. Companion to `brainstorm-output.md` + `phase1-spec.md`. Amended 2026-07-11 (A1: SwarmSync proof suite).*
