# CHUNK_1_INFRA: Stand up the service skeleton, Postgres schema/migrations, pg-boss queue, and typed config

## Summary

Establishes the substrate the whole service runs on: a TypeScript/Node 20 project skeleton, a typed config/env loader, the Postgres schema via migrations, and pg-boss wired as the job queue. Also stands up the thin SwarmSync proof-platform HTTP client (Amendment A1) that CHUNKs 4–7 call. No business logic yet — this chunk exists so every later chunk has tables, a queue, config, and a validation gate to build against. Hands off a runnable (but idle) service and a green test/lint/typecheck pipeline.

## Acceptance Criteria

- [ ] `npm install`, `npm run typecheck`, `npm run lint`, `npm test` all run and exit 0 on a fresh clone.
- [ ] Typed config module loads and validates all env vars from `.env.example`; missing required vars fail fast with a clear message; `QBO_ENV` must be `sandbox` (a value of `production` is rejected at config load with a descriptive error).
- [ ] `npm run migrate:up` creates all tables from the schema: tenants, oauth_tokens, messages, attachments, extractions, mappings, proposals, exceptions, postings, reconciliation, audit_log, corrections, llm_calls, **proof_refs (Amendment A1)**, **forwards (Phase 0.5 gatekeeper)** — plus the `v_proposal_review` view.
- [ ] Unique constraints exist: messages.gmail_message_id, attachments.sha256 (per tenant), postings.idempotency_key, proposals upsert key on attachment_id, **proof_refs (tenant_id, entity_kind, entity_id, product)**, **forwards (tenant_id, sha256)**.
- [ ] Typed config also loads `SWARMSYNC_API_BASE` (default `https://api.swarmsync.ai`), `SWARMSYNC_WEB_BASE` (default `https://swarmsync.ai`), and `SWARMSYNC_API_KEY` (required, `ssk_live_…`), plus the Phase 0.5 gatekeeper vars: `GATEKEEPER_ENABLED` (default false), `QBO_FORWARDING_ADDRESS`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (all three required only when the gatekeeper is enabled). White-label rule: every tenant-specific value comes from env/tenant config — never code.
- [ ] A thin SwarmSync HTTP client exists (`src/swarmsync/client.ts` — plain fetch wrapper, NO SDK dependency) with retry ×3 exponential backoff, timeout, and bearer-key auth; unit-tested against a mock.
- [ ] pg-boss connects to Postgres, creates its schema, and a trivial registered no-op job can be enqueued and completes (covered by a test).
- [ ] `npm run dev` boots the service (HTTP server for OAuth callbacks + pg-boss workers) and exits cleanly on SIGINT.
- [ ] A structured logger exists with token/PII redaction helpers — redaction covers the `ssk_` key prefix, the Telegram bot token, OAuth tokens, and bank/PII fields.
- [ ] All tests pass with zero failures.

## Endpoints / Interfaces

| Method | Path | Description |
|--------|------|-------------|
| GET | /health | liveness probe (returns 200 + db + queue status) |

(OAuth callback routes are added in CHUNK_2.)

## Database Changes

All tables NEW (see specs/reference for the full schema): tenants, oauth_tokens, messages, attachments, extractions, mappings, proposals, exceptions, postings, reconciliation, audit_log, corrections, llm_calls; view `v_proposal_review` NEW.

`proof_refs` NEW (Amendment A1): `(id, tenant_id, entity_kind, entity_id, product, proof_id, chain_hash, verdict, findings JSONB, response JSONB, created_at)` with `UNIQUE (tenant_id, entity_kind, entity_id, product)` — entity_kind ∈ {attachment, extraction, proposal, posting, audit_day} (attachment = Phase 0.5 gatekeeper scans); product ∈ {verify_api, invoiceproof, auditproof}. The UNIQUE constraint is the proof-submission idempotency guard.

`forwards` NEW (Phase 0.5 gatekeeper — full schema in `specs/reference/03_phase0.5-gatekeeper-spec.md` §6): `(id, tenant_id, message_id, attachment_id, sha256, status, hold_reason, gmail_send_id, subject_tag, alerted_at, released_by, created_at, updated_at)` with `UNIQUE (tenant_id, sha256)` — the double-forward guard. Owned/written by CHUNK_4.

## Test Scenarios

- **Happy path**: fresh migrate:up creates every table + view; health check returns 200.
- **Edge case**: config load with `QBO_ENV=production` throws a descriptive error and the service refuses to boot.
- **Failure case**: a missing required env var fails fast at startup with the var name (no silent default).
- **Integration**: a no-op pg-boss job enqueues and completes — proving the queue the later chunks depend on.

## Dependencies

- **Requires**: None (first chunk).
- **Blocks**: CHUNK_2_AUTH and everything after.

## Completion Promise

<promise>CHUNK COMPLETE: CHUNK_1_INFRA</promise>
