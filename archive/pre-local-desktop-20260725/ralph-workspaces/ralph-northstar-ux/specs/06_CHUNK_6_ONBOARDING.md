# CHUNK_6_ONBOARDING: Guide first-run setup with a dry-run that posts nothing

## Summary

Builds the onboarding wizard: connect Gmail → connect QBO → select company → mode/date range → automation level → run dry-run scan → review business-specific sample → approve initial rules → enable auto-post. The dry-run runs the pipeline through `propose` but never posts. Tracks progress in `onboarding_state`. Discovery-before-asking: pull from QBO/Gmail/prior data before prompting the user.

## Acceptance Criteria

- [ ] Wizard walks the steps and persists progress in `onboarding_state`.
- [ ] Dry-run scan produces ≥1 `proposals` row and exactly `0` `postings` rows for the tenant.
- [ ] First-run output is a business-specific summary (counts of emails/invoices/vendors matched), not a blank dashboard.
- [ ] Auto-post cannot occur until `automation_level` is explicitly set away from `off` (DRY_RUN_LOCKED before then).
- [ ] Setup blockers (Gmail scope denied, QBO company unselected) render as grouped exact-fix cards.
- [ ] Approving initial rules writes `corrections`/`mappings` via the CHUNK_2 service path.
- [ ] All tests pass with zero failures.

## Endpoints / Interfaces

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/onboarding | Current onboarding_state |
| POST | /api/onboarding/step | Advance a step / persist a choice |
| POST | /api/onboarding/dry-run | Trigger the dry-run scan (no posting) |

## Database Changes

- `onboarding_state`: tenant_id (PK, FK tenants), step, dry_run_complete, automation_level (NEW)

## Test Scenarios

- **Happy path**: complete wizard → dry-run → review sample → enable auto-post; postings stay 0 until enabled.
- **Edge case**: Gmail scope denied → blocker card "Reconnect Gmail with label access"; wizard resumable.
- **Failure case**: attempt to post during setup → 403 DRY_RUN_LOCKED.
- **Integration**: reuses CHUNK_5 shell + Evidence panel; enable-auto-post uses CHUNK_4 thresholds.

## Dependencies

- **Requires**: CHUNK_1_AUTH, CHUNK_4_ACTION, CHUNK_5_FRONTEND
- **Blocks**: None

## Completion Promise

<promise>CHUNK COMPLETE: CHUNK_6_ONBOARDING</promise>
