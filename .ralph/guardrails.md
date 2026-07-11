# Guardrails — Known Risks and Scope Exclusions

ralph: before taking any action, scan this file. If your action matches a SIGN, stop and report.

## Pre-Loaded Risks (from spec)

### SIGN: QBO has no draft state — writes are dangerous
QuickBooks Online has NO draft status for Bills/Expenses/Invoices via the Accounting API. A created Bill posts to the ledger immediately. In Phase 1 there must be NO QBO write code at all (absent, not disabled). In Phase 2, writes go ONLY to the sandbox realm and there must be no code path that can select production.
Mitigation: In P1, do not implement any QBO create/update/delete. In P2, hard-refuse writes when QBO_ENV=production; confirm the sandbox company via CompanyInfo before any write.

### SIGN: Double-post / duplicate creation
The same invoice must never be created twice, even across retries or a mid-create network timeout.
Mitigation: Two-layer dedup before every create — check postings.idempotency_key (= attachment sha256) AND query QBO for (vendor, DocNumber, TxnDate, TotalAmt). On unknown-outcome timeouts, run the dedup query and adopt the existing txn instead of re-creating. Handle QBO 6190 as a dedup hit, not a blind retry.

### SIGN: Silent failure
An automation that fails silently is worse than the manual process.
Mitigation: Every step needs detection → notification → manual fallback. Every failure is a typed exception row or a DLQ entry — never swallowed.

### SIGN: Read-back mismatch after create
If a create succeeds but the read-back does not match the proposal, retrying would duplicate.
Mitigation: Do NOT retry on verify mismatch. Flag verify_mismatch, record the created txn id so it can be voided.

### SIGN: Secrets / PII in logs
OAuth tokens, bank details, and PII must never appear in logs.
Mitigation: Encrypt tokens at rest; redact tokens and extracted bank/PII fields in all log output.

### SIGN: OAuth token lifecycle
Intuit rotates refresh tokens; Gmail requires re-consent on scope change.
Mitigation: Persist the newest refresh token on every refresh; on 401 check env/token mismatch first, then refresh, then pause the tenant with an auth_failure exception.

### SIGN: Extraction accuracy is unproven
Extraction/mapping quality is the empirical risk the whole project exists to measure.
Mitigation: Golden-file fixtures gate phase advancement; low confidence is an expected exception path, not an error.

### SIGN: Proposal reaching `ready` without proof coverage (Amendment A1)
No proposal may EVER reach status `ready` without BOTH a completed InvoiceProof scan and a completed Verify-API document verification recorded in proof_refs. In Phase 2, nothing is posted (even to sandbox) without both proof refs and no unresolved critical/high finding.
Mitigation: Status assignment happens only after both proof calls complete or definitively fail; a failed call caps status at `review` with exception proof_scan_unavailable.

### SIGN: SwarmSync outage blocking the pipeline (Amendment A1)
The proof platform being down must degrade ap-hub to review-only — it must never crash the pipeline, block jobs, or (worse) let unscanned documents through as ready.
Mitigation: Proof calls retry ×3 with backoff then write proof_scan_unavailable and continue. Fail-safe, not fail-open and not fail-stop.

### SIGN: Proof anchor failure after a QBO create (Amendment A1)
A failed AuditProof anchor after a successful sandbox create must never void, retry, or re-create the QBO transaction.
Mitigation: Retry the ANCHOR ONLY (same pattern as attach-failure). The txn is already correct; the anchor is bookkeeping about it.

### SIGN: Gatekeeper sending email anywhere except the QBO capture address (Phase 0.5)
The relay is the ONLY code in the system allowed to send email, and it may only ever address the tenant's configured QBO_FORWARDING_ADDRESS. A misdirected forward leaks financial documents.
Mitigation: The send wrapper takes NO recipient parameter — it reads the configured address at its single call site and asserts it before every send. Proven by send_lockdown. Never add a recipient parameter, ever.

### SIGN: Forwarding an unscanned or flagged invoice (Phase 0.5)
Nothing may be forwarded to QuickBooks without a completed, clean InvoiceProof scan. Outage or unscannable format = HOLD + Telegram alert, never forward-anyway.
Mitigation: Fail-safe posture (hold, alert, human release only). Proven by gatekeeper_hold, unscannable_hold, held_alert.

### SIGN: Double-forward on retry/timeout (Phase 0.5)
A retried gatekeep job or unknown-outcome send timeout must never forward the same invoice twice.
Mitigation: UNIQUE(tenant_id, sha256) on forwards + intent row before send + replay-adopt via in:sent subject:"[APH-{sha8}]" search. Never blind-resend. Proven by no_double_forward.

### SIGN: White-label drift (Phase 0.5)
No business-specific value (company name, label, address, chat id, mapping convention) may be hardcoded — a new tenant install must be pure configuration.
Mitigation: All tenant values from env/tenant config; white_label_install test runs the pipeline on a second tenant fixture.

## Scope Exclusions — Do Not Build

- DO NOT BUILD: any QBO production write (Phase 3).
- DO NOT BUILD: any QBO write code at all before CHUNK_7_POSTING (chunks 1–6) — it must be absent, not disabled. (The CHUNK_4 gatekeeper sends EMAIL to QBO's capture address; it never calls the QBO API.)
- DO NOT BUILD: a custom web UI or dashboard (Phase 3/4) — review is CLI + a SQL view + CSV.
- DO NOT BUILD: any Gmail label modification, reply drafting, or send to ANY address other than the configured QBO_FORWARDING_ADDRESS — the CHUNK_4 relay is the single, locked-down exception to "Gmail stays readonly".
- DO NOT BUILD (P0.5): auto-release of held invoices — release is a human CLI action, always audited.
- DO NOT BUILD (P0.5): OCR / LLM-vision fallback inside the gatekeeper (v1) — unscannable documents are held + alerted, never forwarded unscanned.
- DO NOT BUILD (P0.5): QBO draft read-back cross-checking — Phase 4 reconciliation.
- DO NOT BUILD (P0.5): a Telegram SDK/framework — one HTTPS Bot API call.
- DO NOT BUILD: reply drafting (Phase 3).
- DO NOT BUILD: a reconciliation engine or BI tool / Metabase (Phase 4).
- DO NOT BUILD: a workflow engine (n8n / Temporal), Redis / BullMQ, or MinIO — pg-boss on Postgres covers queue/retries/DLQ; Postgres/Supabase covers storage.
- DO NOT BUILD: automatic vendor/customer creation — unknown vendor stays a typed exception.
- DO NOT BUILD: embeddings-based vendor matching yet — start with fuzzy string matching.
- DO NOT BUILD (A1): a SwarmSync SDK dependency — the client is a thin fetch wrapper with retry/backoff.
- DO NOT BUILD (A1): local re-implementations of InvoiceProof fraud rules — the internal foot-check + last-seen bank comparison stay as the offline layer; everything else is InvoiceProof's job.
- DO NOT BUILD (A1): local RSA/crypto verification of proof signatures — chain verification is GET /api/proof/:id/export/verify (integration test only).
- DO NOT BUILD (A1): a fabricated poRegister — PO-based fraud rules stay inert until a real PO register exists.

## Standing Guardrails (always active)

- DO NOT add npm dependencies without updating AGENTS.md.
- DO NOT skip the validation gate, even for trivial changes.
- DO NOT commit with --no-verify.
- DO NOT generate code for a future chunk's domain (especially: no QBO write code before CHUNK_7_POSTING; no Gmail send code before CHUNK_4_GATEKEEPER).
- DO NOT modify files outside the current task's scope.
- DO NOT hard-code secrets, API keys, or credentials.

## Accumulation Instructions

When ralph encounters a new failure pattern, append below:

### Learned: (none yet)
