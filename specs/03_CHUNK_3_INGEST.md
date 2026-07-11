# CHUNK_3_INGEST: Poll Gmail incrementally, persist deduped messages, download and hash attachments

## Summary

Implements the front of the pipeline: a pg-boss scheduled `poll` job that reads new mail under the watched label via Gmail `history.list` (incremental by historyId), persists each new message deduped on Gmail message_id, and downloads every attachment — hashing it with SHA-256, storing the bytes once, and flagging duplicate hashes so they skip downstream work. Also handles email-body-only messages (no attachment). This chunk makes the system idempotent at the source: re-polling never creates duplicate messages or attachments. Hands off `messages` + `attachments` rows for classification/extraction.

## Acceptance Criteria

- [ ] A pg-boss scheduled `poll` job runs every POLL_INTERVAL_SECONDS and reads new messages under WATCHED_LABEL using history.list from the stored historyId.
- [ ] Each new message inserts one `messages` row; re-polling the same mailbox inserts zero duplicates (unique on gmail_message_id).
- [ ] Each attachment is downloaded, SHA-256 hashed, stored once (hash as key); a second identical file yields one `attachments` row and marks the later message's link `is_duplicate`.
- [ ] Email-body-only messages (no attachment) are persisted and marked for body extraction.
- [ ] `poll` enqueues a `classify` job per new message (classify itself is CHUNK_5) and, when `GATEKEEPER_ENABLED=true`, a `gatekeep` job (CHUNK_4) — both consume the same message independently.
- [ ] Transient Gmail errors (429/5xx) retry with backoff via pg-boss; 401 raises `auth_failure` and pauses the tenant.
- [ ] Gmail access is READ-ONLY — no send, no label modification anywhere in this chunk (the only send in the whole system is CHUNK_4's locked-down relay).
- [ ] `npm run cli -- poll --once` runs one cycle; `reprocess <message_id>` re-enqueues a message.
- [ ] All tests pass with zero failures.

## Endpoints / Interfaces

No HTTP endpoints — internal poller + workers only.

## Database Changes

- `messages`: rows written (dedup on gmail_message_id).
- `attachments`: rows written (dedup on sha256); `is_duplicate` flag set.
- `audit_log`: ingest transitions recorded.

## Test Scenarios

- **Happy path**: poll reads N new messages → N message rows + their attachment rows with sha256.
- **Edge case**: email-body-only invoice persisted and flagged for body extraction; a huge multi-attachment message stores each attachment once.
- **Failure case**: same file arriving twice → one attachments row + duplicate flag; double-poll → zero duplicate messages (idempotency test).
- **Integration**: each new message enqueues a `classify` job consumed by CHUNK_5, and a `gatekeep` job consumed by CHUNK_4 when the gatekeeper is enabled.

## Dependencies

- **Requires**: CHUNK_1_INFRA, CHUNK_2_AUTH (Gmail token).
- **Blocks**: CHUNK_4_GATEKEEPER, CHUNK_5_EXTRACT.

## Completion Promise

<promise>CHUNK COMPLETE: CHUNK_3_INGEST</promise>
