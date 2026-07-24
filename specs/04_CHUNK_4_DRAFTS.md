# CHUNK_4_DRAFTS: Add human-sent Gmail reply drafts

## Summary

This chunk adds least-privilege Gmail draft create/update/discard operations tied to source threads. It records local intent and audit evidence while structurally excluding a general send operation.

## Acceptance Criteria

- [ ] Gmail OAuth can request read plus compose/draft scope with clear reconnect handling.
- [ ] Owner/bookkeeper can create, update, and discard a draft in the source thread; CPA is read-only.
- [ ] Draft storage records Gmail draft ID/status and every human mutation in the audit log.
- [ ] Gmail/API interfaces expose no reply-draft send operation and architecture tests enforce the boundary.
- [ ] Existing locked gatekeeper forwarding remains separate and unchanged.
- [ ] All tests pass with zero failures.

## Endpoints / Interfaces

| Method | Path | Description |
|---|---|---|
| GET | `/api/reply-drafts?messageId=` | Read active draft projection |
| POST | `/api/reply-drafts` | Create Gmail draft |
| PATCH | `/api/reply-drafts/:id` | Update Gmail draft |
| DELETE | `/api/reply-drafts/:id` | Discard Gmail draft |

## Database Changes

Uses `reply_drafts` from CHUNK_1; no new schema.

## Test Scenarios

- **Happy path**: create then update a draft in the original Gmail thread.
- **Edge case**: missing compose scope preserves proposed copy and returns reconnect guidance.
- **Failure case**: static/runtime attempts to invoke Gmail send from the draft flow fail.
- **Integration**: exception detail can prefill a draft without changing gatekeeper forwarding.

## Dependencies

- **Requires**: CHUNK_1_CONTRACTS
- **Blocks**: CHUNK_5_PRODUCT, CHUNK_6_HARDENING

## Completion Promise

<promise>CHUNK COMPLETE: CHUNK_4_DRAFTS</promise>
