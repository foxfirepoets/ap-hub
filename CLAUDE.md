# CLAUDE.md — ap-hub build guide for AI agents

AI Accountant Hub: reads accounting email from Gmail, proof-gates it through Ben's own
SwarmSync platform, and produces reviewable QuickBooks Online transactions — writing
only to a QBO **sandbox** company, never production, never modifying Gmail.

## Stack
Node 20+ · TypeScript (ESM, `moduleResolution: Bundler`) · PostgreSQL · pg-boss ·
Vitest · Anthropic Claude vision · googleapis (Gmail) · SwarmSync proof suite.

## Commands
```bash
npm install
npm run migrate:up          # apply migrations/*.sql (custom runner, idempotent)
npm run dev                 # boot service (HTTP + pg-boss workers)
npm run cli -- <command>    # operator CLI (env, proposals, gatekeeper, ...)
npm test                    # unit + DB-backed guarantee tests (the gate)
npm run lint && npm run typecheck && npm test   # full validation gate
```
Tests need a Postgres at `DATABASE_URL` (default in `test/setup.ts`:
`postgres://aphub:aphub@127.0.0.1:5432/aphub`). External services (SwarmSync, Gmail,
QBO, Telegram, Anthropic) are always mocked in the gate; live runs are `test:int`.

## The six guarantees — NEVER break these
1. **No QBO write before CHUNK_7, Gmail never modified.** QBO write code lives only in
   `src/qbo/write.ts`; `src/qbo/client.ts` (read) has no create/update/delete.
2. **The only email the system can send is the gatekeeper forward, locked to one
   address.** `src/gatekeeper/forwarder.ts` has no recipient parameter. (`send_lockdown`)
3. **Phase 2 writes only to the QBO sandbox.** `createQboWriteClient` hard-refuses unless
   `QBO_ENV=sandbox`; config refuses `production` at load. (`no_prod_write`)
4. **No double-post, no double-forward.** Two-layer dedup + replay-adopt-on-timeout for
   posting; `UNIQUE(tenant_id, sha256)` + subject-tag replay for forwarding.
5. **Nothing unscanned gets through.** No proposal reaches `ready`, nothing posts, and
   nothing forwards without completed proof coverage; SwarmSync outage → review/hold,
   never fail-open. (`proof_fail_safe`, `gatekeeper_hold`, `proof_gate_posting`)
6. **White-label = config only.** No tenant-specific value in code. (`white_label_install`)

## Architecture (one process)
`src/index.ts` boots an HTTP server (`/health` + OAuth callbacks) and pg-boss workers.
Pipeline jobs (`src/pipeline/*` wired by `pipeline/register.ts`):
`poll → gatekeep → classify → extract → map → propose → post_sandbox`, plus a daily
`audit_anchor`. Every stage depends on injectable interfaces (GmailClient, QboWriteClient,
Extractor, SwarmSyncClient, TelegramSender) so logic is unit-tested with mocks and the
real adapters stay thin.

## Layout
- `src/config.ts` — typed config; `QBO_ENV=production` hard-refused.
- `src/swarmsync/` — proof client, severity classifier, proof_refs.
- `src/gatekeeper/` — locked forwarder, telegram, decision engine.
- `src/extract/` — classifier, schema, model (foot-check/confidence).
- `src/mapping/` — vendor/account resolver.
- `src/qbo/` — read client (no writes) + sandbox writer.
- `migrations/*.sql` — schema (custom runner in `src/db/migrate.ts`).
- `specs/` — the 8 chunk specs + `specs/reference/` authoritative specs.

## Conventions
- Money is `NUMERIC`; read as string, compare with tolerance.
- Never log tokens/PII/bank fields — `src/logger.ts` redacts `ssk_`, Telegram tokens,
  bearer tokens, and sensitive keys. Extend redaction when adding secrets.
- Every failure is a typed `exceptions` row — no silent failures.
- Import with extensionless specifiers (`Bundler` resolution); run via `tsx`/vitest.
