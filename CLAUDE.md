# CLAUDE.md — ap-hub build guide for AI agents

AP-Hub is a **local-first desktop application** for small and medium businesses and their
bookkeepers. It reads accounting email from Gmail, extracts invoices and bank statements, and
produces reviewable transactions in the user's accounting system. The entire application and its
database live on the user's own computer. There is no hosted AP-Hub application and no public
AP-Hub URL.

**Controlling documents — read these before planning any work:**
- `architecture-decision-packet-ap-hub-local-desktop-2026-07-25.md`
- `specs/SPEC-local-desktop-shell.md` (current phase) · `IMPLEMENTATION_PLAN.md`
- `.ralph/guardrails.md` — **read the email carve-out before touching anything send-related**
- `specs/reference/ARCHITECTURE-ap-hub-platform.md` — long-lived platform grounding

## Stack
Node 20+ · TypeScript (ESM, `moduleResolution: Bundler`) · PostgreSQL · pg-boss · Vitest ·
Playwright · googleapis (Gmail) · mupdf (PDF) · configurable LLM layer (local runtime, cloud key,
or none) · Electron (in progress, phase P1).

## Commands
```bash
npm install
npm run migrate:up          # apply migrations/*.sql (custom runner, idempotent)
npm run dev                 # boot the engine (HTTP + pg-boss workers)
npm run cli -- <command>    # operator CLI
npm test                    # unit + DB-backed tests
npm run verify              # lint + no-leak + typecheck + test + web build + Playwright — THE GATE
```
Tests need PostgreSQL at `DATABASE_URL` (default in `test/setup.ts`:
`postgres://aphub:aphub@127.0.0.1:5432/aphub`). Docker Compose was removed — point `DATABASE_URL`
at any PostgreSQL 16 instance. External services (Gmail, QBO, QBD, Telegram, LLM, SwarmSync) are
always mocked in the gate; live runs are `npm run verify:live`.

## The guarantees — NEVER break these

These are stated against **what the code actually enforces today**. If you find a mismatch between
this file and the code, the code wins and this file is the defect — fix it here, do not "restore"
behavior to match a stale claim.

1. **Gmail is never modified.** Read, attachment download, and draft create/update/discard only.
2. **No general email sending.** Exactly **one** call site may invoke a provider send API:
   `sendForward` in `src/gmail/adapter.ts`, reachable only via `createLockedForwarder`
   (`src/gatekeeper/forwarder.ts`), which binds one recipient at construction and takes **no
   recipient parameter**. It is the fraud-screening relay in front of QuickBooks Online's
   email-capture address — see packet §10 for the full plain-English explanation.
   **Scans must assert exactly one occurrence. Zero means the control was deleted — that is a
   defect, not a pass.** (`send_lockdown`)
3. **Accounting writes are gated, and production is off by default.** `QBO_ENV` defaults to
   `sandbox`. `production` is accepted **only** with the explicit `QBO_PRODUCTION_WRITE_ENABLED`
   owner gate plus exact realm and company binding (`src/config.ts:148-161`); QuickBooks Desktop
   writes require `QB_DESKTOP_WRITE_ENABLED` and a verified company identity. Automated verification
   never exercises a production or real-company write.
4. **No double-post, no double-forward.** Two-layer dedup plus replay-adopt-on-timeout for posting;
   `UNIQUE(tenant_id, sha256)` plus subject-tag replay for forwarding.
5. **Nothing unverified is labelled verified.** No proposal reaches `ready`, nothing posts, and
   nothing forwards without its required checks. SwarmSync is **optional and off by default**; when
   it is optional for a company its absence returns `noop` and AP-Hub's own controls apply, when a
   company's policy requires it its absence sends the item to **review**, and an unscanned item is
   **never** shown as "independently verified". (`proof_fail_safe`, `gatekeeper_hold`,
   `proof_gate_posting`)
6. **White-label = config only.** No tenant-specific value in code. (`white_label_install`)

Guarantee tests live in `test/` — `lockdown.test.ts`, `gatekeeper.test.ts`, `posting.test.ts`,
`anchor-whitelabel.test.ts`, `architecture-connector-path.test.ts`. **Never edit a safety test to
accommodate a connector, shell or OS adapter.** A conflict is a stop-and-escalate.

## Architecture

**Today:** `src/index.ts` boots an HTTP server (`/health` + OAuth callbacks) and pg-boss workers;
`app/` is a Next.js UI. **Target (phase P1):** an Electron main process supervises the same engine,
a bundled private PostgreSQL, and a discovery worker, with the existing React tree in the renderer
reached by IPC instead of HTTP.

Pipeline jobs (`src/pipeline/*`, wired by `pipeline/register.ts`):
`poll → gatekeep → classify → extract → map → propose → post`, plus a daily `audit_anchor`. Every
stage depends on injectable interfaces (GmailClient, AccountingConnector, Extractor, SwarmSyncClient,
TelegramSender) so logic is unit-tested with mocks and the real adapters stay thin.

## Layout
- `src/config.ts` — typed config, fail-closed validation.
- `src/pipeline/` — the 8 stages. `src/services/` — read/action services holding auth, tenant and RBAC.
- `src/connectors/` — provider-neutral contract; `qbo.ts`, `qbd.ts` real, Xero/Sage declaring stubs that throw.
- `src/qbo/` · `src/qbdesktop/` — provider implementations. `src/statements/` — bank statements.
- `src/gmail/` — intake and drafts. `src/gatekeeper/` — locked forwarder, decision engine.
- `src/extract/` · `src/llm/` — extraction; `llm/detect.ts` auto-detects local runtimes.
- `src/host/` — OS adapters. **Windows-only Version 1** (`docs/decisions/windows-only-v1-2026-07-25.md`); `macos.ts` is preserved and must keep compiling, but is out of scope and unmaintained.
- `app/` — React screens, moving into the Electron renderer.
- `migrations/*.sql` — schema. `specs/` — the current spec + `specs/reference/`.
- `archive/` — superseded work. **Do not build from it.**

## Conventions
- Money is `NUMERIC`; read as string, compare with tolerance.
- Never log tokens/PII/bank fields — `src/logger.ts` redacts. Extend redaction when adding secrets.
- Secrets live only in the OS credential store — never in PostgreSQL, `install.json`, logs, command
  lines, environment variables or renderer storage.
- Every failure is a typed `exceptions` row — no silent failures.
- The user is non-technical: never surface OAuth, API, key, token, port, environment variable,
  migration, worker, model, JSON or a stack trace in the UI. Plain language with a next action.
- Import with extensionless specifiers (`Bundler` resolution); run via `tsx`/vitest.
