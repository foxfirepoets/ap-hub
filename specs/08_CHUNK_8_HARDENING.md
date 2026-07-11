# CHUNK_8_HARDENING: Complete the exception taxonomy, audit logging, CLI, and validation test suite

## Summary

Closes the loop on reliability and observability across all phases (0.5, 1, 2). Ensures every automated step has detection → notification → manual fallback (no silent failure), the full typed-exception taxonomy is implemented and surfaced, `audit_log` covers every state transition and external call, log redaction is airtight, the CLI is complete, and the named acceptance tests from all specs exist and pass. Adds the daily AuditProof `audit_anchor` job that chain-anchors the audit trail on SwarmSync (Amendment A1). Produces the operator runbook and finalizes the gatekeeper + dry-run + sandbox guarantees. No new domain — this chunk makes what exists trustworthy and provable.

## Acceptance Criteria

- [ ] Every exception reason_code from the specs is implemented and appears in `exceptions` with the right detail: low_confidence, unknown_vendor, unmapped_account, unmapped_dimension, duplicate, duplicate_in_qbo, missing_invoice_no, total_mismatch, no_attachment, bad_pdf, unsupported_file, bank_change_warning, extraction_failed, verify_mismatch, attachment_failed, qbo_api_error, auth_failure, **fraud_flag, proof_scan_unavailable (Amendment A1), unscannable_format, forward_failed, alert_failed (Phase 0.5 gatekeeper)**.
- [ ] Daily scheduled `audit_anchor` pg-boss job (A1): computes the day's audit digest (row count + SHA-256 over the ordered audit_log rows) and submits it with `source_type: 'audit_proof'`; exactly one `proof_refs` row per day (entity_kind = audit_day, product = auditproof). Failure → proof_scan_unavailable exception + retry next cycle; never blocks anything else. Gatekeeper decisions (forwards/holds/releases) are audit_log rows and are therefore inside the daily anchor.
- [ ] Every automated step has detection → notification → manual fallback; transient failures retry with backoff then DLQ; business exceptions go to the exceptions table. No path swallows an error silently (test).
- [ ] `audit_log` has a row for every state transition and every external API call (Gmail read, Gmail relay send, QBO read, QBO sandbox write, SwarmSync proof calls, Telegram alerts), with before/after hash + realm; a grep test proves no token/PII/bank field appears in any log line (covers `ssk_` keys and the Telegram bot token).
- [ ] CLI complete and documented: poll --once, reprocess, proposals --status --csv, correct, post --env sandbox, void, postings --status, reconcile, env, pause, resume, connect gmail/qbo, lists refresh, **gatekeeper held --csv, gatekeeper release, gatekeeper test-alert (Phase 0.5)**.
- [ ] The named tests from all specs exist and pass: golden_extraction, dedup_same_file, idempotent double-poll, foot_check, unknown_vendor, no_write (Phase 1, amended semantics), create_and_verify, idempotent_double_post, replay_after_timeout, duplicate_in_qbo, 6190_handling, verify_mismatch, attach_retry, batch_partial, gate_holds, no_prod_write, void_reversal, plus the secrets/PII log-redaction assertion (which also covers the `ssk_` key prefix and Telegram token), plus the Amendment A1 suite: invoiceproof_gate, proof_fail_safe, proof_refs_recorded, no_proof_dup, audit_anchor, posting_anchor, proof_gate_posting, chain_verify (integration-only), **plus the Phase 0.5 gatekeeper suite: send_lockdown, gatekeeper_hold, held_alert, no_double_forward, unscannable_hold, release_forward, white_label_install**.
- [ ] `README.md` operator runbook: how to pause, run manually, and restart (per the spec X sections); confirms the dry-run guarantee (Phase 1 writes nothing to QBO and never sends/modifies Gmail outside the locked-down gatekeeper relay — SwarmSync proof calls to the operator's own platform are permitted, per Amendment A1.1), the sandbox-only guarantee (Phase 2 writes only to sandbox), and the gatekeeper guarantees (single-recipient send lockdown; nothing forwarded unscanned; every hold alerted); documents the SwarmSync-outage posture (pipeline degrades to review-only / gatekeeper holds, nothing blocks, exceptions clear when service returns); documents the white-label install path (new tenant = config only, per `specs/reference/03_phase0.5-gatekeeper-spec.md` §11).
- [ ] The full validation gate (`npm run lint && npm run typecheck && npm test`) is green; `npm run test:int` documented for chunk-boundary runs against live sandbox credentials.
- [ ] All tests pass with zero failures.

## Endpoints / Interfaces

No new HTTP endpoints — hardening across existing workers + CLI.

## Database Changes

No new tables. Ensures `audit_log`, `exceptions`, `reconciliation`, `forwards`, and `proof_refs` are written consistently everywhere; `proof_refs` gains one audit_day row per day from the `audit_anchor` job (A1).

## Test Scenarios

- **Happy path**: full pipeline run on golden fixtures → gatekeeper forwards/holds (P0.5), proposals (P1), and sandbox postings (P2) with complete audit trail, zero duplicates, and proof_refs coverage on every scanned attachment, ready proposal, and posting; daily audit_anchor produces its digest row (audit_anchor).
- **Edge case**: every exception reason_code (including fraud_flag, proof_scan_unavailable, unscannable_format, forward_failed, alert_failed) can be provoked by a fixture and surfaces correctly.
- **Failure case**: an injected silent-swallow is caught by the no-silent-failure test; a token in a log line is caught by the redaction test.
- **Integration**: the complete named test suite runs green as the final validation gate; runbook steps are executable, including the white-label second-tenant install.

## Dependencies

- **Requires**: CHUNK_7_POSTING and all prior chunks (including CHUNK_4_GATEKEEPER).
- **Blocks**: None — final chunk. On completion emit BUILD COMPLETE.

## Completion Promise

<promise>CHUNK COMPLETE: CHUNK_8_HARDENING</promise>
