# ap-hub — AI Accountant Hub

A local TypeScript backend plus a Next.js review UI that reads accounting email
from Gmail and verify documents through the operator's own **SwarmSync** proof platform
(InvoiceProof · Verify-API · AuditProof), and produces reviewable QuickBooks Online
transactions for a configured QBO sandbox or explicitly gated production company,
or supported Windows QuickBooks Desktop Pro, Premier,
and Enterprise. It can create, update, inspect, and discard unsent Gmail drafts;
a human is always responsible for sending those drafts. A separate, owner-released
gatekeeper can forward an original invoice only to the configured QuickBooks capture address.

It is designed for repeatable, per-business installation. Each business still
requires its own credentials, provider connections, company verification, backup
evidence, owner write-gate approval, and live validation before accounting writes.

## What it does

```
Gmail (watched label)
  → ingest (dedup, hash attachments)
  → gatekeeper: InvoiceProof scan → forward clean invoices to QBO capture / HOLD + Telegram alert
  → extract (LLM vision) → Verify-API check
  → map (vendor/account) → InvoiceProof gate → proposal (ready/review/exception)
  → proof-gated post (QBO sandbox/explicitly gated production, or explicitly enabled company-bound QBD)
  → daily audit anchor
```

QuickBooks writes are proof-gated and fail closed. QBO production is default-off and
requires an explicit production gate plus exact tenant realm/company binding. QBD is
disabled by default and requires an owner-enabled write gate bound to the expected
Windows company. Gmail reply handling is draft-only; the reply-draft API has no send action.

## Quick start

```bash
npm install
cp .env.example .env            # fill in values; keep QBO_ENV=sandbox
npm run migrate:up              # apply schema
npm run cli -- bootstrap-tenant --name "Example Company" --owner-email "owner@example.com"
npm run verify                  # repository-level verification
npm run dev                     # terminal 1: backend + workers
npm run web:dev                 # terminal 2: authenticated UI
```

Requires Node 20+, PostgreSQL, a usable vision LLM, Google SSO, a Gmail OAuth app
(readonly plus compose when drafts are enabled), a QuickBooks Online sandbox app or
supported Windows QuickBooks Desktop, and (for the gatekeeper) a SwarmSync `ssk_live_` key,
the QBO capture address, and a Telegram bot token + chat id.

## Operator runbook

**Connect:** `npm run cli -- connect gmail` and `connect qbo` print the OAuth URLs; open
them, approve, and the callback stores encrypted tokens. `npm run cli -- env` confirms the
active realm (must say `sandbox`).

**Review the dry run:** `npm run cli -- proposals --status review --csv` exports proposals.
`npm run cli -- correct --proposal <id> --field <f> --value <v>` records a correction (no
external write).

**Post to sandbox:** after the owner verifies the exact company and backup, enables
the connection write gate, and enables assisted/automatic processing, ready proposals
can post automatically. Inspect with
`npm run cli -- postings --status posted_sandbox` and `reconcile --proposals-vs-postings`.

**Gatekeeper:** `npm run cli -- gatekeeper held` lists held invoices;
`gatekeeper release --id <id>` forwards one after out-of-band verification (audited);
`gatekeeper test-alert` verifies the Telegram channel.

**Pause / resume:** `npm run cli -- pause` drains the poller; `resume` restarts it.
Before maintenance, confirm the provider-job health view has no sent or
result-unknown work; pausing does not undo an external request already accepted by a provider.

**If SwarmSync is down:** the pipeline degrades to review-only and the gatekeeper holds —
it never lets an unscanned document through. Retry the affected item after service
recovery and resolve retained `proof_scan_unavailable` evidence through the review workflow.

## Guarantees (each backed by a named test)

| Guarantee | Test |
|---|---|
| Reply drafts cannot be sent by AP Hub | Gmail draft and reply API no-send tests |
| Forward locked to one configured address | `send_lockdown` |
| Production default-off; exact realm/company + owner/proof gates required | configuration and posting tests |
| No double-post / double-forward | `idempotent_double_post`, `replay_after_timeout`, `no_double_forward` |
| Nothing unscanned gets through | `proof_fail_safe`, `gatekeeper_hold`, `proof_gate_posting`, `unscannable_hold` |
| Identical pipeline supports separate tenant configuration | `white_label_install` |

Run `npm run verify` for repository-level verification. The Playwright suite
stubs internal APIs and is therefore a UI contract test, not live integration
certification. Run `npm run verify:live` with disposable sandbox credentials
for external-system evidence. See [INSTALL.md](INSTALL.md), `CLAUDE.md`, and `specs/`.

> **Built ≠ externally certified.** `npm run verify` proves the repository-level
> gates on the machine where it is run. It does not prove live Gmail, QBO, LLM,
> broker, deployment, backup restoration, or production readiness. Production QBO
> writes are default-off and require `QBO_ENV=production`,
> `QBO_PRODUCTION_WRITE_ENABLED=true`, exact realm/company configuration, an active
> tenant-owned OAuth connection, owner approval, proof gates, duplicate detection,
> and provider read-back. Use disposable
> sandbox credentials for `npm run verify:live` and complete an operator launch audit.

QuickBooks Desktop is disabled and read-only by default. Supported Windows
QuickBooks Desktop Pro, Premier, and Enterprise companies can use the
proof-gated bill writer only after an owner explicitly enables
`QB_DESKTOP_WRITE_ENABLED` and verifies the expected company identity in a
disposable test company. QuickBooks Mac, Self-Employed, and unknown editions are
reported as unsupported rather than treated as compatible. Automated
verification never writes to a production QBO company or a real QBD company.
