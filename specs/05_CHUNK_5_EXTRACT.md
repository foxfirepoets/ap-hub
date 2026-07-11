# CHUNK_5_EXTRACT: Classify documents and extract structured invoice fields via LLM vision with confidence

## Summary

Turns raw attachments/bodies into structured data. First a deterministic classifier (sender domain, subject regex, has-attachment/MIME) decides doc_type + direction, falling back to a single LLM classification call only when rules are ambiguous. Then a single LLM-vision call per document extracts the full field set to strict, schema-validated JSON with a per-field confidence and a missing_fields list; malformed model output is rejected and retried, never persisted raw. Includes the foot-check (total == Σ line_items + tax) and the bank-change flag (tag only — never acted on). After each schema-valid extraction persists, it is submitted to SwarmSync Verify-API for independent verification (Amendment A1) and the proof reference recorded. Hands off `extractions` rows for mapping.

## Acceptance Criteria

- [ ] Deterministic classifier assigns doc_type (invoice/receipt/statement/payment_confirmation/w9/other) + direction (AP/AR) using rules first; LLM classification is called only on ambiguity.
- [ ] LLM-vision extraction returns JSON validated against a strict schema; invalid output is retried (up to 3) and never stored raw.
- [ ] Extracted fields include: vendor_name, invoice_number, invoice_date, due_date, total, tax, line_items[], payment_terms, remit_to, bank_info, job_ref, class_hint, location_hint, account_hint — each with per-field confidence — plus overall confidence and missing_fields[].
- [ ] Foot-check: if total != Σ line_items + tax, an `exceptions` row `total_mismatch` is raised.
- [ ] If bank_info differs from the last-seen value for this vendor, the extraction is tagged `bank_change_warning` (flag only — no action taken).
- [ ] Overall confidence = min(component confidences) minus a missing-required-field penalty.
- [ ] Corrupt/unreadable file → `bad_pdf`; unsupported type → `unsupported_file`; extraction call failure → retry/backoff then `extraction_failed`.
- [ ] Verify-API (Amendment A1): each schema-valid extraction is submitted via the CHUNK_1 SwarmSync client — `POST {SWARMSYNC_API_BASE}/api/verify` with `{ source_type: 'document', output: <extraction JSON>, evidence: { gmail_message_id, attachment_sha256, model } }`, bearer `SWARMSYNC_API_KEY` — and the returned proof_id + chain_hash stored in `proof_refs` (entity_kind = extraction, product = verify_api). Check-before-submit against proof_refs so retries never double-submit.
- [ ] A Verify-API FAILED verdict (or its bank-change gate firing) records a flag on the extraction that CHUNK_6 will use to cap the proposal at `review`. A failed CALL (network/5xx/timeout after retry ×3 backoff) writes exception `proof_scan_unavailable` (detail names the product) and the pipeline continues — never crashes, never silently skips.
- [ ] Each successful extraction enqueues a `map` job. LLM usage recorded in `llm_calls`. No document contents or bank/PII fields logged in plaintext.
- [ ] All tests pass with zero failures (including golden-file extraction fixtures).

## Endpoints / Interfaces

No HTTP endpoints — worker jobs `classify` and `extract`.

## Database Changes

- `extractions`: rows written (fields JSONB, confidence, missing_fields[]).
- `exceptions`: total_mismatch / bad_pdf / unsupported_file / extraction_failed / proof_scan_unavailable (A1).
- `llm_calls`: one record per model call (model, latency, cost, confidence).
- `proof_refs`: one row per extraction × verify_api (A1).

## Test Scenarios

- **Happy path**: a clean PDF invoice extracts correct vendor/invoice#/date/total within tolerance (golden fixture).
- **Edge case**: email-body-only invoice; receipt with no line items; multi-invoice vendor statement; invoice with missing invoice number → missing_fields + exception where required.
- **Failure case**: totals don't foot → total_mismatch; corrupt PDF → bad_pdf; malformed LLM JSON → retried, never persisted raw; Verify-API unreachable (mocked 500s) → proof_scan_unavailable exception, pipeline continues (`proof_fail_safe`).
- **Integration**: successful extraction enqueues a `map` job for CHUNK_6; extraction has a proof_refs row with proof_id + chain_hash; re-running extract submits zero duplicate proofs (`no_proof_dup`).

## Dependencies

- **Requires**: CHUNK_3_INGEST.
- **Blocks**: CHUNK_6_MAPPING.

## Completion Promise

<promise>CHUNK COMPLETE: CHUNK_5_EXTRACT</promise>
