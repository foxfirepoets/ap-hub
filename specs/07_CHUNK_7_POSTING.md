# CHUNK_7_POSTING: Create idempotent, verified QBO sandbox transactions from gated proposals

## Summary

Phase 2 — the only chunk that writes to QuickBooks, and it writes to the SANDBOX realm only. It takes proposals that pass the confidence gate and creates the corresponding QBO entity (Bill/Expense/Invoice/SalesReceipt), attaches the source PDF, reads the entity back to verify it matches the proposal, and records the QBO id in an external-ID map. It is protected by two-layer idempotency and replay safety so no retry or mid-create timeout ever double-creates. Because QBO has no draft state, sandbox isolation + approve-before-create + a void/delete reversal ARE the safety model. This is an atomic, self-contained chunk (writes/"payments" are never split or merged).

## Acceptance Criteria

- [ ] A `post_sandbox` job selects proposals with status `ready`, confidence >= AUTO_THRESHOLD, amount <= AMOUNT_CEILING, and no blocking flags (duplicate, total_mismatch, bank_change_warning, unknown_vendor, unmapped_*); everything else is held (never created).
- [ ] Proof gate extension (Amendment A1-P2.1): a proposal is selected ONLY if both `proof_refs` rows exist for its document (invoiceproof + verify_api), the InvoiceProof scan has no unresolved critical/high finding, and no `proof_scan_unavailable` exception is open. Nothing is created in QBO — even sandbox — without completed proof coverage.
- [ ] InvoiceProof `paymentHistory[]` now includes posted sandbox txns from `postings` (A1-P2.3), making RECENT_DUPLICATE_IN_PAYMENT_HISTORY a third dedup layer.
- [ ] Two-layer dedup BEFORE every create: check `postings.idempotency_key` (= attachment sha256) AND query QBO for an existing txn matching (vendor, DocNumber, TxnDate, TotalAmt). Either hit → skip, mark `duplicate_in_qbo`.
- [ ] Creates the QBO entity in the SANDBOX realm with `minorversion` pinned and an idempotency/request key; type routing per CHUNK_6 (never a Journal Entry).
- [ ] Uploads the source PDF via the `Attachable` entity linked to the created txn; attach failure retries the ATTACH ONLY (never re-creates the txn).
- [ ] Read-back verify: fetch the created entity by id, assert vendor/amount/date match the proposal; on mismatch flag `verify_mismatch` and DO NOT retry (records the txn id for voiding).
- [ ] Records qbo_id + SyncToken + request/response in `postings`; sets proposal status `posted_sandbox`; logs a proposal-vs-created diff to `reconciliation`.
- [ ] AuditProof posting anchor (A1-P2.2): after successful create + read-back verify, submit `POST {SWARMSYNC_API_BASE}/api/verify` with `{ source_type: 'audit_proof', output: { realm, qbo_id, entity_type, idempotency_key, diff_hash, timestamps } }` and store proof_id + chain_hash in `proof_refs` (entity_kind = posting, product = auditproof). Anchor failure NEVER voids or re-creates the QBO txn — it writes `proof_scan_unavailable` and retries the ANCHOR ONLY (same pattern as attach-failure).
- [ ] Replay safety: create-then-timeout (unknown outcome) → the dedup query runs and adopts the existing txn instead of re-creating. QBO `6190` treated as dedup hit (link, no blind retry). Stale SyncToken → refetch+retry once. 429 → backoff.
- [ ] `/batch` used for multi-bill statements with per-item partial-failure handling (successes applied, failures exceptioned individually).
- [ ] Environment isolation ENFORCED: sandbox vs prod credentials in separate slots; `QBO_ENV=production` hard-refuses to write (a `no_prod_write` test proves no production write path exists); confirm-realm before any write.
- [ ] `cli -- post <proposal_id> --env sandbox`, `void <posting_id>` (audited reversal), `postings --status`, `reconcile --proposals-vs-postings`, `env` all work.
- [ ] All tests pass with zero failures.

## Endpoints / Interfaces

No HTTP endpoints — worker job `post_sandbox` + CLI.

## Database Changes

- `postings`: NEW rows (idempotency_key UNIQUE, qbo_id, sync_token, realm, mode, request/response JSONB).
- `reconciliation`: proposal-vs-created diff rows.
- `exceptions`: duplicate_in_qbo / verify_mismatch / attachment_failed / proof_scan_unavailable (A1).
- `proposals`: status updated to posted_sandbox.
- `proof_refs`: one row per posting × auditproof (A1).

## Test Scenarios

- **Happy path**: a `ready` proposal creates one sandbox Bill with correct vendor/account/amount/date + PDF attached + a postings row (create_and_verify) + an AuditProof anchor in proof_refs (posting_anchor).
- **Edge case**: multi-bill statement via /batch where item 2 fails → items 1,3 created, item 2 exceptioned; a `review`/over-ceiling/`bank_change_warning` proposal is never created (gate_holds); a `ready` proposal with a missing or failed proof ref is never posted (proof_gate_posting).
- **Failure case**: same proposal run twice → exactly one QBO txn (idempotent_double_post); create-then-timeout → adopts existing txn (replay_after_timeout); 6190 → linked not retried; read-back mismatch → verify_mismatch, no retry; QBO_ENV=production → refuses (no_prod_write); simulated anchor failure → exception + anchor-only retry, ZERO additional QBO txns (posting_anchor).
- **Integration**: `void` removes/voids the sandbox txn and audits it; reconcile shows proposal-vs-created diffs; `GET /api/proof/:id/export/verify` passes for a recorded posting anchor (chain_verify, integration-only).

## Dependencies

- **Requires**: CHUNK_6_MAPPING (proposals), CHUNK_2_AUTH (extended with a SANDBOX-only write client).
- **Blocks**: CHUNK_8_HARDENING (final gates + full test suite).

## Completion Promise

<promise>CHUNK COMPLETE: CHUNK_7_POSTING</promise>
