# AI Accountant Hub — Gmail → QuickBooks Online Advanced

**Ultimate Brainstorm deliverable · 2026-07-09 · for Ben Stone**

> Method note: run as a synthesized multi-lens expert analysis (QBO-expert + automation-spec-grandmaster + mcp-grandmaster + microsoft-master + foss-scrubber lenses), not a 16-agent cloud panel. This is a well-precedented engineering problem — the panel would have converged (the skill calls this "problem is well-understood → proceed with high confidence"). Confidence labels and the strongest countercase are preserved below.

---

## 1. Executive summary

Build the leanest possible thing that survives real accounting mess: **one TypeScript service + one Postgres database + LLM vision for extraction + the two OAuth integrations (Gmail, QBO)**. Everything else in your tool list is deferred.

The durable core is smaller than it looks:

- **Postgres does four jobs**: system-of-record database, job queue (`pg-boss`), file store (large-object or Supabase Storage), and reporting warehouse (Metabase reads it). This single decision removes Redis, MinIO, a separate queue engine, and a warehouse.
- **Extraction is one LLM vision call**, not an OCR pipeline. Modern vision models read invoices/receipts/statements directly to structured JSON with per-field confidence. Tesseract/Document AI/Textract are no longer worth their setup cost for this use case. Deterministic per-vendor templates are a *learned cache on top*, not the primary path.
- **QBO writes are approve-before-post and idempotent.** Nothing posts to the general ledger without either high confidence + a rule, or a human tap. An external-ID map (email/attachment hash → QBO entity id) makes the same invoice un-double-postable. *(Correction vs. earlier wording: QBO's Accounting API has **no draft state** for Bills/Expenses/Invoices — a create posts immediately; only Estimates have `Pending`. So the staging happens in **your** proposals table, first writes go to a **sandbox company**, and reversal is per-entity void/delete. Wherever this document says "draft-first," read it as this staged-proposal model — `phase2-spec.md` is authoritative.)*
- **Gmail labels are the UI and the state machine.** `Needs-Review`, `Posted`, `Exception`, `Duplicate` labels give the business owner a familiar surface with zero custom UI on day one.

**The single best choice is Option B (below), built with the "MVP core" stack.** Option A is the first two weeks of Option B. Option C is Option B plus a reconciliation/reporting layer you bolt on later — never a rewrite.

**What kills this in real businesses is not architecture — it's the mapping problem** (which vendor is which QBO vendor, which line goes to which account/class/project) and **fraud on vendor bank-detail changes.** Design those two first; the plumbing is easy.

---

## 2. Best recommended architecture (the one to build)

```
Gmail  ──OAuth (readonly + compose/modify)──►  Ingest worker (poll every 2–5 min, historyId)
                                                     │  creates rows: messages, attachments
                                                     ▼
                                          Postgres (Supabase)
                                          ├── system of record (all tables)
                                          ├── pg-boss job queue
                                          └── file bytes (Storage / large object)
                                                     │
                    ┌────────────────────────────────┼─────────────────────────────┐
                    ▼                ▼                ▼               ▼              ▼
              classify          extract          map             post           reconcile
             (rules→LLM)     (LLM vision)   (rules→learned)  (QBO staged/live) (nightly match)
                                                     │
                                                     ▼
                                    QBO Advanced  ──OAuth2 Accounting API──►  Bills/Expenses/
                                    (approve-before-create, /batch, idempotency)  Invoices/Payments
                                                     │
                    Gmail labels (Needs-Review / Posted / Exception / Duplicate)  ◄── status sync
                    Metabase (FOSS) reads Postgres  ──►  AP/AR aging, exceptions, automation KPIs
```

One deployable unit: a Node service running an HTTP endpoint (OAuth callbacks + a thin admin page) and a set of `pg-boss` workers in the same process. One managed Postgres. That's the whole production footprint.

---

## 3. Why this is the simplest durable path

- **Fewer moving parts fail less.** Postgres-as-everything means one thing to back up, one thing to monitor, one connection string. A queue in your database inherits your DB's durability and transactions — you can enqueue the next job *in the same transaction* that writes the extracted data, which is what makes idempotency actually hold.
- **LLM vision collapses the hardest subsystem.** The classic pipeline (OCR → layout parse → field extraction → template maintenance) is where these projects rot. One structured vision call with a JSON schema replaces all of it and degrades gracefully (low confidence → exception queue, never a crash).
- **Approve-before-post is the accounting safety model, not a feature.** It matches how a bookkeeper already works, and — since QBO offers no draft state — it is enforced by *your* staging tables + sandbox-first writes + per-entity void/delete reversal.
- **It installs without consulting.** Connect Gmail → connect QBO → import lists → dry-run on last 30 days → approve → turn on by confidence. No per-business code, only per-business *config rows*.
- **Every "big" tool you listed is a later swap, not a foundation.** n8n, Temporal, Retool, MinIO, BigQuery, Superset can each replace one lean component *if and only if* that component becomes the bottleneck. None is load-bearing.

**Falsifiable if:** invoice volume exceeds ~50–100k documents/month per tenant (then Postgres-as-queue and single-process workers strain, and you'd move to a real queue + horizontal workers). For SMB reality (tens to low-thousands of docs/month) this is comfortably over-provisioned. `CONFIDENCE: HIGH`.

---

## 4. Architecture options comparison

| Dimension | **A — Simplest durable** | **B — Best practical (RECOMMENDED)** | **C — Advanced AI accountant** |
|---|---|---|---|
| Components | 1 script + Postgres | 1 service (API + workers) + Postgres + Metabase | B + reconciliation engine + BI warehouse + approval UI |
| Database | Postgres (or SQLite to start) | Postgres (Supabase/Neon) | Postgres + read replica / DuckDB for analytics |
| Storage | Postgres large object or Google Drive folder | Supabase Storage / R2 | R2 + lifecycle retention |
| Gmail | Gmail API poll, readonly + compose | Gmail API poll (historyId), readonly + modify + compose | + Pub/Sub push for near-real-time |
| QBO | Accounting API, staged-only (approve every create), no batch | Accounting API, staged+auto by confidence, `/batch`, idempotency | + webhooks for status sync, bank-feed matching |
| AI/LLM role | Extraction only | Extraction + ambiguous classification + reply drafting | + mapping suggestions, reconciliation reasoning, anomaly detection |
| Extraction | LLM vision, single call | LLM vision + learned per-vendor field cache | + confidence calibration, human-correction fine-tune loop |
| Mapping | Static config table | Config + fuzzy match + confidence + learning loop | + embeddings similarity, auto-propose new mappings |
| Reconciliation | None (manual in QBO) | Nightly bill↔payment, dup detection, missing-doc flags | + bank-feed/statement matching, vendor-statement diffing |
| Install difficulty | Low (dev sets env vars) | Medium (guided wizard) | High (needs onboarding tooling) |
| Cost/mo (1 tenant) | ~$0–25 | ~$25–75 + LLM usage | ~$100–300 + LLM usage |
| Durability | Good for one user | Good for many businesses | High, but more to maintain |
| Main failure point | No retries beyond cron; no queue | Mapping errors; OAuth token expiry | Complexity; reconciliation false matches |
| Verdict | Prototype / week 1–2 | **Ship this** | Grow into it, don't start here |

### The five stacks (required recommendation format)

**1. Best ultra-simple MVP stack** — Node/TS + Postgres (Neon free tier) + `pg-boss` + Claude vision + Gmail API + QBO API, one process. *Why it fits:* one dev, one business, working pipeline in ~2 weeks. *Costs:* ~$0–25/mo + LLM usage (~$0.01–0.05/doc). *Simplifies:* one repo, one DB, no UI (SQL view + CSV review). *Complicates:* nothing yet — review UX is spartan. *Swap later:* Postgres large-objects → R2/Supabase Storage; SQL review → Next.js admin. *Don't use yet:* Metabase, `/batch`, Pub/Sub, any workflow engine.

**2. Best FOSS/self-hosted stack** — Docker on a VPS (Coolify) + PostgreSQL + `pg-boss` + MinIO + Metabase; extraction via self-hosted VLM (e.g. Qwen-VL) or Docling+rules if a hard no-cloud rule exists. *Why it fits:* data never leaves your box; zero license cost. *Costs:* $10–40/mo VPS + your ops time (the real cost). *Simplifies:* compliance/data-residency conversations. *Complicates:* you own backups, upgrades, uptime; fully-FOSS extraction is markedly worse than frontier vision models — expect more exceptions. *Swap later:* VLM → Claude when accuracy pain exceeds privacy concern. *Don't use yet:* n8n/Temporal — same verdict as everywhere else.

**3. Best hybrid business stack (RECOMMENDED — this is Option B)** — managed Postgres (Supabase) + one Node service on Render/Fly/Railway/Cloud Run + Claude vision + Supabase Storage + Metabase in Phase 4. *Why it fits:* managed durability where it matters (DB), FOSS where it's free (queue, BI), paid only where it collapses complexity (extraction). *Costs:* ~$25–75/mo + LLM. *Simplifies:* no ops burden, best-in-class extraction, one deployable. *Complicates:* two cloud vendors + Anthropic. *Swap later:* everything is behind interfaces — storage, BI, even the model. *Don't use yet:* Temporal, Retool, BigQuery.

**4. Best fast-build stack (demo in days, not the product)** — n8n (or Windmill) + Gmail node + Claude + the QBO/Gmail MCPs you already have connected, to hand-prototype extraction→mapping on real mail. *Why it fits:* proves the extraction/mapping quality question (the actual risk) before any service code. *Costs:* ~$0 (self-host n8n) or existing subscriptions. *Simplifies:* zero-code validation of the crux. *Complicates:* nothing durable — flows are not auditable financial infrastructure. *Swap later:* discard entirely; the learnings move into the Node service. *Don't use yet — ever, for production:* the money path never runs through a flow engine.

**5. Best long-term scalable stack (Option C direction)** — stack 3 + R2 with lifecycle retention + read replica (or DuckDB) for analytics + QBO webhooks + Gmail Pub/Sub + approval UI; Temporal only if genuinely long-running multi-step workflows emerge. *Why it fits:* every piece is an *addition* to stack 3, never a rewrite. *Costs:* ~$100–300/mo + LLM. *Simplifies:* scale headroom, near-real-time. *Complicates:* more components to monitor — adopt each only when its bottleneck is measured. *Swap later:* n/a — this is the destination. *Don't use yet:* all of it; start at stack 3.

---

## 5. End-to-end workflow

1. **Received** — poll Gmail (`history.list` from last `historyId`); for each new message in the watched label/inbox, insert `messages` row (dedup on Gmail `message_id`). Enqueue `classify`.
2. **Classified** — deterministic rules first (sender domain in vendor list, subject regex `invoice|receipt|statement|payment|remittance|W-?9`, has PDF/image attachment). Ambiguous → one LLM classification call. Write `doc_type` + `direction (AP/AR)` + `needs_review` flag.
3. **Attachment saved** — download each attachment, SHA-256 hash it, store bytes once (hash = filename), link to message. Duplicate hash → mark `duplicate`, skip extraction. Enqueue `extract`.
4. **Extracted** — LLM vision call returns the structured field set (§ below) with per-field confidence + `missing_fields`. Write `extractions` row.
5. **Mapped** — resolve vendor/customer/account/class/location/project via mapping engine → proposed QBO transaction JSON + overall `confidence`.
6. **Ready to post / Exception** — if `confidence ≥ threshold` and no red flags → `ready`. Else → `exception` with a typed reason.
7. **Posted** — create the QBO transaction (sandbox first, production only per policy after approval — QBO has no draft state, see §9) with an idempotency key = attachment hash. Attach source PDF to the QBO transaction. Store returned QBO id in the external-ID map.
8. **Synced** — poll/read QBO to confirm the transaction exists and matches; label the Gmail thread `Posted`.
9. **Reconciled** — nightly job matches bills↔bill-payments, flags unpaid/overdue, missing-doc, and statement mismatches.
10. **Reply (optional, gated)** — if a rule fires (missing invoice #, need W-9, duplicate, payment confirmation), draft a Gmail reply. Auto-send only whitelisted low-risk templates; everything else waits in Drafts.
11. **Audit** — every state transition and every external call writes an `audit_log` row (actor, action, entity, before/after hash, timestamp).

### Extraction field schema (the structured field set referenced in step 4 and §17)

One LLM-vision call returns strict JSON validated against this schema — invalid output is retried, never stored raw:

| Field | Type | Notes |
|---|---|---|
| `vendor_name` | string | as printed on the document |
| `invoice_number` | string\|null | missing → `missing_invoice_no` path |
| `invoice_date`, `due_date` | ISO date\|null | |
| `total`, `tax` | decimal | foot-check: `total == Σ line_items + tax` else `total_mismatch` |
| `line_items[]` | `{description, qty, unit_price, amount, account_hint}` | |
| `payment_terms` | string\|null | Net 30 etc. — drives Bill vs Expense |
| `remit_to` | address\|null | |
| `bank_info` | object\|null | routing/account/pay-to; change vs last-seen → `bank_change_warning` (never auto-applied) |
| `job_ref`, `class_hint`, `location_hint`, `account_hint` | string\|null | feed the mapping resolver (customer/project/job, class, location, account/category) |
| `doc_type` | enum | invoice / receipt / statement / payment_confirmation / w9 / other |
| `direction` | enum | AP / AR |
| per-field `confidence` | 0–1 each | overall = min(components) − missing-required penalty |
| `missing_fields[]` | string[] | drives typed exceptions |

Statements (incl. CSV attachments) go through the same call with a multi-document result; each listed invoice becomes its own proposal. Lifecycle statuses a document can end in: `ready → approved → posted` (or `posted_sandbox`), `review`, `exception`, `rejected` (human declined — kept for the learning loop), `duplicate`.

---

## 6. Required components

| Component | Choice | Why |
|---|---|---|
| Runtime/language | **TypeScript / Node 20+** | Best-maintained Gmail + Intuit SDKs; one language end to end |
| Database | **Postgres** (Supabase or Neon) | SoR + queue + reporting in one |
| Queue / jobs | **pg-boss** (Postgres-backed) | Durable, transactional-enqueue, retries, backoff, DLQ — no Redis |
| File storage | **Supabase Storage** (or Cloudflare R2) | Cheap, S3-compatible, keep bytes out of the DB when large |
| Extraction | **LLM vision (Claude)** + structured output | Collapses the OCR pipeline; per-field confidence |
| Classification | Rules → LLM fallback | Deterministic first, cheap |
| Admin surface | **Gmail labels** (v1) → tiny **Next.js** admin (v2) | Zero-UI start; custom beats Retool for a focused queue |
| Reporting/BI | **Metabase** (FOSS) on Postgres | AP/AR aging, exceptions, KPIs; QBO also has native aging |
| Secrets | Encrypted columns + host secret manager | OAuth tokens encrypted at rest |
| Hosting | **Render / Fly.io / Railway / Cloud Run** + managed Postgres | One container, one DB; Docker-portable (Cloud Run fits if you're already GCP — min-instances 1 so the poller never cold-stops) |
| Auth | Google OAuth2 + Intuit OAuth2 | The only two identities that matter |

**Deliberately absent:** n8n, Windmill, Temporal, Inngest, Trigger.dev, BullMQ, Retool, Appsmith, ToolJet, Budibase, MinIO, BigQuery, Superset, Looker, Firebase. See §16.

---

## 7. Database / schema recommendation

Minimum durable set (Postgres):

```sql
tenants(id, name, gmail_email, qbo_realm_id, created_at)

oauth_tokens(id, tenant_id, provider, access_token_enc, refresh_token_enc,
             expires_at, scope, updated_at)              -- encrypted at rest

messages(id, tenant_id, gmail_message_id UNIQUE, thread_id, from_addr,
         subject, received_at, doc_type, direction, status, needs_review, created_at)

attachments(id, message_id, filename, mime, sha256 UNIQUE_per_tenant,
            storage_key, size, is_duplicate, created_at)

extractions(id, attachment_id, fields JSONB, confidence NUMERIC,
            missing_fields TEXT[], model, created_at)

mappings(id, tenant_id, kind, source_key, target_qbo_type, target_qbo_id,
         confidence, learned_from, updated_at)           -- vendor/customer/account/class/etc.

proposals(id, tenant_id, attachment_id UNIQUE, extraction_id, proposed_txn JSONB,
          confidence NUMERIC, status, flags TEXT[], created_at)
          -- status: ready|review|exception|approved|rejected|posted_sandbox|posted
          -- the Phase-1 dry-run output; postings only exist once something is created

postings(id, tenant_id, attachment_id, proposal_id, qbo_type, qbo_id, sync_token,
         realm, idempotency_key UNIQUE, mode, status,
         request JSONB, response JSONB, posted_at)

exceptions(id, tenant_id, entity_ref, reason_code, detail, status,
           resolved_by, resolution JSONB, created_at, resolved_at)

reconciliation(id, tenant_id, kind, left_ref, right_ref, match_status,
               variance, created_at)

audit_log(id, tenant_id, actor, action, entity, before_hash, after_hash,
          detail JSONB, at)

corrections(id, tenant_id, exception_id, field, old_value, new_value,
            became_rule BOOLEAN, at)                     -- the learning loop feedstock

llm_calls(id, tenant_id, purpose, model, latency_ms, cost, confidence, created_at)
          -- one row per model call: extraction cost/accuracy is the metric that gates phases

-- v_proposal_review: human-readable view joining proposals + extractions + attachments
-- (source-doc link, fields, confidences, proposed vendor/account/class, flags) — the
-- Phase-1 review surface, exported to CSV by the CLI.

-- pg-boss creates its own `job` schema. That's your queue + DLQ.
```

Design notes: `attachments.sha256` is your duplicate guard. `postings.idempotency_key` is your double-post guard. `mappings` + `corrections` are the whole learning loop. Keep `fields` and `request/response` as JSONB so the schema never blocks a new field. `CONFIDENCE: HIGH`.

---

## 8. Gmail design

- **Connect method:** Gmail API (never IMAP, never browser automation).
- **Scopes (least privilege):** start read-only + drafting: `gmail.readonly` + `gmail.compose`. To apply labels you need `gmail.modify` (which supersedes readonly). To auto-send you need `gmail.send`. **Recommended production set:** `gmail.modify` (read + label) + `gmail.compose` (drafts) and add `gmail.send` **only** when the business opts into auto-reply. Avoid full `https://mail.google.com/`.
- **Ingestion:** poll on a 2–5 min cron using `users.history.list` with the stored `historyId` — cheap, incremental, no missed mail. Add Gmail **Pub/Sub push** later only if you need sub-minute latency (you don't, for accounting).
- **Watched surface:** a specific label (e.g. `AP-Inbox`) or a filter, chosen in the wizard — not the whole mailbox. Gmail filters can auto-apply the label so the owner routes mail naturally.
- **Dedup:** unique on Gmail `message_id`; attachments dedup on SHA-256. Reprocessing a thread never re-posts.
- **Threading:** store `thread_id`; replies go on-thread so vendors see continuity.
- **Drafts vs send:** see §12/replies. Default draft; auto-send a short whitelist.

---

## 9. QBO design (Advanced)

- **Connect:** Intuit OAuth2 authorization-code flow; store `access_token` + `refresh_token` + `realmId` together, encrypted. **Persist the rotated refresh token every refresh** (Intuit rotates them). Pin a tested `minorversion` on every call.
- **Category discipline** (this is where wrong choices distort the books):
  - **Bill** = money owed, paid later (AP aging). **Expense/Purchase** = paid now. Pick per vendor terms, never guess by default.
  - **Invoice** = AR to be paid. **Sales Receipt** = paid immediately.
  - **Never use Journal Entries** as the default — they bypass AP/AR subledgers and break aging/reconciliation. JEs only for true adjustments.
- **What posts automatically vs. exception review:**
  - **Auto (high confidence, sandbox or live per policy):** known vendor, known account/class mapping, invoice # present, totals internally consistent, not a duplicate, amount under the auto-post threshold.
  - **Always exception (never auto):** new/unknown vendor; **any vendor bank/remit detail change** (fraud gate); amount over threshold; totals don't foot; missing invoice #; low extraction confidence; unmapped class/location/project; W-9 missing for a 1099 vendor.
- **Reality check on "drafts":** the Accounting API has **no draft state** for Bills/Expenses/Invoices — a create posts to the ledger immediately (only Estimates have `Pending`). So "staged/approve-before-post" here means: the proposal lives in *your* `proposals`/`postings` tables until approved, first writes target a **sandbox company** (Phase 2), and reversal is per-entity void/delete. `CONFIDENCE: HIGH`.
- **Writes:** create only approved/gated proposals; attach the source PDF via the `Attachable` entity; use `/batch` for multi-invoice vendor statements; idempotency key = attachment hash checked against `postings` before every create. Bill **payments**, customer **payments**, and **deposits** are read/matched in Phase 4 reconciliation; *creating* them via API is deliberately out of scope until then (money-movement posting needs its own gate design).
- **Duplicate detection (two layers):** your own hash/idempotency map *before* the call, plus a QBO query on (vendor, docnumber, amount, date) to catch invoices that arrived by two channels.
- **Status sync:** after create, read the entity back (or subscribe to QBO webhooks later) to confirm and to catch human edits made directly in QBO.
- **Reality check on the API:** QBO has **no clean "reconcile" API** — bank reconciliation is a UI action. You can *read* transactions, bank-feed items (limited), and aging reports and do your **own** matching, then surface exceptions; you cannot programmatically "check off" a reconciliation. Plan reconciliation as *your* matching layer that produces a worklist, not as driving QBO's reconcile screen. `CONFIDENCE: HIGH`.
- **Not available via API (route to exception, don't invent):** merging duplicate vendors, deleting a company, changing fiscal year, true bulk-undo. Reversal is per-entity (void/delete or correcting entry).

*(You already have the Intuit QuickBooks MCP + Gmail MCP connected to your own Claude — use those to prototype extraction→proposal flows by hand before writing a line of the service. That de-risks the mapping design for free. For a deployable product, the service owns its own OAuth; the MCPs are a scouting tool, not the runtime.)*

---

## 10. Mapping engine design (the critical part)

Treat mapping as a **resolver with a confidence score and a learning loop**, backed by the `mappings` table.

**What it resolves, in order of certainty:**
1. **Vendor → QBO Vendor** — exact match on prior mapping (sender domain or vendor name) → fuzzy match against QBO vendor list (normalized name, Levenshtein/token overlap) → else exception "unknown vendor."
2. **Document → transaction type** — rule by vendor + direction (this vendor's docs are Bills; this customer's are Invoices).
3. **Line item → account or product/service** — per-vendor default account first; keyword rules on line text; else exception.
4. **Project/property/job → Class / Location / Project** — per-vendor or per-keyword default; for real-estate, your convention (e.g. Class = entity/project, Location = physical property) lives as config, applied consistently.
5. **Payment method → QBO account**; **tax handling**; **reimbursable/billable** flag; **intercompany/owner** transactions → these are policy rules per tenant, and anything owner/intercompany is an **exception by default** (judgment territory).

**Confidence model:** overall confidence = min of the resolved-component confidences, penalized by missing required fields. Two thresholds per tenant: `auto_post` (e.g. 0.9) and `review` (e.g. 0.6). Below review → exception; between → held for human tap; above → auto.

**Learning loop:** every human correction on an exception writes a `corrections` row. A correction that resolves an *unknown vendor* or *unmapped account* is offered as a new `mappings` rule ("always map invoices from billing@acme.com → Vendor Acme, account 6010 Subcontractors — apply going forward?"). Approved → `mappings` row with `learned_from = correction`. Result: the same mistake is never made twice ("fix once, learn forever"). Keep it rule-based and explainable first; add embeddings-based vendor similarity only if fuzzy string matching proves insufficient. `CONFIDENCE: MEDIUM` (fuzzy matching quality is the empirical risk — validate on real vendor lists).

---

## 11. Reconciliation design

Be realistic: QBO won't let you drive its reconcile screen via API, so build a **matching + worklist** layer, not a "push reconciliation" layer.

Nightly job produces exceptions for:
- **Bill ↔ Bill Payment** unmatched (open bills, payments with no bill).
- **Duplicate transactions** (same vendor + docnumber + amount within a date window; also your hash map).
- **Unpaid / overdue bills** (from AP aging read).
- **Missing invoice** — a vendor you normally receive N invoices/month from went quiet (statement-vs-received gap).
- **Vendor statement mismatch** — parse a vendor statement (LLM vision, multi-invoice), diff its line list against posted bills; flag missing/extra.
- **Customer payment ↔ Deposit** matching for AR.
- **Payment with no source document** — a posted expense/bill with no attached PDF.

Each produces an `exceptions` row + a Metabase view. The human clears it; clearing feeds the learning loop where applicable. `CONFIDENCE: MEDIUM` — statement diffing is the hardest and should ship last.

---

## 12. Exception queue design

Every exception is a typed, actionable row with a "fix once" path.

| Reason code | Trigger | Fix-once path |
|---|---|---|
| `low_confidence` | extraction/mapping below review threshold | human corrects fields → optional new rule |
| `unknown_vendor` | no vendor match | create/link QBO vendor → mapping rule |
| `unmapped_account` | line has no account | pick account → per-vendor default rule |
| `unmapped_dimension` | class/location/project missing | pick → keyword/vendor rule |
| `duplicate` | hash or (vendor,docno,amount) match | confirm dup → skip; or override |
| `missing_invoice_no` | field absent | request from vendor (reply) or enter manually |
| `total_mismatch` | lines don't foot to total | correct → post |
| `no_attachment` | accounting email, no file | reply asking for the invoice |
| `bad_pdf` / `unsupported_file` | unreadable/corrupt | request resend |
| `bank_change_warning` | vendor bank/remit detail changed | **hard stop**, verify out-of-band, human approves |
| `qbo_api_error` | 6190 dup / stale SyncToken / 429 | auto-retry w/ backoff; if persists, surface |
| `auth_failure` | token expired/revoked | reconnect prompt; pause that tenant's jobs |

Reasons map to `pg-boss` behavior: transient (429, stale token) auto-retry with backoff → DLQ after N; business exceptions go straight to the queue for a human. **No silent failures** — every exception is visible and every automated step has detection → notification → manual fallback.

---

## 13. Security / control design

- **OAuth tokens:** encrypted at rest (KMS-backed column or host secret manager); never logged, even at debug. Rotate/persist refresh tokens.
- **Least-privilege scopes:** derive from the actual actions (see §8); no `mail.google.com/` full scope; QBO accounting scope only.
- **The fraud gate (non-negotiable):** **never auto-apply a vendor bank/remit-detail change.** Any email or invoice that changes payment routing → `bank_change_warning` hard stop, verified out-of-band (call the vendor on a known number), human approval logged. This is the #1 real-world loss vector (business email compromise). `CONFIDENCE: HIGH`.
- **Approval thresholds:** dollar ceilings for auto-post; above → human. Configurable per tenant.
- **Approve-before-post ledger writes:** nothing GL-affecting is created until approved (QBO has no draft state — see §9); reversal is per-entity void/delete, audited. Tenants may enable auto-post only with the full guardrail stack: dry-run, confirm, idempotency, audit, reversal.
- **Roles/permissions (when a second human exists):** three roles are enough — *owner* (connect accounts, change thresholds/rules, approve bank-change exceptions), *bookkeeper* (clear exceptions, approve/correct proposals), *viewer* (read-only reports). Single-tenant v1 can hard-code owner; keep the role column in `tenants`/audit so it's config later, not a rewrite.
- **Backups:** Postgres is the only stateful thing — use the managed provider's PITR/daily snapshots and periodically test a restore; attachment bytes in Storage/R2 get bucket versioning. Verify restore before Phase 3 go-live.
- **Never auto-send sensitive info** (bank details, SSN/EIN, totals) in replies unless explicitly whitelisted.
- **Audit everything:** `audit_log` row per transition/API call with actor, entity, before/after hash, timestamp; retained per the tenant's tax/audit requirement.
- **Rollback/reversal:** a per-entity void/delete tool (with its own audit trail) — never bulk destructive ops.
- **Tenancy:** **single-tenant per business by default** (own DB/instance or strong row-level isolation) — cleanest security blast radius and simplest to reason about; go multi-tenant only when operational cost forces it.
- **Webhook verification** (if you add QBO/Gmail push later): verify signatures before trusting any payload; confirm `realmId`.

---

## 14. Install wizard design

Ten steps, no consulting:

1. **Connect Gmail** (OAuth, `modify` + `compose`).
2. **Connect QBO** (OAuth; confirm the *company name* read back from `CompanyInfo` matches — guard against sandbox/prod and wrong-realm mistakes).
3. **Pick the watched label/inbox** (or create a Gmail filter that applies it).
4. **Import QBO lists** — chart of accounts, vendors, customers, classes, locations, projects, items → seed `mappings` candidates.
5. **Mapping wizard** — for the top N recurring senders, propose vendor + account + dimension mappings; human confirms. (Front-load the 20% of vendors that are 80% of volume.)
6. **Dry-run on last 30 days** — read-only, produce proposed postings, no writes.
7. **Show proposed postings** — a review table: what would post, where, confidence.
8. **User approves / corrects** — corrections seed rules.
9. **Turn on by confidence** — choose thresholds; start in **propose-only** mode (nothing created), graduate to auto-post per vendor as trust builds.
10. **Monitor the exception queue** — Gmail labels + Metabase.

Success criterion: a non-technical owner gets from zero to a working dry-run in under 30 minutes with no developer.

---

## 15. Phased build plan

**Phase 1 — Dry-run PoC (no QBO writes).** Build: Gmail poll, classify (rules→LLM), attachment download+hash+store, LLM-vision extraction, mapping resolver, proposed-posting JSON, `messages/attachments/extractions/mappings` tables, `pg-boss`. *Don't build:* any QBO write, custom UI (use logs/labels), reconciliation, replies. **Success:** on your real last-30-days mail, ≥90% of invoices classified right and extracted with correct total/vendor/date; every proposed posting inspectable. **Tests:** golden-file extraction fixtures; duplicate-hash test; unknown-vendor → exception. **Complexity: M. Risk:** extraction accuracy on messy vendors — measure it now.

**Phase 2 — Controlled posting (QBO sandbox/test co).** Build: QBO OAuth, sandbox transaction creation (approve-before-create — QBO has no draft state), `Attachable` PDF attach, idempotency map, `postings` table, `/batch`. *Don't build:* auto-post to production, the reconciliation matching engine (a thin proposal-vs-created diff log is allowed — it's the verify step, not reconciliation). **Success:** high-confidence items create correct QBO transactions in sandbox; re-running never duplicates; source PDF attached. **Tests:** idempotency (double-run = one transaction); stale SyncToken/6190 handling; dry-run never mutates. **Complexity: M. Risk:** category/account mapping correctness — validate with a CPA on sandbox output.

**Phase 3 — Production, approval-by-exception.** Build: real-company OAuth with confirm-realm check, exception queue + tiny Next.js admin, auto-post by confidence threshold, the fraud/bank-change gate, gated Gmail replies (drafts + whitelist auto-send), audit log, token-refresh + reconnect flow, **and the §14 install wizard** (CLI-first; it's mostly the connect/import/dry-run steps Phases 1–2 already built, packaged as a guided flow). *Don't build:* full reconciliation, BI beyond basics. **Success:** safe items auto-post per policy (approved-then-created); everything else waits as a typed exception; zero double-posts; zero auto-applied bank changes. **Tests:** fraud gate blocks a bank-change email; over-threshold → exception; auth-revoke pauses tenant. **Complexity: M–H. Risk:** trust calibration — start propose-only (nothing auto-created), widen slowly.

**Phase 4 — Reconciliation + AI accountant dashboard.** Build: nightly matching (bill↔payment, dup, unpaid, missing-invoice), vendor-statement diffing, Metabase dashboards (AP/AR aging, vendor spend, exceptions, automation KPIs), learning-loop rule promotion UI. **Success:** reconciliation worklist that a bookkeeper actually clears faster than manual. **Tests:** seeded mismatches surface; false-match rate measured. **Complexity: H. Risk:** statement diffing false positives — ship it last, tune thresholds.

---

## 16. What to avoid building (FOSS-scrubber verdicts)

Compact cards for the five decisive tools first; then the full required-format comparison covering every tool from the original list; then the accounting-specific build/buy/defer survey.

**pg-boss** — Category: queue/jobs · FOSS: fully open (MIT) · Self-hostable: yes (it's a library on your Postgres) · Fit: 10 · Maturity: high · Setup: trivial · Best use: all background jobs, retries, DLQ, backoff · Replaces: Redis+BullMQ / Temporal / Inngest · Downside: not for >~100k jobs/min · **Recommendation: Use now.**

**LLM vision (Claude) for extraction** — Category: OCR/extraction · Proprietary API (usage-priced) · Self-hostable: no · Fit: 10 · Maturity: high · Setup: trivial · Best use: invoices/receipts/statements → structured JSON + confidence · Replaces: Tesseract, Document AI, Textract, Azure Form Recognizer, LlamaParse, Docling, Unstructured, Marker · Downside: per-doc cost; needs confidence-gating · **Recommendation: Use now — this is the saves-enough-time-to-justify-cost call.**

**Postgres (Supabase / Neon)** — Category: DB/backend · Open core (Postgres is fully FOSS; Supabase/Neon add hosting) · Self-hostable: yes · Fit: 10 · Setup: easy · Best use: SoR + queue + storage + reporting source · Replaces: Firebase, BigQuery, separate warehouse, SQLite-at-scale · Downside: none material for this scale · **Recommendation: Use now.**

**Metabase** — Category: BI · Open core (AGPL core, paid enterprise) · Self-hostable: yes · Fit: 9 · Setup: easy (Docker) · Best use: AP/AR aging, exceptions, KPIs on Postgres · Replaces: Superset, Lightdash, Looker, Power BI · Downside: heavier than needed at PoC · **Recommendation: Use later (Phase 4); QBO's native aging covers early needs.**

**Cloudflare R2 / Supabase Storage** — Category: storage · Proprietary/open-core, cheap · Self-hostable: R2 no, Supabase yes · Fit: 9 · Best use: attachment bytes, source-doc retention · Replaces: MinIO, S3, Google Drive-as-store · Downside: another credential · **Recommendation: Use now (or start with Postgres large objects; swap later).**

**Full comparison — every tool from the required list, in the required per-tool format** (Fit is 0–10 for *this* project; FOSS status: Fully FOSS / Open-core / Fair-code / Proprietary):

| Tool | Category | License / FOSS status | Self-host | Fit | Maturity | Setup | Best use | What it replaces | Main downside | Recommendation |
|---|---|---|---|---|---|---|---|---|---|---|
| PostgreSQL | database | PostgreSQL License / Fully FOSS | yes | 10 | very high | easy | SoR + queue + reporting source | Firebase, warehouse, Redis | none at this scale | **Use now** |
| Supabase | DB hosting/backend | Apache 2.0 / Open-core | yes | 9 | high | easy | managed Postgres + Storage + auth-later | separate DB + S3 + auth | hosted-tier coupling | **Use now** (or Neon) |
| pg-boss | queue/jobs | MIT / Fully FOSS | yes (library) | 10 | high | trivial | jobs, retries, backoff, DLQ | Redis+BullMQ, Temporal, Inngest | not for >100k jobs/min | **Use now** |
| n8n | workflow engine | Sustainable Use / **Fair-code, not OSI-FOSS** | yes | 5 | high | easy | glue demos, prototyping the crux | Zapier/Make | flows aren't auditable financial infra; license | **Hybrid only** (prototype, then discard) |
| Windmill | scripts/flows/apps | AGPLv3 / Open-core | yes | 6 | medium-high | medium | FOSS scripts+UI host | n8n + bits of Retool | an extra layer over one Node service | Use later, maybe |
| Make | workflow SaaS | Proprietary | no | 3 | high | easy | personal glue | custom scripts | per-op cost, opaque failures, lock-in | **Avoid** |
| Temporal | durable workflows | MIT core / Open-core | yes | 4 | high | hard | long multi-step sagas at scale | pg-boss (at 100× volume) | heavy ops footprint | Overkill — later only if measured |
| BullMQ | queue | MIT (needs Redis) / Fully FOSS lib | yes | 5 | high | easy | Redis-backed jobs | pg-boss | adds Redis for nothing | Replace-later only |
| Inngest | event functions | Open-core (SaaS-first) | partial | 4 | medium | easy | event-driven steps | pg-boss | new platform dependency | Do not use yet |
| Trigger.dev | background jobs | Apache 2.0 / Open-core | yes | 4 | medium | easy | background jobs, nice DX | pg-boss | another platform | Do not use yet |
| Retool | internal UI | Proprietary | paid option | 4 | high | easy | fast internal CRUD | custom admin | lock-in, per-seat; queue page is tiny anyway | **Avoid** (Next.js page in Phase 3) |
| Appsmith | internal UI | Apache 2.0 / Open-core | yes | 5 | high | medium | FOSS internal apps | Retool | heavier than one queue page needs | Use later, maybe |
| Metabase | BI | AGPL core / Open-core | yes | 9 | high | easy | AP/AR aging, exception KPIs | Superset, Lightdash, Looker | heavier than PoC needs | **Use later** (Phase 4) |
| Lightdash | BI (dbt-based) | MIT / Fully FOSS | yes | 5 | medium | medium | BI if you already model in dbt | Looker | requires a dbt layer you don't have | Avoid for this |
| Apache Superset | BI | Apache 2.0 / Fully FOSS | yes | 6 | high | med-hard | big-org self-host BI | Tableau-class | enterprise weight for SMB books | Avoid — Metabase wins |
| Looker Studio | BI (free) | Proprietary (free) | no | 4 | high | easy | quick dashboards on Google sources | nothing here | flaky Postgres connector, weak alerting, no self-host | **Avoid** — Metabase covers it |
| Looker | BI (enterprise) | Proprietary | no | 2 | high | hard | enterprise semantic layer | — | cost + weight | Avoid |
| Power BI | BI | Proprietary | no | 3 | high | medium | Microsoft-shop reporting | — | licensing, Windows-centric | Avoid |
| BigQuery | warehouse | Proprietary (usage) | no | 3 | high | easy | TB-scale analytics | Postgres-as-warehouse | overkill + egress cost | Do not use yet |
| Google Drive | file storage | Proprietary (free tier) | no | 5 | high | trivial | human-browsable doc archive / Option A file store | R2/Storage for v0 | no hash-keyed dedup, weak object-store semantics | **Hybrid only** — OK for Option A or as a human mirror, not the system store |
| Cloudflare R2 | object storage | Proprietary (cheap) | no | 9 | high | easy | attachment bytes + retention | MinIO, S3, Drive-as-store | another credential | Use now (or Supabase Storage) |
| MinIO | object storage | AGPLv3 / Fully FOSS | yes | 5 | high | medium | self-hosted S3 | R2/S3 | ops you don't need | Do not use yet |
| Google Document AI | doc extraction | Proprietary (usage) | no | 5 | high | medium | pretrained invoice parser at high volume | custom OCR pipeline | per-doc cost + setup; worse than LLM vision on messy variety | Replace-later only |
| Tesseract | OCR | Apache 2.0 / Fully FOSS | yes | 2 | high | medium | raw text from clean scans | — | no layout understanding → template hell | **Avoid** |
| Docling | PDF parsing | MIT / Fully FOSS | yes | 5 | medium | easy | bulk PDF→structured corpora | Unstructured (partly) | single-invoice flow doesn't need it | Use later, maybe |
| Unstructured | doc ETL | Apache 2.0 / Open-core | yes | 4 | medium | medium | bulk ingestion for RAG | — | heavy dependency | Use later, maybe |

**Verdict table (adjacent tools also considered):**

| Tool | Verdict | One-line reason |
|---|---|---|
| Zapier / Pipedream | Avoid | Same class as Make: per-task cost, opaque failures, lock-in |
| Node-RED | Avoid | Not for financial-grade auditability |
| ToolJet / Budibase | Later, maybe | FOSS Retool alternatives; more than a single queue page needs |
| MotherDuck / DuckDB | Do not use yet | DuckDB only if analytics outgrows Postgres |
| Textract / Azure Form Recognizer | Replace-later only | Same verdict as Document AI |
| PaddleOCR | Avoid | Raw OCR = template hell |
| LlamaParse / Marker | Later, maybe | Bulk-corpus tools; not needed per-invoice |
| Firebase | Avoid | Wrong data model for relational accounting + audit |
| Clerk / WorkOS / Auth.js / Supabase Auth | Later | You need Google+Intuit OAuth, not an identity product, until a real multi-user admin exists |
| Coolify / Docker-on-VPS | Optional | Fine if self-hosting; Render/Fly/Railway/Cloud Run is less ops |
| Vercel (for workers) | Avoid for workers | Serverless can't run long pollers/queues; fine for the admin UI only |

### Accounting-specific capabilities: build vs. buy vs. defer

The original scope asked where FOSS/paid products cover the accounting-specific ground. Verdicts:

| Capability | Off-the-shelf | FOSS option | Verdict for this build |
|---|---|---|---|
| Bank import / feeds | **QBO native bank feeds**; Plaid (paid API) | none credible for QBO | **Buy (already own it)** — never rebuild bank feeds; Phase 4 only *reads* them for matching |
| Receipt/invoice capture | **QBO native capture**, Dext, Hubdoc, Bill.com | Paperless-ngx (capture/archive only, no QBO sync) | **Test first** — this is the two-week gap test; our pipeline exists for what native capture *misses* |
| Payment execution / rails | Bill.com, Ramp, Melio (ACH, approvals, positive pay) | none | **Rent, never build** — we post Bills; paying them stays in QBO/rails products |
| Payment ↔ bill matching | QBO native match suggestions | none for QBO | **Build thin (Phase 4)** — read-only matching worklist, our differentiator |
| AP/AR approval workflow | **QBO Advanced native approval workflows**; Bill.com class | Camunda-class BPM (overkill) | **Build ours** — the exception queue + thresholds *is* the approval workflow; QBO Advanced approvals as a backstop |
| Vendor onboarding / W-9 / 1099 | QBO 1099 wizard, Track1099/Tax1099 | none meaningful | **Build detection only** — missing-W-9 exception + Phase 3 reply template; filing stays in QBO/Track1099 |
| Fraud detection (bank-change) | positive-pay features in paid AP suites | none | **Build (mandatory, cheap)** — the hard-stop gate, §13 |
| Retention / archival | — | Paperless-ngx; object-storage lifecycle rules | **Config, not code** — R2/Storage lifecycle + audit retention setting (Phase 4) |

---

## 17. Final "build this first" checklist

- [ ] Postgres up (Supabase/Neon); schema from §7 migrated.
- [ ] `pg-boss` wired; one worker process; DLQ visible.
- [ ] Gmail OAuth (`modify` + `compose`); `history.list` poller every 2–5 min; dedup on `message_id`.
- [ ] Attachment download → SHA-256 → store once → duplicate guard.
- [ ] LLM-vision extraction to the §Extraction field schema, with per-field confidence + `missing_fields`.
- [ ] Rules-first classifier with LLM fallback.
- [ ] Mapping resolver + `mappings`/`corrections` tables + two confidence thresholds.
- [ ] **Dry-run mode that writes nothing** — proposed postings inspectable.
- [ ] QBO OAuth with **confirm-realm** read-back; token refresh + rotation persistence.
- [ ] QBO **sandbox** create (approve-before-post — no draft state exists) + `Attachable` PDF + idempotency key = attachment hash.
- [ ] The **bank-change fraud gate** (hard stop) before any of the above goes live.
- [ ] `audit_log` on every transition and external call.
- [ ] Gmail status labels (Needs-Review / Posted / Exception / Duplicate).
- [ ] Exception queue with typed reasons; auto-retry transient, human for business exceptions.
- [ ] Manual fallback documented (pause tenant, process by hand, restart).

---

## 18. Questions that must be answered before coding

1. **Single business or product for many?** (Your MCPs suggest you personally; the prompt says "any business.") This decides tenancy + wizard investment. **Recommend:** build single-tenant, keep tenant_id in schema so multi-tenant is a later config, not a rewrite.
2. **Which QBO editions/regions?** US-only simplifies tax; multi-region changes tax + COA handling.
3. **Real estate / construction focus?** (ProofRail implies yes.) If so, Class/Location/Project conventions and construction-draw workflows deserve first-class mapping rules — and reconciliation should include draw-vs-budget.
4. **Auto-post appetite:** does any business want live auto-posting, or is approve-first-forever acceptable? Approve-first is safer and simpler; auto-post needs the full guardrail stack.
5. **Reply auto-send policy:** which templates (if any) may send without a human? Recommend: only "invoice received" confirmations auto-send; everything touching money/W-9/bank details stays draft.
6. **Volume per tenant** (docs/month)? Confirms Postgres-as-queue is safe (it is, well past SMB scale).
7. **Retention/compliance:** how long must source docs + audit logs live? Sets storage lifecycle.
8. **Extraction accuracy bar for go-live:** what per-field accuracy on *your* messiest vendors is "good enough" to trust auto-post? Measure in Phase 1 before promising it.
9. **Who maintains it after handoff?** (You / a bookkeeper / nobody.) This caps allowable complexity — favor the leanest build if the answer is "mostly nobody."
10. **Owner/intercompany transactions in scope?** If yes, those stay exception-only (judgment territory); confirm the CPA sign-off path.

---

## Simplicity audit (self-critique)

- **Overcomplicated if taken too far:** the learning loop and statement-diffing. Ship rule-based mapping + manual exceptions first; add learning promotion and statement diffing only once volume proves they pay off.
- **Can be removed at start:** custom admin UI (use Gmail labels), Metabase (use QBO native aging), R2 (use Postgres large objects), Pub/Sub push (poll), `/batch` (single creates until volume demands batching).
- **Manual at first, automate later:** vendor→QBO mapping approvals; all replies (draft, human sends); reconciliation clearing.
- **Fragile:** OAuth token lifecycle (Intuit refresh rotation, Gmail re-consent) and mapping accuracy on new vendors. Both need first-class handling, not afterthoughts.
- **Durable:** Postgres-as-everything, approve-before-post staging, hash-based idempotency, audit log, exception queue. These won't need replacing.
- **What makes it fail in real businesses:** (1) auto-applying a fraudulent bank-detail change — mitigated by the hard-stop gate; (2) silent mapping errors polluting the GL — mitigated by approve-before-post + confidence thresholds + audit; (3) OAuth expiring and the pipeline going quiet unnoticed — mitigated by auth-failure exceptions + tenant pause + alerting.
- **The simplest winning version:** Postgres + one Node service + `pg-boss` + LLM-vision extraction + Gmail poll + QBO approve-before-post (sandbox-first), exception queue as Gmail labels. That is genuinely shippable and genuinely useful, and everything else grows onto it without a rewrite.

---

## Strongest countercase (steelman: this design is wrong)

*"For a real business you should buy, not build the AP half."* Mature AP-automation products (Bill.com-class, Ramp/Melio, and QBO's own receipt/bill-capture) already do capture→extract→approve→sync-to-QBO with vendor networks, ACH, and fraud controls you'd otherwise reinvent — and QBO Advanced ships receipt capture and basic bill import natively. If the goal is *a business's books get done*, the highest-ROI move may be configuring those tools + Gmail filters + QBO's native capture, and building custom code only for the **gaps they don't cover** (odd email-body invoices, your specific class/location/project mapping, cross-tool reconciliation). Build the *orchestration and mapping brain*; rent the capture/payment rails.

**Response / crux:** This countercase is strong and should shape scope. It doesn't overturn the recommendation — it narrows it. **Crux question:** *Is the unmet need "extract invoices to QBO" (mostly solved by off-the-shelf) or "one auditable brain that classifies email, maps messily across businesses, and reconciles end-to-end" (not solved off-the-shelf)?* If the former → buy, don't build. If the latter → build exactly this lean core, and consider using a capture/payment product as *one input source* behind it. **Evidence to resolve before coding:** try QBO's native receipt/bill capture + a Gmail filter on your real mail for two weeks; measure what it *misses*. Build for the misses. `CONFIDENCE: MEDIUM` that a custom build beats configure-off-the-shelf for a single business; `HIGH` that the lean core is the right build *if* you're building.

---

## Instrument panel (condensed)

- **Verdict:** Build **Option B** with the MVP core: Postgres (+pg-boss +storage) + one TypeScript service + LLM-vision extraction + Gmail poll + QBO approve-before-post (sandbox-first — QBO has no draft state). Defer every other tool you listed.
- **HIGH confidence:** Postgres-as-everything; LLM vision replaces the OCR pipeline; approve-before-post + hash idempotency prevents double-posts; the bank-change fraud gate is mandatory.
- **MEDIUM confidence:** fuzzy vendor mapping quality; auto-post trust calibration; statement-diff reconciliation.
- **ASSUMPTION to verify:** SMB doc volume keeps Postgres-as-queue comfortable (verify per tenant).
- **Minimum viable disagreement (flips the plan):** *Does off-the-shelf capture (QBO native / Bill.com-class) already cover ≥80% of this business's invoices?* If yes → buy the capture rails, build only mapping+reconciliation. If no → build the lean core.
- **Next action:** Answer the 10 questions in §18 (especially #1 single-vs-product and the MVD above), then run the two-week off-the-shelf gap test on real mail before writing service code.

---

*Saved: `Desktop/Ultimate Brainstorm Output/ai-accountant-hub_20260709/brainstorm-output.md`*
