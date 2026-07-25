# CHUNK_5_FRONTEND: Build the Next.js shell, core pages, and shared Evidence panel

## Summary

Builds the desktop web UI: the app shell + navigation, the Today page, the Exceptions queue with keyboard-fast triage, the Transactions list/detail, the shared Evidence panel component, a Settings page (connections + automation level + thresholds view), and the read-only Audit Trail view. Consumes the CHUNK_3 read API and CHUNK_4 action API. No business logic lives in the frontend — it renders API data and calls action routes.

## Acceptance Criteria

- [ ] App shell renders the nav (Today, Exceptions, Transactions, Settings, Audit Trail) behind the session guard.
- [ ] Today page renders the digest + counts + items from `GET /api/today`.
- [ ] Exceptions queue supports keyboard triage (J/K navigate, A approve if permitted, R reject, E edit, O open source).
- [ ] Evidence panel shows email, PDF page, extracted fields, confidence, prior rule, QBO link for any item.
- [ ] Action buttons are hidden/disabled per role (Bookkeeper sees no Approve→post; CPA is read-only).
- [ ] A Playwright E2E passes: login → Today → open exception → view evidence → approve → see Posted + QBO link.
- [ ] All tests pass with zero failures.

## Endpoints / Interfaces

No HTTP endpoints — front-end pages only. Consumes CHUNK_3 (read) and CHUNK_4 (action) APIs.

## Database Changes

No schema changes in this chunk.

## Test Scenarios

- **Happy path**: Owner logs in, clears an exception, approves a posting — E2E green.
- **Edge case**: CPA login shows read-only UI (no action buttons); Bookkeeper sees "Send to Owner" on post-required items.
- **Failure case**: an approve that returns 202 QBO_RETRY renders a plain-English retry state, not a raw error.
- **Integration**: Evidence panel is shared across Today, Exceptions, and Transactions detail.

## Dependencies

- **Requires**: CHUNK_1_AUTH, CHUNK_3_READ, CHUNK_4_ACTION
- **Blocks**: CHUNK_6_ONBOARDING (reuses shell + evidence panel)

## Completion Promise

<promise>CHUNK COMPLETE: CHUNK_5_FRONTEND</promise>
