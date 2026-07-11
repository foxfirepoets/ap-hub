# CHUNK_6_MAPPING: Import QBO lists, resolve vendor/account/dimension mappings, emit proposed transactions

## Summary

Completes Phase 1 (the dry-run). Imports QBO reference lists read-only (chart of accounts, vendors, customers, classes, locations, projects, items) and builds the mapping resolver: vendor via exact-prior-mapping then fuzzy name match; transaction type by rule; line→account and job/class/location→dimension via config rules. Before status assignment, every mapped invoice is scanned by SwarmSync InvoiceProof (Amendment A1) — an independent fraud layer on top of the internal foot-check and bank comparison. It assembles a QBO-shaped `proposed_txn` JSON with an idempotency_key (= attachment sha256, recorded but UNUSED in Phase 1), computes overall confidence, and writes a `proposals` row with status ready/review/exception. Unknown vendor or unmapped account/dimension become typed exceptions — nothing is created in QBO. This chunk produces NO QBO writes; the reviewable dry-run output is `v_proposal_review`.

## Acceptance Criteria

- [ ] `cli -- lists refresh` imports QBO lists read-only into `mappings` candidates; refresh is idempotent.
- [ ] Vendor resolver: exact prior mapping → normalized fuzzy match (token overlap / Levenshtein) → else `unknown_vendor` exception (NO auto-create of vendors).
- [ ] Transaction-type routing: AP invoice→Bill, AP paid receipt→Expense/Purchase, AR→Invoice, AR paid→SalesReceipt (never a Journal Entry).
- [ ] Line→account and job/class/location→Class/Location/Project resolved via config rules; misses raise `unmapped_account` / `unmapped_dimension`.
- [ ] A `proposed_txn` JSON is assembled (QBO-shaped) with idempotency_key = attachment sha256 (recorded, not used to write).
- [ ] InvoiceProof scan (Amendment A1) runs in `propose` BEFORE status assignment: `POST {SWARMSYNC_WEB_BASE}/api/scan/invoices` (no auth) with `invoices[]` (vendor, invoiceNo, amount, tax, lineItemsTotal, bank from bank_info, vendorCity/State from remit_to, po from job_ref when PO-shaped), `vendorMaster[]` (QBO vendor list + last-seen bank details), `paymentHistory[]` (prior extractions). `poRegister` omitted — do not fabricate one. Result stored in `proof_refs` (entity_kind = proposal, product = invoiceproof), check-before-submit.
- [ ] Gating (A1.3): critical finding (EXACT_DUPLICATE / MODIFIED_DUPLICATE / RECENT_DUPLICATE_IN_PAYMENT_HISTORY / BANK_ACCOUNT_CHANGE_DETECTED) → status `exception`, mapped to `duplicate` / `bank_change_warning` with the InvoiceProof pattern + evidence in detail; high finding (PO_AMOUNT_EXCEEDED / MISSING_PO_REFERENCE / vendor_address_mismatch / LINE_ITEM_MATH_ERROR) → cap at `review` + exception `fraud_flag`; medium (ROUND_DOLLAR_AMOUNT) → non-blocking flag only; scan call failure after retries → exception `proof_scan_unavailable` + cap at `review`.
- [ ] Fail-safe invariant (A1.3, non-negotiable): NO proposal reaches `ready` without BOTH a completed InvoiceProof scan (this chunk) AND a completed Verify-API document verification (CHUNK_5) recorded in `proof_refs`. SwarmSync outage degrades to review-only; never blocks the pipeline.
- [ ] Overall confidence set; proposal status = ready (>= AUTO_THRESHOLD, no blocking flags, both proof refs present) / review (>= REVIEW_THRESHOLD) / exception (below, or blocking flag).
- [ ] `v_proposal_review` returns a human-readable row per proposal (source-doc link, fields, confidences, proposed vendor/account/class, flags); `cli -- proposals --status ... --csv` exports it.
- [ ] `cli -- correct <proposal_id> --field X --value Y` records a `corrections` row (no external write).
- [ ] ZERO QBO writes anywhere in this chunk (a `no_write` test asserts no QBO write method is reachable and no Gmail send/modify occurs outside the CHUNK_4 relay module). Phase 1 is complete at the end of this chunk.
- [ ] All tests pass with zero failures.

## Endpoints / Interfaces

No HTTP endpoints — worker job `map` + `propose`, plus CLI.

## Database Changes

- `mappings`: populated from QBO lists + learned rules.
- `proposals`: rows written (proposed_txn JSONB, confidence, status).
- `exceptions`: unknown_vendor / unmapped_account / unmapped_dimension / fraud_flag / proof_scan_unavailable (A1).
- `corrections`: rows written on `cli correct`.
- `proof_refs`: one row per proposal × invoiceproof (A1).

## Test Scenarios

- **Happy path**: known vendor + known account + clean InvoiceProof scan → proposal status `ready` with a correct proposed_txn and both proof_refs rows (`proof_refs_recorded`).
- **Edge case**: near-duplicate vendor name resolves by fuzzy match; ambiguous match → `review`; real-estate class/location convention applied from config; mocked BANK_ACCOUNT_CHANGE_DETECTED finding → `exception`/`bank_change_warning`, never ready (`invoiceproof_gate`).
- **Failure case**: unknown vendor → `unknown_vendor` (not a wrong guess); unmapped account → `unmapped_account`; InvoiceProof unreachable → capped at `review` + `proof_scan_unavailable`, pipeline completes (`proof_fail_safe`).
- **Integration**: `v_proposal_review` shows every proposal (incl. proof flags); `no_write` test proves Phase 1 writes nothing to QBO and never sends/modifies Gmail outside the locked-down CHUNK_4 relay (SwarmSync proof calls are permitted — Amendment A1.1).

## Dependencies

- **Requires**: CHUNK_2_AUTH (QBO read lists), CHUNK_5_EXTRACT.
- **Blocks**: CHUNK_7_POSTING (proposals are its input).

## Completion Promise

<promise>CHUNK COMPLETE: CHUNK_6_MAPPING</promise>
