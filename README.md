# ap-hub — AI Accountant Hub

A single TypeScript service that reads accounting email from Gmail, fraud-scans and
verifies every document through the operator's own **SwarmSync** proof platform
(InvoiceProof · Verify-API · AuditProof), and produces reviewable QuickBooks Online
transactions — writing **only to a QBO sandbox company**, never production, and never
sending or modifying Gmail except one locked-down forward.

It is **white-label**: dropping it into a new business is configuration only (their
Gmail, their QuickBooks sandbox, their forwarding address, their Telegram chat).

## What it does

```
Gmail (watched label)
  → ingest (dedup, hash attachments)
  → gatekeeper: InvoiceProof scan → forward clean invoices to QBO capture / HOLD + Telegram alert
  → extract (LLM vision) → Verify-API check
  → map (vendor/account) → InvoiceProof gate → proposal (ready/review/exception)
  → post_sandbox (QBO sandbox, idempotent, read-back verified) → AuditProof anchor
  → daily audit anchor
```

Two phases: **Phase 1** (chunks 1–6) writes nothing to QuickBooks and never modifies
Gmail. **Phase 2** (chunk 7) writes only to the QBO sandbox. No proposal reaches `ready`
— and nothing posts — without completed proof coverage.

## Quick start

```bash
npm install
cp .env.example .env            # fill in values; keep QBO_ENV=sandbox
npm run migrate:up              # apply schema
npm test                        # run the full guarantee suite
npm run dev                     # boot the service
```

Requires Node 20+, PostgreSQL, an Anthropic key, a Gmail OAuth app (readonly), a
QuickBooks Online **sandbox** app, and (for the gatekeeper) a SwarmSync `ssk_live_` key,
the QBO capture address, and a Telegram bot token + chat id.

## Operator runbook

**Connect:** `npm run cli -- connect gmail` and `connect qbo` print the OAuth URLs; open
them, approve, and the callback stores encrypted tokens. `npm run cli -- env` confirms the
active realm (must say `sandbox`).

**Review the dry run:** `npm run cli -- proposals --status review --csv` exports proposals.
`npm run cli -- correct --proposal <id> --field <f> --value <v>` records a correction (no
external write).

**Post to sandbox:** ready proposals post automatically. Inspect with
`npm run cli -- postings --status posted_sandbox` and `reconcile --proposals-vs-postings`.

**Gatekeeper:** `npm run cli -- gatekeeper held` lists held invoices;
`gatekeeper release --id <id>` forwards one after out-of-band verification (audited);
`gatekeeper test-alert` verifies the Telegram channel.

**Pause / resume:** `npm run cli -- pause` drains the poller; `resume` restarts it. Because
Phase 1 writes nothing external and Phase 2 writes only to sandbox, pausing is always safe.

**If SwarmSync is down:** the pipeline degrades to review-only and the gatekeeper holds —
it never blocks the queue and never lets an unscanned document through. Holds and
`proof_scan_unavailable` exceptions clear automatically on the next successful scan.

## Guarantees (each backed by a named test)

| Guarantee | Test |
|---|---|
| No QBO write before posting; Gmail never modified | `no_qbo_write`, `no_write` semantics |
| Forward locked to one configured address | `send_lockdown` |
| Sandbox-only; production refused | `no_prod_write` |
| No double-post / double-forward | `idempotent_double_post`, `replay_after_timeout`, `no_double_forward` |
| Nothing unscanned gets through | `proof_fail_safe`, `gatekeeper_hold`, `proof_gate_posting`, `unscannable_hold` |
| White-label = config only | `white_label_install` |

Run `npm test` to execute all of them. See `CLAUDE.md` for the build guide and `specs/`
for the authoritative chunk specifications.

> **Built ≠ launchable.** This repository is verified at the build level (lint, typecheck,
> and the full guarantee suite are green). Before touching real books, run the two-week
> off-the-shelf gap test and a launch audit.
