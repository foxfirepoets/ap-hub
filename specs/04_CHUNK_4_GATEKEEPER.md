# CHUNK_4_GATEKEEPER: Scan every ingested invoice with InvoiceProof and auto-forward only clean ones to QBO capture

## Summary

Phase 0.5 — the proof-gated forwarding relay (full spec: `specs/reference/03_phase0.5-gatekeeper-spec.md`, authoritative). For each message CHUNK_3 ingests, a `gatekeep` job scans the attachment via InvoiceProof (direct PDF intake), then either auto-forwards the original email to the tenant's QBO capture address (`QBO_FORWARDING_ADDRESS`) or HOLDS it with a typed exception and a Telegram alert. This is the only chunk that ever sends email, and its send module is structurally locked to one recipient. White-label: every tenant-specific value (label, forwarding address, Telegram chat) is config, never code. The dry-run pipeline (CHUNK_5/6) continues on the same messages independently — that comparison is the off-the-shelf gap-test data.

## Acceptance Criteria

- [ ] `gatekeep` pg-boss job runs per newly ingested message when `GATEKEEPER_ENABLED=true`; disabled = no-op (clean rollback path).
- [ ] Digital/text PDF attachments are scanned via InvoiceProof PDF intake (`POST {SWARMSYNC_WEB_BASE}/api/scan/invoices`) using the CHUNK_1 SwarmSync client; results recorded in `proof_refs` (check-before-submit, no duplicate submissions).
- [ ] Clean scan → the original message is forwarded ONCE to `QBO_FORWARDING_ADDRESS` via Gmail API send with subject tag `[APH-{sha8}]`; `forwards` row reaches `forwarded` with the Gmail send id.
- [ ] Send lockdown (HARD REQUIREMENT): the send wrapper takes NO recipient parameter — it reads the configured forwarding address at its single call site and asserts it before every send; any other recipient is impossible by construction (test `send_lockdown`). `gmail.send` scope added for this only; labels still never modified.
- [ ] Critical/high InvoiceProof finding → HOLD: no forward, `forwards.status = held`, mapped exception (`duplicate` / `bank_change_warning` / `fraud_flag`), and a Telegram alert (HARD REQUIREMENT) containing vendor, invoice #, amount, reason, forward id — NO bank details/PII (test `gatekeeper_hold`).
- [ ] Every held invoice produces exactly one Telegram alert; alert delivery failure never loses the hold — `alert_failed` exception + retry ×3 backoff (test `held_alert`).
- [ ] Unscannable documents (image-only/password PDF, body-only email) → HOLD (`unscannable_format` / `no_attachment`) + alert; NEVER forwarded unscanned. SwarmSync outage → HOLD (`proof_scan_unavailable`) + alert — fail-safe, never fail-open (tests `unscannable_hold`, inherited `proof_fail_safe` posture).
- [ ] Double-forward is impossible: UNIQUE(tenant_id, sha256) on `forwards`, intent row before send, and unknown-outcome timeouts replay-adopt via `in:sent subject:"[APH-{sha8}]"` search — never blind-resend (test `no_double_forward`). Multi-attachment messages forward once, only if ALL scannable attachments are clean.
- [ ] `cli -- gatekeeper held [--csv]`, `gatekeeper release <forward_id>` (audited human-only un-hold + forward), `gatekeeper test-alert` all work (test `release_forward`).
- [ ] White-label: booting with a second tenant-config fixture (different label/forwarding address/Telegram chat/company name) runs the identical pipeline with zero code changes (test `white_label_install`).
- [ ] All tests pass with zero failures.

## Endpoints / Interfaces

No HTTP endpoints — worker job `gatekeep` + CLI. External calls: InvoiceProof scan (no auth), Telegram Bot API `sendMessage`, Gmail API send (single recipient).

## Database Changes

- `forwards`: rows written (status machine pending→scanning→{held→released→forwarding|forwarding}→forwarded|failed; UNIQUE(tenant_id, sha256); subject_tag replay key). Table created in CHUNK_1 migrations; owned by this chunk.
- `exceptions`: bank_change_warning / duplicate / fraud_flag / proof_scan_unavailable / unscannable_format / no_attachment / forward_failed / alert_failed.
- `proof_refs`: one row per scanned attachment — entity_kind = `attachment`, entity_id = attachment_id, product = invoiceproof (see schema note).
- `audit_log`: every state transition + send + release.

**Schema note:** Amendment A1 defined `proof_refs.entity_kind ∈ {extraction, proposal, posting, audit_day}`. Gatekeeper scans are keyed to an ATTACHMENT, before any extraction exists, so CHUNK_1's migration includes `attachment` in the entity_kind set. Do not shoehorn gatekeeper scans into an existing kind.

## Test Scenarios

- **Happy path**: clean digital invoice → scanned, forwarded once to the configured address within one poll cycle, `forwards` = forwarded, audit + proof_refs rows present.
- **Edge case**: multi-attachment email with one flagged attachment → whole message held; same invoice arriving twice → one forward ever; second tenant config fixture → identical behavior (`white_label_install`).
- **Failure case**: bank-change fixture → held + `bank_change_warning` + Telegram alert, never forwarded (`gatekeeper_hold`); send timeout with unknown outcome → replay-adopt, zero duplicate sends (`no_double_forward`); Telegram down → hold preserved + `alert_failed` (`held_alert`); recipient override attempt → refused (`send_lockdown`).
- **Integration**: released hold forwards exactly once, audited (`release_forward`); gatekeeper decisions appear in the daily AuditProof anchor (CHUNK_8); CHUNK_5 extraction still processes the same messages (dry-run comparison intact).

## Dependencies

- **Requires**: CHUNK_1_INFRA (config, forwards table, SwarmSync client, redaction incl. Telegram token), CHUNK_2_AUTH (Gmail identity; this chunk adds the send scope), CHUNK_3_INGEST (messages/attachments/dedup).
- **Blocks**: Nothing downstream structurally (CHUNK_5–8 don't depend on it), but it must exist before CHUNK_8's taxonomy/test-suite completion.

## Completion Promise

<promise>CHUNK COMPLETE: CHUNK_4_GATEKEEPER</promise>
