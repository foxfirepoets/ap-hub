# CHUNK_7_DIGEST: Generate a daily digest and immediate risk alerts, reusing the severity classifier

## Summary

Builds the notification layer: one daily digest batch per tenant summarizing posted/held/failed + exception counts, plus immediate alerts for material risk only. Reuses the existing SwarmSync severity classifier so the digest never forks a separate risk list. Notifications are stored in `notifications` and surfaced on Today; routine success stays quiet.

## Acceptance Criteria

- [ ] A daily job writes one `daily_digest` notification per tenant with posted/held/failed/exception counts.
- [ ] Material-risk events (from severity classifier) create an immediate `risk_alert` notification.
- [ ] Routine success does NOT generate notifications (notifications must be earned).
- [ ] `GET /api/notifications` returns the tenant's notifications; Today renders the digest.
- [ ] Digest counts derive from the same `exceptions`/severity source as the pipeline — no separate list.
- [ ] All tests pass with zero failures.

## Endpoints / Interfaces

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/notifications | List tenant notifications (digest + alerts) |
| POST | /api/notifications/:id/read | Mark a notification read |

## Database Changes

- `notifications`: id, tenant_id (FK tenants), user_id (FK users, nullable), kind, severity, payload, digest_batch, read_at (NEW)
- Index: `idx_notifications_tenant_batch` (NEW)

## Test Scenarios

- **Happy path**: daily job produces exactly one digest batch/day with correct counts.
- **Edge case**: a bank-change/high-risk item creates an immediate risk_alert; routine posting creates none.
- **Failure case**: severity source unavailable → digest defers rather than emitting wrong counts.
- **Integration**: Today (CHUNK_5) renders the digest; severity comes from src/swarmsync/severity.ts.

## Dependencies

- **Requires**: CHUNK_1_AUTH, CHUNK_3_READ, CHUNK_5_FRONTEND
- **Blocks**: None

## Completion Promise

<promise>CHUNK COMPLETE: CHUNK_7_DIGEST</promise>
