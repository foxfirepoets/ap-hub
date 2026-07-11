# Phase 1 Spec — AI Accountant Hub: Dry-Run Proof of Concept

**automation-spec-grandmaster output · 2026-07-09 · for Ben Stone**
**Scope: Gmail → classify → download+hash → LLM-vision extract → mapping resolver → proposed QBO transaction JSON. ZERO writes to QBO.**
Companion to `brainstorm-output.md` (same folder). Sections A–X per the spec doctrine.

---

## A. Automation Name

**AP-Hub Phase 1 — Dry-Run Invoice Reader** (working name: `ap-hub`)

---

## B. Plain-English summary

The business forwards (or auto-labels) its accounting email into one Gmail label. Every few minutes this tool wakes up, reads the new mail, decides which messages are actually bookkeeping (invoice, receipt, statement, payment notice, W-9), pulls down the attached PDFs and images, and reads each one the way a bookkeeper would — pulling out the vendor, invoice number, date, amount, tax, and line items. It then guesses which QuickBooks vendor and account each one belongs to and writes down a *proposed* QuickBooks entry.

**It does not touch QuickBooks. It writes nothing to the books, posts nothing, sends nothing.** *(Amendment A1: it does call Ben's own SwarmSync proof platform — InvoiceProof fraud scan, Verify-API extraction verification, AuditProof audit anchoring. Those calls never touch QuickBooks or Gmail; see Amendment A1 at the end of this spec.)* It produces a reviewable list: "here's what I found, here's where I *would* put it, here's how sure I am." The whole point of Phase 1 is to prove the reading and guessing are good enough to trust — on real mail, with no risk to the books — before Phase 2 ever creates a transaction in a QuickBooks sandbox.

---

## C. Current manual workflow (baseline)

As performed today by a bookkeeper (the process, including the implicit steps):

1. Open the accounting inbox, scan for new vendor mail. *(Interruptions; some mail sits for days.)*
2. Decide if each email matters (invoice vs. newsletter vs. a "thanks" reply).
3. Open the attachment, eyeball vendor / invoice # / amount / date.
4. Figure out which QuickBooks vendor this is (is "ACME BLDG SUPPLY LLC" the same as existing vendor "Acme Building Supply"?).
5. Decide the account/category and, for real-estate books, the class/location/project.
6. *(Implicit exception steps — the load-bearing ones:)* if the invoice number is missing, reply to the vendor; if it looks like a duplicate, dig through QuickBooks to check; if the totals don't foot, email back; if a vendor's remit/bank details changed, stop and verify by phone.
7. Manually key the bill/expense into QuickBooks and attach the PDF.

**Bottleneck (what earns automation):** steps 3–5 — *reading each document and resolving vendor + account/class* — are the time sink and the error source. Step 7 (the keying) is fast once 3–5 are done. Phase 1 automates the reading + the resolution *proposal*; it deliberately stops before the keying (that's Phase 2).

**Baseline `[assumed SMB-typical — verify in the two-week measurement, brainstorm §Countercase]`:** ~3–6 minutes of human attention per document end-to-end; realistic SMB volume tens-to-low-hundreds of AP documents/month; error modes today = miskeyed amount, wrong account, missed duplicate, late entry. Record the real numbers during the dry-run before quoting payback.

---

## D. Future automated workflow (Phase 1 target)

1. **Poll** Gmail every 3 min for new messages under the watched label (incremental via `historyId`).
2. **Persist** each new message (dedup on Gmail `message_id`).
3. **Classify** doc type + direction (AP/AR): deterministic rules first, LLM only when rules are ambiguous.
4. **Download** each attachment, **SHA-256 hash** it, store the bytes once; duplicate hash → skip extraction, flag `duplicate`.
5. **Extract** structured fields via one LLM-vision call → JSON with per-field confidence + `missing_fields`.
6. **Resolve mapping** against imported QBO lists (vendor / account / class / location / project) → overall confidence.
7. **Emit a proposed QBO transaction JSON** into the `proposals` table — status `ready`, `review`, or `exception`.
8. **Human reviews** the proposals (via a read-only export/table — see Section P). Corrections are captured but **nothing is written back to QBO in Phase 1.**

Phase 1 ends at a reviewable proposal. No draft, no post, no reply-send.

---

## E. Trigger

**Schedule (cron), every 3 minutes**, via a `pg-boss` scheduled job. Not webhook/push — polling with Gmail `history.list` is simpler, has no public endpoint to secure, and 3-minute latency is irrelevant for accounting. (Pub/Sub push is a Phase 3+ option if latency ever matters.)

Secondary trigger: **manual "reprocess message N"** (admin CLI command) for re-running extraction after a prompt/mapping change.

---

## F. Inputs

- Gmail messages under the watched label (headers, body, thread id).
- Attachments: PDF, JPEG/PNG/HEIC, CSV (bank/vendor statements). Also **email-body-only invoices** (no attachment — extract from body text).
- QBO reference lists (read-only, imported once + refreshed): chart of accounts, vendors, customers, classes, locations, projects, items.
- Tenant config: watched label, mapping rules, confidence thresholds, class/location convention.

## G. Outputs

- `proposals` rows: proposed QBO transaction JSON + confidence + status + `missing_fields`.
- `exceptions` rows: typed reasons for anything not auto-resolvable.
- A read-only proposal review export (SQL view / CSV / optional Metabase later — **not** a custom UI in Phase 1).
- Structured logs + `audit_log` rows.
- **No** QBO writes, **no** Gmail sends, **no** Gmail label changes in Phase 1 (label writes are Phase 3; Phase 1 is read-only on Gmail too — status lives in Postgres).

## H. Systems involved

| System | Role in Phase 1 | Access |
|---|---|---|
| Gmail API | Source of messages + attachments | **Read-only** (`gmail.readonly`) |
| QBO Accounting API | Reference lists for mapping only | **Read-only** (accounting scope, query only) |
| LLM vision (Claude) | Document → structured fields; ambiguous classification | API key |
| Postgres (Supabase/Neon) | SoR + `pg-boss` queue + attachment bytes | Connection string |
| The `ap-hub` Node service | Poller + workers + admin CLI | Runs the whole thing |

---

## I. Recommended architecture

**Chosen: custom-code single TypeScript service (poller + `pg-boss` workers) on Postgres.** One deployable process, one database.

Walking the tool-preference ladder and justifying the stop:
- **Configuration in existing systems?** Gmail filters can label mail, and QBO has native receipt capture — but neither produces a *proposed, confidence-scored, mapped* transaction with per-field extraction you can measure. Insufficient alone. *(This is exactly the "buy vs build" crux from the brainstorm — the two-week gap test decides whether you even need Phase 1. Assume here you've decided to build.)*
- **Light glue (Apps Script / connectors)?** Apps Script can poll Gmail, but LLM-vision extraction + a Postgres-backed queue + idempotent hashing is beyond what a Sheets-bound script maintains sanely. Insufficient.
- **Hosted automation (Zapier/Make/n8n)?** Rejected: per-task cost, opaque failures, and you'd still hand-code the extraction + mapping logic inside a custom step — so the flow engine buys nothing but lock-in and a babysitting surface. (n8n self-hosted is the least-bad of these but still a layer over one small service.)
- **Custom code — STOP HERE.** A single Node service with `pg-boss` gives durable retries, transactional enqueue, and idempotency in the database you already need, with zero extra infrastructure. This is the leanest level that actually meets the requirement.
- **Agents?** No. This is a fixed deterministic pipeline, not agent-judgment-driven reuse.

**MCP fit test:** Does Phase 1 need MCP? **No.** MCP is for an LLM agent deciding *which* tool to call *when*, reused across hosts. Phase 1 is a fixed cron pipeline. Build it as a worker, not an MCP server. *(You may still use your connected Gmail/QBO MCPs manually to prototype the extraction prompt and eyeball QBO lists before coding — that's scouting, not runtime.)*

Rejected alternatives, explicitly: n8n/Windmill/Temporal (workflow engines — unneeded over one service), BullMQ/Redis (pg-boss removes Redis), Retool/Appsmith (no UI in Phase 1), Tesseract/Document AI (LLM vision replaces the OCR pipeline — brainstorm §16), MinIO (Postgres/Supabase storage suffices).

---

## J. Open-source / low-cost alternatives (foss-scrubber pass)

Only two non-free things survive; everything else is FOSS or native.

| Need | Chosen | Cost | vs. rejected | Why chosen |
|---|---|---|---|---|
| Queue/jobs | **pg-boss** (MIT) | $0 (rides Postgres) | Redis+BullMQ, Temporal, Inngest, Trigger.dev | No new infra; transactional enqueue = real idempotency; DLQ + backoff built in |
| DB + storage | **Postgres** (Supabase/Neon free-tier to start) | $0–25/mo | Firebase, BigQuery, MinIO, S3 | One dependency does SoR + queue + file bytes |
| Extraction | **LLM vision (Claude)** — *paid, justified* | ~usage | Tesseract, PaddleOCR, Google Document AI, Textract, Azure FR, Docling, Unstructured, LlamaParse | Single call beats a 4-stage OCR pipeline's setup + template maintenance; per-field confidence out of the box. **This is the "saves enough time to justify cost" call.** |
| Gmail | **Gmail API** (native, free) | $0 | IMAP libs, browser automation | Official, incremental sync, least-privilege scopes |
| QBO lists | **Intuit Accounting API** (native, free) | $0 | CSV export-import | Read-only list query; reused in Phase 2 anyway |
| Runtime host | **Render/Fly/Railway free–hobby** or Docker on a VPS | $0–7/mo | — | One container; Docker-portable |
| Reporting | **defer** (SQL view/CSV now; Metabase later) | $0 | Superset, Looker, Power BI | No BI tool needed to review a proposal list in Phase 1 |

Honest trade-off: LLM-vision has a per-document cost a self-hosted OCR model avoids, but Tesseract-class OCR without layout understanding pushes you into per-vendor template maintenance — higher *total* cost of ownership for messy SMB invoice variety. Paid extraction wins on TCO here.

---

## K. Data mapping (source field → destination → validation)

Extraction target fields (LLM-vision output), each with a `confidence` 0–1:

| Source (document) | Destination field | Validation rule |
|---|---|---|
| Vendor name / letterhead | `vendor_name` | non-empty; else `missing_fields += vendor_name` |
| Invoice/receipt number | `invoice_number` | non-empty for invoices; missing → exception `missing_invoice_no` |
| Invoice date | `invoice_date` | parseable date ≤ today+2d; else flag |
| Due date | `due_date` | parseable date ≥ invoice_date (if present) |
| Total | `total` | decimal > 0; **must equal `sum(line_items) + tax`** (foot check) or → `total_mismatch` |
| Tax | `tax` | decimal ≥ 0 |
| Line items | `line_items[]` (desc, qty, amount) | each amount decimal; array may be empty (some receipts) |
| Payment terms | `payment_terms` | free text; optional |
| Remit-to address | `remit_to` | free text; optional |
| Bank/payment info | `bank_info` | free text; **if present AND differs from last-seen for this vendor → `bank_change_warning` flag** (carried into Phase 3 gate; in Phase 1 it just tags the proposal) |
| Customer/project/job | `job_ref` | free text; optional |
| Class hint | `class_hint` | free text; optional |
| Location hint | `location_hint` | free text; optional |
| Account/category hint | `account_hint` | free text; optional |
| — | `doc_type` | enum: invoice/receipt/statement/payment_confirmation/w9/other |
| — | `direction` | enum: AP/AR |
| — | `confidence` (overall) | = min(component confidences) − missing-field penalty |
| — | `missing_fields[]` | list of required-but-absent fields |

Mapping resolver (extraction → proposed QBO transaction):

| Extracted | Resolves to | Method | On miss |
|---|---|---|---|
| `vendor_name` + sender domain | QBO Vendor id | exact prior mapping → fuzzy (normalized name/token overlap) | exception `unknown_vendor` |
| `doc_type`+`direction` | QBO txn type (Bill/Expense/Invoice/SalesReceipt) | per-vendor rule; default Bill for AP | exception |
| `line_items`/`account_hint` | QBO Account or Item | per-vendor default → keyword rule | exception `unmapped_account` |
| `job_ref`/`class_hint`/`location_hint` | Class / Location / Project | tenant convention config → keyword/vendor rule | exception `unmapped_dimension` |
| all above | **`proposed_txn` JSON** (no QBO write) | assemble QBO-shaped object + `idempotency_key = attachment_sha256` (recorded, unused in P1) | — |

---

## L. Approval gates

**Phase 1 is entirely pre-approval by construction — the whole phase is one big dry-run gate.** No automated action reaches QuickBooks, Gmail-send, or the ledger. Every proposal sits in `proposals` for human eyes.

The one thing a human *does* in Phase 1: **review the proposal list and (optionally) record corrections.** Corrections are captured in `corrections` for the Phase 3 learning loop but **are not written anywhere external.** What the reviewer sees per proposal: source PDF link, extracted fields + confidences, `missing_fields`, proposed vendor/account/class, overall confidence, and any flags (`duplicate`, `bank_change_warning`, `total_mismatch`).

The real approval gates (draft creation, auto-post, reply-send, the bank-change hard stop) are **Phase 2/3** — named here so they're not forgotten, but out of scope for this build.

---

## M. Error handling (failure path first)

Every step: **detection → notification → manual fallback.** No silent failure.

| What goes wrong | Detection | Response |
|---|---|---|
| Gmail token expired/revoked | 401 on poll | Halt tenant's poll; `exceptions: auth_failure`; alert; **fallback:** bookkeeper works the inbox manually (nothing was automated anyway) |
| QBO list token expired | 401 on list refresh | Use last cached lists; flag staleness; alert |
| LLM extraction call fails/times out | exception/timeout | `pg-boss` retry ×3 exponential backoff → DLQ; `exceptions: extraction_failed`; **fallback:** doc stays unprocessed, visible in queue |
| LLM returns low confidence | `confidence < review_threshold` | proposal status `exception: low_confidence` (not an error — expected path) |
| Corrupt/unreadable PDF | parse/vision error | `exceptions: bad_pdf`; skip; visible |
| Unsupported file type | MIME check | `exceptions: unsupported_file`; skip |
| Accounting email, no file, no extractable body | classify says accounting doc but nothing to extract | `exceptions: no_attachment`; visible in queue (the "reply asking for the invoice" is Phase 3) |
| Duplicate attachment | SHA-256 already seen | mark `duplicate`; skip extraction (idempotent) |
| Duplicate email (re-poll) | Gmail `message_id` UNIQUE | insert ignored; no reprocessing (**re-run safety**) |
| Totals don't foot | `total ≠ Σlines+tax` | proposal `exception: total_mismatch` |
| Partial batch (poll dies mid-run) | job-level | `pg-boss` re-runs the job; per-message dedup + per-attachment hash make replay safe (**partial-batch recovery**) |
| Rate limit (Gmail/QBO/LLM 429) | 429 | backoff + retry; respect quotas |

**Re-run safety guarantee:** the entire pipeline is idempotent — re-running the poller or reprocessing a message never creates duplicate messages, attachments, or proposals (unique constraints on `gmail_message_id`, `sha256`, and `proposals(attachment_id)` upsert).

---

## N. Security / permissions

- **Gmail scope: `gmail.readonly` only** for Phase 1 (no modify/compose/send — those arrive in Phase 3). Narrowest that works.
- **QBO scope: accounting, used read-only** — query lists only; **no write methods implemented in the codebase at all** (not just disabled — absent, so a bug can't post).
- **OAuth tokens encrypted at rest** (KMS-backed column or host secret manager); **never logged**, even at debug; redact on any echo.
- **LLM calls:** send document bytes to the model; do **not** log full document contents or extracted bank/PII fields in plaintext logs — store in DB, redact in logs.
- **Secrets** in env vars / secret manager; no `.env` committed.
- **Single-tenant** deployment for Phase 1 (your own books first); `tenant_id` in schema so multi-tenant is later config, not a rewrite.
- **Confirm-realm check** on QBO connect (read `CompanyInfo`, verify the company name) to avoid wrong-realm/sandbox confusion.
- Bank-change and PII fields are flagged and stored but **never acted on** in Phase 1.

---

## O. Logging / audit trail

- **Structured logs** (JSON) per job: message id, step, duration, outcome, model, token cost — **secrets/PII redacted.**
- **`audit_log` row** per state transition and per external API call (actor=`system`, action, entity, before/after hash, timestamp).
- **`llm_calls` record** (model, prompt hash, latency, cost, confidence) for accuracy measurement + cost tracking — this is how you prove Phase 1's extraction quality.
- Retention: keep everything through the dry-run evaluation window (≥90 days) so you can compute the accuracy baseline.

---

## P. Admin controls

Phase 1 is a CLI + SQL, **no custom UI** (a dashboard here would be unneeded build — see Section S):

- `ap-hub poll --once` — run one poll cycle manually.
- `ap-hub reprocess <message_id>` — re-run classify/extract/map after a prompt or mapping change.
- `ap-hub proposals --status review|exception|ready [--csv]` — list/export proposals for review.
- `ap-hub correct <proposal_id> --field X --value Y` — record a correction (captured for learning; no external write).
- `ap-hub pause` / `ap-hub resume` — stop/start the poller (`pg-boss` queue drain).
- `ap-hub lists refresh` — re-import QBO reference lists.
- Proposal review itself: a **read-only SQL view** (`v_proposal_review`) → export to CSV or point Metabase at it *if* you want visuals later.

---

## Q. Testing plan

- **Unit:** classifier rules; foot-check math; SHA-256 dedup; mapping resolver (exact/fuzzy/miss); confidence calculation; `missing_fields` derivation.
- **Schema/contract:** LLM extraction output validated against a JSON schema — malformed model output rejected and retried, never persisted raw.
- **Golden-file extraction fixtures:** a set of real (redacted) invoices/receipts/statements + email-body-only cases with known-correct field values; assert extraction accuracy per field; this is the **accuracy gate** for advancing phases.
- **Bad-data:** corrupt PDF, password-protected PDF, 0-byte file, wrong MIME, huge multi-invoice statement, invoice with no number, totals that don't foot, duplicate attachment, duplicate email.
- **Idempotency:** run poller twice on the same inbox → exactly one message/attachment/proposal each.
- **Integration (read-only):** live Gmail read on a test label; live QBO list read on **sandbox**; live LLM call.
- **Dry-run guarantee test:** assert that **no QBO write method exists / is callable** and no Gmail send/modify occurs — grep-level + runtime assertion.
- **Real-world pilot:** run against the actual last-30-days accounting mail; measure per-field extraction accuracy and mapping hit-rate → these numbers gate Phase 2.

---

## R. Rollout plan (Phase 1 is itself the dry-run stage of the overall program)

1. **Fixtures pass** — golden-file extraction accuracy ≥ target (set target from the pilot; e.g. ≥95% on vendor/total/date for clean PDFs). *Gate to advance:* fixtures green + dry-run assertion passes.
2. **Sandbox/read-only pilot** — run on a copy of real mail (or the real label, read-only) + QBO sandbox lists. *Gate:* mapping hit-rate on top-20 recurring vendors ≥ target; exception reasons are all sensible/typed.
3. **Live read-only on production mail** — real inbox (read-only), real QBO lists (read-only), producing proposals for human review. *Gate to advance to Phase 2:* a human agrees with the proposal (vendor + account + amount) on ≥ an agreed % of documents, and every disagreement is a *typed exception you can fix once*, not a silent wrong answer.

No stage in Phase 1 writes anything external. Advancing past Phase 1 = starting Phase 2 (sandbox transaction creation).

---

## S. Simplicity audit (what was cut and why it's safe)

Removed / deferred from any "obvious" first design:

- **Custom admin UI / dashboard → cut.** Replaced by CLI + SQL view + optional CSV. A proposal list doesn't need a web app in Phase 1; the UI is Phase 3 when there's an exception queue to work. *Safe:* review is read-only; SQL/CSV fully suffices.
- **Gmail label writes / status sync → cut.** Status lives in Postgres in Phase 1; touching Gmail needs `modify` scope and adds a write surface for zero Phase-1 value. *Safe:* keeps scope at `readonly`.
- **Reply drafting → cut.** No `compose`/`send` in Phase 1. *Safe:* replies are Phase 3.
- **Reconciliation → cut.** Phase 4. *Safe:* not needed to prove extraction+mapping.
- **Install wizard (brainstorm §14) → cut.** Connect/import/dry-run exist as CLI commands; the guided wizard packaging is Phase 3. *Safe:* the wizard is UX packaging, not capability.
- **BI tool (Metabase/Superset) → deferred.** SQL view now. *Safe:* no decision needs a chart yet.
- **Workflow engine (n8n/Temporal) → not added.** `pg-boss` in the DB covers retries/DLQ/backoff. *Safe:* fewer moving parts.
- **Redis/BullMQ, MinIO, separate warehouse → not added.** Postgres does queue + storage. *Safe:* one dependency.
- **Embeddings-based vendor matching → deferred.** Start with fuzzy string match; add embeddings only if hit-rate is poor. *Safe:* measurable upgrade path, not a rewrite.
- **QBO write code → intentionally absent (not just disabled).** *Safe:* a bug literally cannot post to the ledger.

Preserved (non-negotiable): idempotency, audit log, typed exceptions, confidence gating, least-privilege scopes, failure-path handling, the dry-run guarantee.

---

## T. Final build checklist

Files/modules:
- [ ] `src/index.ts` — boot service, register `pg-boss` jobs + schedule.
- [ ] `src/gmail/poll.ts` — `history.list` incremental poll (readonly).
- [ ] `src/gmail/attachments.ts` — download, SHA-256, store bytes.
- [ ] `src/classify.ts` — rules → LLM fallback.
- [ ] `src/extract.ts` — LLM-vision call, JSON-schema-validated output.
- [ ] `src/mapping/resolve.ts` — vendor/account/dimension resolver + confidence.
- [ ] `src/proposal.ts` — assemble `proposed_txn` JSON, write `proposals`.
- [ ] `src/qbo/lists.ts` — read-only list import (sandbox first).
- [ ] `src/exceptions.ts`, `src/audit.ts` — typed exceptions + audit rows.
- [ ] `src/cli.ts` — poll/reprocess/proposals/correct/pause/resume/lists.
- [ ] `db/migrations/*` — tables from brainstorm §7 (subset: tenants, oauth_tokens, messages, attachments, extractions, mappings, proposals, exceptions, audit_log, corrections, llm_calls) + `v_proposal_review`.
- [ ] `test/fixtures/*` — golden-file invoices/receipts/statements/body-only.

Endpoints/jobs: OAuth callback (Gmail read, QBO read) · `pg-boss` jobs: `poll`, `classify`, `extract`, `map`, `propose` · scheduled `poll` every 3 min.

Env vars: `DATABASE_URL`, `GMAIL_CLIENT_ID/SECRET`, `QBO_SANDBOX_CLIENT_ID/SECRET`, `QBO_SANDBOX_REALM_ID` (sandbox-suffixed from day one so Phase 3's production slots can never be confused with them), `ANTHROPIC_API_KEY`, `ENCRYPTION_KEY`, `WATCHED_LABEL`, `AUTO_THRESHOLD`, `REVIEW_THRESHOLD`, plus (Amendment A1): `SWARMSYNC_API_BASE`, `SWARMSYNC_WEB_BASE`, `SWARMSYNC_API_KEY`.

Proof needed to call it built: see Section U.

---

## U. Done looks like

Falsifiable, observable:

- [ ] Running `ap-hub poll --once` on the test label inserts N `messages` rows and 0 duplicates on a second run (assert row counts).
- [ ] Every attachment has a `sha256`; feeding the same file twice yields **one** `attachments` row and a `duplicate` flag on the second message (test `dedup_same_file`).
- [ ] For each golden fixture, `extractions.fields` matches expected vendor/invoice#/date/total within tolerance; accuracy report ≥ target (test `golden_extraction`).
- [ ] Each proposal has an overall `confidence`, a `status` in {ready, review, exception}, and a `proposed_txn` JSON that is **QBO-shaped but never sent** (test `no_write` asserts no QBO write method is reachable + no Gmail send/modify call in logs).
- [ ] Totals-don't-foot fixture produces `exceptions.reason_code = 'total_mismatch'` (test `foot_check`).
- [ ] Unknown vendor produces `unknown_vendor`, not a wrong guess (test `unknown_vendor`).
- [ ] `SELECT * FROM v_proposal_review` returns a human-readable row per proposal with source-PDF link, fields, confidences, flags.
- [ ] `audit_log` has a row for every state transition; no token/PII appears in any log line (grep assertion).
- [ ] Pilot run on real last-30-days mail produces a proposal list a human can review, and the human-agreement rate + typed-exception coverage are recorded (the numbers that gate Phase 2).

---

## V. AI coder implementation prompt (copy-paste)

> Build **Phase 1 of the AI Accountant Hub ("ap-hub")**: a single TypeScript (Node 20+) service that reads accounting email from Gmail, extracts invoice/receipt/statement data with an LLM vision model, resolves it against QuickBooks Online reference lists, and writes a **proposed** QBO transaction to Postgres. **It must never write to QuickBooks, never send or modify Gmail — read-only everywhere. This is a dry-run.**
>
> **Stack:** TypeScript, Postgres (use `pg-boss` for all background jobs/retries/DLQ — no Redis), Supabase/Postgres storage for attachment bytes, Anthropic Claude vision for extraction + ambiguous classification. One process runs an OAuth-callback HTTP handler + `pg-boss` workers + a CLI.
>
> **Pipeline (each a pg-boss job):** `poll` (Gmail `history.list` incremental, `gmail.readonly`, dedup on `message_id`, every 3 min) → `classify` (deterministic rules first: sender domain, subject regex for invoice|receipt|statement|payment|remittance|W-?9, has-attachment; LLM only when ambiguous) → download attachments, SHA-256 hash, store once, dedup on hash → `extract` (one Claude vision call per doc → JSON validated against a strict schema with per-field confidence + missing_fields; also handle email-body-only invoices) → `map` (resolve vendor via exact-prior-mapping then fuzzy name match, account/class/location/project via config rules; compute overall confidence = min(component) − missing penalty) → `propose` (assemble a QBO-shaped `proposed_txn` JSON with `idempotency_key = attachment sha256`, set status ready/review/exception, write to `proposals`).
>
> **Data model:** implement tables tenants, oauth_tokens (encrypted), messages (UNIQUE gmail_message_id), attachments (UNIQUE sha256 per tenant), extractions (JSONB fields + confidence + missing_fields[]), mappings, proposals (proposed_txn JSONB, confidence, status), exceptions (typed reason_code), audit_log, corrections, llm_calls; plus a `v_proposal_review` view.
>
> **Extraction fields:** vendor_name, invoice_number, invoice_date, due_date, total, tax, line_items[], payment_terms, remit_to, bank_info, job_ref, class_hint, location_hint, account_hint, doc_type, direction, per-field confidence, overall confidence, missing_fields[]. Foot-check: total must equal Σ line_items + tax or emit exception `total_mismatch`. If bank_info differs from last-seen for the vendor, tag `bank_change_warning` (do not act on it).
>
> **Exceptions (typed, never silent):** low_confidence, unknown_vendor, unmapped_account, unmapped_dimension, duplicate, missing_invoice_no, total_mismatch, no_attachment (accounting email with no file and no extractable body — in Phase 1 an exception row only; the "reply asking for the invoice" is Phase 3), bad_pdf, unsupported_file, extraction_failed, auth_failure. Transient failures (429/timeout/stale token) retry ×3 with exponential backoff via pg-boss then DLQ; business exceptions go to the `exceptions` table.
>
> **Idempotency:** re-running poll or reprocessing a message must never create duplicate messages/attachments/proposals (unique constraints + upsert). Prove it with a test.
>
> **Security:** `gmail.readonly` + QBO accounting scope used read-only (do NOT implement any QBO write/create/update method at all). Encrypt OAuth tokens at rest; never log tokens or extracted PII/bank fields; redact in logs. Confirm QBO realm via CompanyInfo on connect. Single-tenant but keep tenant_id in schema.
>
> **CLI:** poll --once, reprocess <id>, proposals --status --csv, correct <id> --field --value (records to corrections, no external write), pause, resume, lists refresh.
>
> **Tests (must pass to be "done"):** golden-file extraction accuracy; dedup (same file → one row); idempotent double-poll; foot-check exception; unknown-vendor exception; a `no_write` test asserting no QBO write method is reachable and no Gmail send/modify occurs; audit_log completeness; no secrets/PII in logs. Provide a README with runnable examples and a `.env.example`.
>
> **SwarmSync proof integration (Amendment A1 — required):** after each schema-valid extraction, submit it to Verify-API (`POST {SWARMSYNC_API_BASE}/api/verify`, bearer `SWARMSYNC_API_KEY`, `source_type: 'document'`); in the propose step, before status assignment, scan the invoice via InvoiceProof (`POST {SWARMSYNC_WEB_BASE}/api/scan/invoices`, no auth) with `vendorMaster` from QBO lists + last-seen bank details and `paymentHistory` from prior extractions; run a daily `audit_anchor` job that submits a digest of the day's audit_log rows with `source_type: 'audit_proof'`. Record every proof in a `proof_refs` table (UNIQUE per entity×product — check before submit). Gating: critical findings → exception (mapped codes), high findings → cap at `review` + `fraud_flag`, proof-call failure → `proof_scan_unavailable` + cap at `review`. **A proposal may never reach `ready` without both completed proof calls.** Never block or crash the pipeline when SwarmSync is down — degrade to review-only. Full contract in Amendment A1 below.
>
> Reference the architecture and schema in `brainstorm-output.md` §6–§10. Build the leanest thing that passes the tests. No UI, no reply-sending, no reconciliation, no QBO writes — those are later phases.

---

## W. Cost & payback

**Build effort:** ~1.5–3 focused engineering weeks for a competent TS dev (pipeline + schema + fixtures + tests). Most risk is in extraction-prompt tuning + mapping rules, not plumbing.

**Running cost (single tenant, Phase 1):** Postgres $0–25/mo (free tier likely fine) + host $0–7/mo + LLM ~a few cents/document (tens-to-low-hundreds of docs/mo = low single-digit dollars). Call it **<$40/mo** all-in for the dry-run.

**Payback:** Phase 1 **does not itself post to QuickBooks, so it saves little time on its own** — its ROI is *risk reduction + go/no-go data*, not hours. It proves whether extraction+mapping are good enough to justify Phase 2, which is where the real hours (the miskeys and late entries against the `[assumed SMB-typical]` ~3–6 min/doc baseline) get saved. **Do not quote a Phase-1 hours-saved ROI to a client** — Phase 1's deliverable is a measured accuracy number and a de-risked decision. If the dry-run shows extraction accuracy or mapping hit-rate is poor, that's a *successful* Phase 1: it stopped you building Phase 2 on a bad foundation. Recommend proceeding to Phase 2 only if the pilot agreement-rate clears the gate in Section R.

---

## X. Runbook stub (for Ben — the maintainer)

**To pause:** run `ap-hub pause`. This drains the `pg-boss` poller so no new mail is read. Nothing external is ever written even when running, so pausing is purely "stop reading new mail" — safe to do anytime, no cleanup needed.

**To run the process manually while paused:** you already have the Gmail and QuickBooks MCPs connected to your own Claude — just work the accounting inbox by hand as you do today (open the invoice, key it into QBO). The tool being paused changes nothing about the manual process, because Phase 1 never did the keying anyway; it only *proposed*. If you want to see what it *would* have proposed for recent mail, run `ap-hub poll --once` then `ap-hub proposals --status review --csv` and open the CSV — read-only, safe.

**To restart:** run `ap-hub resume`. It picks up from the last Gmail `historyId`, so it won't re-read or duplicate anything processed before the pause. If it errors on start with an auth failure, the Gmail or QuickBooks token expired — re-run the connect flow (`ap-hub connect gmail` / `ap-hub connect qbo`), confirm the QuickBooks company name it reads back is the right one, then `ap-hub resume`.

---

## AMENDMENT A1 — SwarmSync Proof Suite Integration (2026-07-11)

**Status: ACTIVE. This section extends the spec above; where it conflicts with an original section, A1 wins.**
Integrates three verification products Ben already operates on his own SwarmSync platform (repo `C:\Users\Administrator\Desktop\SwarmSync`; live API `https://api.swarmsync.ai`; web `https://swarmsync.ai`). Endpoint contracts verified against SwarmSync source 2026-07-11 (`apps/api/src/modules/verification/verify-api.controller.ts`, `packages/proof-core/src/invoice-scan.ts`).

### A1.1 Guarantee re-scope (amends §B, §N, and the `no_write` test)

Phase 1's guarantee is restated precisely: **zero QBO writes and zero Gmail sends/modifications.** Calls to the operator's own SwarmSync proof platform are permitted external calls — they never touch the books or the mailbox. The `no_write` test is mechanically unchanged (asserts no QBO write method is reachable + no Gmail send/modify occurs); it does NOT assert absence of SwarmSync HTTP calls.

### A1.2 The three integrations (what runs where)

| Product | Endpoint & payload | Auth | Pipeline point | Purpose |
|---|---|---|---|---|
| **Verify-API** | `POST {SWARMSYNC_API_BASE}/api/verify` — `{ source_type: 'document', output: <extraction JSON>, evidence: { gmail_message_id, attachment_sha256, model } }` | `Authorization: Bearer ${SWARMSYNC_API_KEY}` (`ssk_live_…`); 20 req/min | `extract` job, immediately after a schema-valid extraction persists | Independent verification of the LLM extraction: PII-leak detection, evidence-consistency checks, deterministic `detectCriticalBankChange` gate. Returns `proof_id` + chain-hashed ProofRecord. |
| **InvoiceProof** | `POST {SWARMSYNC_WEB_BASE}/api/scan/invoices` — `{ invoices: [...], vendorMaster?, paymentHistory?, poRegister? }` | none (public, rate-limited) | `propose` job, after mapping resolution, BEFORE status assignment | Independent fraud scan. Findings: `{ severity: critical\|high\|medium, pattern, detail, rows[], evidence? }` |
| **AuditProof** | `POST {SWARMSYNC_API_BASE}/api/verify` — `{ source_type: 'audit_proof', output: <audit bundle> }` (this source type exists and skips citation checks) | same Bearer key | Phase 1: daily scheduled `audit_anchor` job | Immutable chain-hashed anchor of the day's `audit_log` (row count + SHA-256 digest over the ordered rows) — tamper-evidence for the whole trail. |

InvoiceProof inputs are built from what ap-hub already has:
- `invoices[]`: one entry per extraction — vendor, invoiceNo, amount, tax, lineItemsTotal (Σ line_items), bank (from `bank_info`), vendorCity/vendorState (from `remit_to` when parseable), po (from `job_ref` when it is a PO number).
- `vendorMaster[]`: derived from the imported QBO vendor list + last-seen bank details per vendor (`bankAccountLast4`/routing when known) — this is what powers BEC/bank-change detection.
- `paymentHistory[]`: Phase 1 = prior extractions (invoiceNo, vendor, amount, submittedAt). (Phase 2 adds postings — see phase2-spec A1-P2.3.)
- `poRegister`: **omitted in v1** — PO rules (`MISSING_PO_REFERENCE`, `PO_AMOUNT_EXCEEDED`) stay inert until a real PO register exists. Do not fabricate one.

### A1.3 Gating rules (amends §L and §D step 7)

Proposal status is assigned only AFTER both proof calls for the document have completed or definitively failed:

| Proof outcome | Effect on the proposal |
|---|---|
| InvoiceProof **critical** (`EXACT_DUPLICATE`, `MODIFIED_DUPLICATE`, `RECENT_DUPLICATE_IN_PAYMENT_HISTORY`, `BANK_ACCOUNT_CHANGE_DETECTED`) | status = `exception`; mapped codes: duplicates → `duplicate`, bank change → `bank_change_warning`; `detail` carries the InvoiceProof pattern + evidence |
| InvoiceProof **high** (`PO_AMOUNT_EXCEEDED`, `MISSING_PO_REFERENCE`, `vendor_address_mismatch`, `LINE_ITEM_MATH_ERROR`) | status capped at `review`; exception `fraud_flag` recorded with the pattern; `LINE_ITEM_MATH_ERROR` also corroborates `total_mismatch` |
| InvoiceProof **medium** (`ROUND_DOLLAR_AMOUNT`) | recorded as a non-blocking flag only |
| Verify-API verdict FAILED, or its bank-change gate fires | status capped at `review`; flag recorded |
| Any proof call fails (network/5xx/timeout after pg-boss retry ×3 backoff) | exception `proof_scan_unavailable` (detail names product + call); status capped at `review`. Pipeline continues — never crashes, never silently skips. |

**Fail-safe invariant (non-negotiable): no proposal reaches `ready` without a completed InvoiceProof scan AND a completed Verify-API document verification recorded in `proof_refs`.** SwarmSync being down degrades ap-hub to review-only; it never blocks the pipeline and never lets an unscanned document auto-qualify.

### A1.4 Schema addition (amends §7-derived data model and §T migrations)

One new table covers all three products:

```sql
proof_refs(id, tenant_id, entity_kind, entity_id, product, proof_id, chain_hash,
           verdict, findings JSONB, response JSONB, created_at,
           UNIQUE (tenant_id, entity_kind, entity_id, product))
-- entity_kind: extraction | proposal | posting | audit_day
-- product:     verify_api | invoiceproof | auditproof
```

The UNIQUE constraint is the proof-call idempotency guard: workers check `proof_refs` before submitting, so job retries never double-submit a proof.

### A1.5 Env vars (amends §T)

`SWARMSYNC_API_BASE` (default `https://api.swarmsync.ai`) · `SWARMSYNC_WEB_BASE` (default `https://swarmsync.ai`) · `SWARMSYNC_API_KEY` (`ssk_live_…`; required — used by Verify-API and AuditProof; the InvoiceProof scan needs no key). The key lives in env/secret store only, never in git; extend the log-redaction helpers to cover the `ssk_` prefix.

### A1.6 Exception taxonomy additions (amends §M and brainstorm §12)

New reason codes: `fraud_flag` (InvoiceProof high-severity finding) and `proof_scan_unavailable` (a proof-product call failed after retries). Critical InvoiceProof findings map onto the existing `duplicate` / `bank_change_warning` codes per A1.3 — no parallel taxonomy.

### A1.7 Security notes (amends §N)

- Extracted invoice data (vendor names, amounts, bank fields) is transmitted over HTTPS to the operator's **own** platform. Verify-API's PII scan whitelists vendor-contact keys (`PII_WHITELIST_KEYS`).
- The public InvoiceProof endpoint keeps per-IP scan history (24h TTL) — acceptable for a single-tenant, operator-owned platform.
- The internal checks (foot-check, last-seen bank comparison) REMAIN — they are the offline layer; the proof suite is the independent second layer. Neither replaces the other.

### A1.8 Named tests (amends §Q and §U — all must pass)

- `invoiceproof_gate` — a bank-change fixture scanned via mocked InvoiceProof returns `BANK_ACCOUNT_CHANGE_DETECTED` → proposal `exception` with `bank_change_warning`; never `ready`.
- `proof_fail_safe` — SwarmSync endpoints unreachable (mocked 500s/timeouts) → pipeline completes, proposal capped at `review`, `proof_scan_unavailable` exception written; no crash, no silent skip.
- `proof_refs_recorded` — every `ready` proposal has BOTH `proof_refs` rows (invoiceproof + verify_api) with `proof_id` + `chain_hash`.
- `no_proof_dup` — re-running extract/propose jobs submits zero duplicate proofs (UNIQUE constraint + check-before-submit).
- `audit_anchor` — the daily job produces exactly one `auditproof` × `audit_day` proof_refs row containing the day's digest.
- Unit tests mock the SwarmSync client. `test:int` may use `POST /api/verify/demo` (public sandbox, per-IP monthly cap) or the live key.

### A1.9 Cost & quota

Verify-API Free tier = 500 verifications/mo (30-day retention); at SMB volume (tens–low-hundreds docs/mo, ~1 verify + 1 anchor/day) this fits comfortably — and Ben owns the platform, so entitlements can be granted (`scripts/qa/grant-proof-entitlements.mjs`) rather than paid for. InvoiceProof's scan endpoint is public/free. Budget line unchanged (<$40/mo + LLM).

### A1.10 Do NOT build (scope guard for this amendment)

- NO local re-implementation of InvoiceProof fraud rules beyond the existing internal foot-check + last-seen bank comparison.
- NO local RSA/crypto verification of proof signatures — chain verification is `GET /api/proof/:id/export/verify` (used as an integration test in Phase 2; no crypto code in ap-hub).
- NO SwarmSync SDK dependency — a thin fetch wrapper with retry/backoff and redaction, same discipline as the QBO client.
- NO hard dependency on SwarmSync availability — outage degrades to review-only per A1.3, nothing more.

### A1.11 Open question (1)

1. Exact response field names of `POST /api/verify` for `source_type: document` / `audit_proof` (the reference documents `proof_id`, `verification_status`, `confidence`; field casing must be confirmed). **Resolution action:** read the `runVerification` return shape in `verify-api.controller.ts` before writing the client in CHUNK_1. Not blocking — no money/auth/data decision rides on it.

---

*Saved: `Desktop/Ultimate Brainstorm Output/ai-accountant-hub_20260709/phase1-spec.md`. Companion to `brainstorm-output.md`. Amended 2026-07-11 (A1: SwarmSync proof suite).*
