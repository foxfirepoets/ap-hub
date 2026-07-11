# SPEC: AP-Hub Phase 0.5 — Proof-Gated Forwarding Relay ("Gatekeeper")

## Metadata
- Version: 1.0 | Date: 2026-07-11 | Tier: FULL (sends email; handles financial documents) | Brownfield (bolts onto the ap-hub ralph workspace as CHUNK_4)
- Status: Ready for Build
- Success measure: over a 2-week pilot — ≥95% of clean digital-PDF invoices auto-forwarded to QBO capture within 10 minutes of arrival; ZERO invoices forwarded unscanned or with unresolved critical findings; 100% of held invoices produce a Telegram alert; a log of what QBO capture misses (the gap-test data).
- Architecture grounding: fallback preflight from repo evidence (ap-hub specs incl. Amendment A1 + SwarmSync source contracts, read 2026-07-11)
- Open questions: 1

## Tech Stack

Same stack as ap-hub (no additions): TypeScript / Node 20, PostgreSQL, pg-boss, Vitest, npm. External services: Gmail API (readonly + **send** — new scope, locked down), SwarmSync InvoiceProof (`POST {SWARMSYNC_WEB_BASE}/api/scan/invoices`, no auth) and AuditProof (via daily audit anchor), Telegram Bot API (plain HTTPS call, no SDK). No new npm dependencies beyond what CHUNK_1 established.

## Architecture Grounding Summary

- **Systems touched:** Gmail (read via CHUNK_3 poller; NEW: send, single-recipient), SwarmSync InvoiceProof (read/scan), Postgres (`messages`/`attachments` read; NEW table `forwards`; `exceptions`, `audit_log`, `proof_refs` written), Telegram Bot API (send alerts). **NOT touched:** QBO API (zero QBO reads or writes in this chunk — QuickBooks receives email, nothing else), Gmail labels (still never modified), production anything.
- **Source of truth:** `messages`/`attachments` (CHUNK_3) for what arrived; `forwards` (NEW) for gatekeeper decisions; `proof_refs` (Amendment A1) for scan evidence; QBO's own Documents/Receipts tab for what QuickBooks drafted (not read in v1).
- **State machine (`forwards.status`):** `pending → scanning → { held → released → forwarding | forwarding } → forwarded | failed`. Legal transitions only; every transition writes `audit_log`.
- **Must not break:** ap-hub's guarantees 1–4 (no QBO writes before CHUNK_7; sandbox-only; no double-post; no `ready` without proof coverage), CHUNK_3 ingest idempotency, the `no_write` test semantics (amended: see §9), the dry-run pipeline (extract/map continues on the same messages, unaffected).
- **Reuse:** CHUNK_1 SwarmSync client + logger/redaction + config loader; CHUNK_3 dedup (sha256) as the double-forward guard's foundation; existing exceptions/audit/proof_refs tables. Nothing rebuilt.

## 1. Executive Summary

A bouncer between the inbox and QuickBooks. QuickBooks already has a feature where you forward an invoice email to a special address (like `yourcompany@qbodocs.com`) and it reads the invoice and drafts the bill. The Gatekeeper automates that forward — but only after running each invoice through InvoiceProof fraud scanning. Clean invoices are forwarded automatically within minutes. Anything suspicious (duplicate, changed bank details, math errors) is HELD — never forwarded — and the owner gets a Telegram message saying what was caught and why. Every decision is recorded and tamper-proof-anchored. It is white-label: dropping it into a different business is pure configuration (their Gmail, their QuickBooks address, their Telegram chat) — zero code changes. Build size: ~1 week of agent work on top of chunks 1–3.

## 2. Scope & Do Not Build

**In scope:**
- A `gatekeep` pg-boss job consuming each newly ingested message (from CHUNK_3) when `GATEKEEPER_ENABLED=true`.
- InvoiceProof scan per attachment (direct PDF intake for digital/text PDFs).
- Auto-forward of clean messages to exactly one configured address (`QBO_FORWARDING_ADDRESS`) via Gmail API send.
- Hold path: no forward + typed exception + Telegram alert + CLI release flow.
- `forwards` table, CLI commands (`gatekeeper held`, `gatekeeper release <id>`, `gatekeeper test-alert`), audit rows, daily AuditProof anchoring (rides the existing CHUNK_8 anchor).
- White-label install path: all tenant-specific values from env/tenant config.

### Do Not Build
- NO QBO API reads or writes in this chunk — QuickBooks receives an email, nothing else. (QBO draft read-back cross-check is Phase 4 reconciliation.)
- NO Gmail label modification, NO reply drafting, NO sending to any address other than the configured forwarding address — the send module physically cannot address anyone else.
- NO OCR / LLM-vision fallback for image-only PDFs in v1 — unscannable documents are held + alerted for manual review, never forwarded unscanned. (LLM-vision reading belongs to CHUNK_5; wiring it into the gatekeeper is a later decision.)
- NO auto-release: a held invoice is only ever forwarded by an explicit, audited human `release` command.
- NO Telegram bot framework/SDK — one HTTPS call to the Bot API.
- NO per-decision AuditProof calls — gatekeeper decisions are audit_log rows, anchored by the existing daily `audit_anchor` job.

## 3. Business Context & Acceptance Criteria

**Goal:** protect the books from fraud BEFORE documents reach QuickBooks, while collecting the off-the-shelf gap-test data, at ~1/4 the build cost of the full pipeline. **Success metric:** see Metadata.

Acceptance criteria (each machine-verifiable; FAIL condition named):
- [ ] A clean digital-PDF invoice arriving under the watched label is scanned and forwarded to `QBO_FORWARDING_ADDRESS` within 10 minutes; a `forwards` row reaches status `forwarded` with the Gmail send id. FAIL if no forward, wrong recipient, or >10 min at normal poll cadence.
- [ ] An invoice with a critical InvoiceProof finding (e.g. `BANK_ACCOUNT_CHANGE_DETECTED`) is NEVER forwarded: `forwards.status = held`, a typed exception exists, and a Telegram alert was sent. FAIL if any forward occurs or any of the three artifacts is missing.
- [ ] The send module rejects any recipient ≠ the tenant's configured forwarding address with an error + exception. FAIL if an email leaves addressed to anything else (test `send_lockdown`).
- [ ] Re-running `gatekeep` on the same message/attachment produces exactly one forward, ever (UNIQUE on tenant+sha256 + replay-adopt via the `[APH-{sha8}]` subject tag search). FAIL on any second send (test `no_double_forward`).
- [ ] An image-only/unscannable PDF is held + alerted with reason `unscannable_format`, never forwarded. FAIL if forwarded (test `unscannable_hold`).
- [ ] Telegram delivery failure does NOT lose the hold: hold persists, `alert_failed` exception is written, alert retries with backoff. FAIL if hold is lost or failure is silent (test `held_alert`).
- [ ] `cli -- gatekeeper release <id>` forwards a held item exactly once and writes an audit row with the operator identity. FAIL if unaudited or duplicated (test `release_forward`).
- [ ] Booting with a second tenant-config fixture (different label, forwarding address, Telegram chat, company name) runs the identical pipeline with zero code changes. FAIL if any behavior requires a code edit (test `white_label_install`).
- [ ] All tests pass with zero failures.

DONE means ALL true in the DEPLOYED environment, with an artifact per item (HTTP response, DB row, screenshot, log line). NOT done if: verified only locally; "code looks correct"; any must-not-break item untested.

## 4. Architecture & System Integration

```
Gmail (watched label) → CHUNK_3 poller → messages/attachments rows
                                              │ (GATEKEEPER_ENABLED)
                                              ▼
                                        gatekeep job
                                              │
                        ┌── digital PDF ──────┴────── image-only/body-only ──┐
                        ▼                                                    ▼
             InvoiceProof PDF scan                                   HOLD + Telegram alert
             (SWARMSYNC_WEB_BASE)                                    (unscannable_format /
                        │                                             no_attachment)
          clean ────────┴──────── critical/high finding ──► HOLD + typed exception
            │                                                + Telegram alert
            ▼                                                (release = human CLI only)
   Gmail API send → QBO_FORWARDING_ADDRESS (ONLY)
            │
            ▼
   QuickBooks capture drafts the bill (its native review queue = 2nd net)
```

The dry-run pipeline (CHUNK_5 extract → CHUNK_6 map) keeps consuming the same messages independently — that comparison (ap-hub's extraction vs QBO capture's drafts) IS the gap-test dataset.

## 5. User Flows & Happy Path

**Actor:** the system (cron/pg-boss); the human appears only on holds.
- **Happy path:** vendor emails invoice → poller ingests (CHUNK_3) → `gatekeep` scans PDF via InvoiceProof → no findings ≥ high → intent row written (`forwarding`, subject tagged `[APH-{sha8}]`) → Gmail send to forwarding address → status `forwarded` → audit row. Owner sees the bill appear in QuickBooks' review tab as usual.
- **Alternate — fraud hold:** scan returns `BANK_ACCOUNT_CHANGE_DETECTED` → status `held`, exception `bank_change_warning`, Telegram: "⛔ HELD: Acme Supply invoice #1234 ($2,450) — vendor bank details changed. Not forwarded to QuickBooks. Verify by phone, then `gatekeeper release 57`." Human verifies out-of-band → releases (or leaves held).
- **Alternate — unscannable:** photo-scan PDF → held, reason `unscannable_format`, alert asks for manual review/forward.
- **Alternate — SwarmSync outage:** scan calls fail after retries → held with `proof_scan_unavailable`, alerted; NOTHING is forwarded unscanned; holds release normally once scans succeed on retry or via human release.

## 6. Data Models & Schema

New table (all other tables reused):

```sql
forwards(
  id            bigserial PRIMARY KEY,
  tenant_id     bigint NOT NULL REFERENCES tenants(id),
  message_id    bigint NOT NULL REFERENCES messages(id),
  attachment_id bigint REFERENCES attachments(id),      -- NULL for body-only holds
  sha256        text,                                    -- attachment hash; NULL for body-only
  status        text NOT NULL DEFAULT 'pending',         -- pending|scanning|held|released|forwarding|forwarded|failed
  hold_reason   text,                                    -- reason_code when held
  gmail_send_id text,                                    -- Gmail message id of the outbound forward
  subject_tag   text NOT NULL,                           -- '[APH-{sha8}]' replay key
  alerted_at    timestamptz,
  released_by   text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, sha256)                             -- the double-forward guard
);
```

Valid example: `(tenant 1, msg 42, att 61, sha256 'ab12…', status 'forwarded', subject_tag '[APH-ab12cd34]', gmail_send_id '18c…')`. Invalid: a second row with the same `(tenant_id, sha256)` — constraint violation, by design.

## 7. Error Handling & Edge Cases

| Scenario | Detection | Response / Recovery |
|---|---|---|
| InvoiceProof unreachable / 5xx / timeout | HTTP error after pg-boss retry ×3 backoff | HOLD (`proof_scan_unavailable`) + alert; retry scan next cycle; never forward unscanned |
| Critical/high finding | scan result | HOLD + mapped exception (`duplicate` / `bank_change_warning` / `fraud_flag`) + alert; human release only |
| Image-only or password-protected PDF | InvoiceProof rejects / no text layer | HOLD (`unscannable_format`) + alert |
| Body-only accounting email (no attachment) | classify/ingest flags | HOLD (`no_attachment`) + alert (v1: manual forward decision) |
| Gmail send fails (429/5xx) | send error | retry ×3 backoff; then status `failed` + `forward_failed` exception + alert |
| Send timeout, outcome unknown | no response | REPLAY RULE: search `in:sent subject:"[APH-{sha8}]"`; found → adopt as forwarded; not found → retry send. Never blind-resend. |
| Telegram send fails | Bot API error | hold/decision unaffected; `alert_failed` exception; alert retry ×3 backoff; surfaced in `gatekeeper held` output |
| Recipient ≠ configured address requested | send-module guard | refuse + exception; this is a code-level invariant (`send_lockdown`) |
| Multi-attachment email | n scans | forward the original message ONCE only if ALL scannable attachments are clean; any hold holds the whole message |
| Duplicate invoice arrives again (same sha256) | UNIQUE hit | no new forward; CHUNK_3 already marked duplicate; audit row only |

## 8. Performance & Scalability

Tens–low-hundreds of docs/month (SMB reality). Poll cadence 3 min; scan+forward well under the 10-minute target. InvoiceProof public endpoint rate limits are far above this volume. Cost: $0 beyond existing infra (InvoiceProof scan free; Telegram free; Gmail API free).

## 9. Security & Compliance

- **Send lockdown (hard requirement):** the Gmail send wrapper takes NO recipient parameter — it reads `QBO_FORWARDING_ADDRESS` from validated config at the single call site; any attempt to pass a recipient is a type error, and a runtime assert re-checks the address before every send. `gmail.send` scope is added for this identity; scope remains readonly for everything else; labels are never modified.
- **Guarantee amendment:** ap-hub guarantee #1 becomes "never sends or modifies Gmail — EXCEPT the gatekeeper's forward, which can only address the tenant's configured QBO capture address (proven by `send_lockdown`)". The `no_write` test keeps asserting zero QBO writes + zero Gmail modification + zero sends outside the relay module.
- **Telegram alerts carry NO bank details/PII** — vendor name, invoice number, amount, reason code, forward id only.
- **Secrets:** `TELEGRAM_BOT_TOKEN` in env/secret store; redaction extended to cover it (alongside `ssk_`, OAuth tokens, bank fields).
- **QBO prerequisite (manual, runbook):** QuickBooks only accepts forwards from email addresses registered to users on that QBO company — verify the sending Gmail address is registered under Settings → Receipt forwarding before enabling.
- Compliance: none formal; the audit trail + daily AuditProof anchor is the evidence layer.

## 10. Testing Strategy

Named tests (Vitest; SwarmSync/Telegram/Gmail mocked in unit, live in `test:int`): `send_lockdown`, `gatekeeper_hold`, `held_alert`, `no_double_forward` (incl. the replay-adopt-by-subject-tag path), `unscannable_hold`, `release_forward`, `white_label_install`, plus regression: `no_write` (amended semantics), CHUNK_3 idempotency untouched, dry-run pipeline still runs on gatekept messages. Every §3 criterion maps to one of these. E2E (pilot, manual): one real clean invoice end-to-end into QBO's review tab; one seeded bank-change fixture held + alerted.

## 11. Deployment & Rollout

Same single service/process (no new deployable). Enable per tenant: set `GATEKEEPER_ENABLED=true`, `QBO_FORWARDING_ADDRESS`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` → restart → `cli -- gatekeeper test-alert` (verifies Telegram) → send one test invoice through. Rollback = `GATEKEEPER_ENABLED=false` (holds preserved, nothing lost; manual forwarding resumes). Verify live: `forwards` rows + the bill appearing in QBO's review tab.

## 12. API Documentation

No HTTP endpoints. Internal job `gatekeep`; CLI: `gatekeeper held [--csv]`, `gatekeeper release <forward_id>`, `gatekeeper test-alert`. External calls consumed: InvoiceProof scan + Telegram `POST https://api.telegram.org/bot{token}/sendMessage` (`{chat_id, text}` → 200 `{ok:true}`; non-ok → alert_failed path).

## 13. Database Migrations

UP: `CREATE TABLE forwards (…)` as §6 + index on `(tenant_id, status)`. DOWN: `DROP TABLE forwards`. Verification: `SELECT status, count(*) FROM forwards GROUP BY status;`. (Table is created in CHUNK_1's migration set per workspace convention; owned/written by CHUNK_4.)

## 14. Known Limitations, Open Questions & Future Work

**Limitations (honest):** image/photo PDFs and body-only invoices are held for manual handling in v1 (no OCR fallback); QBO capture's own extraction quality is whatever it is — the gatekeeper doesn't verify what QBO drafted (Phase 4); InvoiceProof paymentHistory is per-IP-scoped on the public endpoint (24h TTL) — cross-day duplicate memory comes from ap-hub's own sha256 layer, which is fine.

**Open questions (1):**
1. Does this QBO company's capture accept **bill** attachments via email forwarding on the current plan (receipt forwarding vs bill capture varies by region/plan)? **Resolution:** check Settings → Receipt forwarding / Bills in the live sandbox+prod QBO before enabling; if bills aren't accepted by email, the gatekeeper still works — targets the receipts address — and the gap test proceeds.

## Risks

- **A bug in the forwarder emails the wrong recipient** → the single-recipient send module + `send_lockdown` test + no-recipient-parameter API make this structurally impossible, not just tested.
- **Unscanned document reaches QuickBooks during a SwarmSync outage** → fail-safe posture: outage = hold + alert, never forward-unscanned; proven by `proof_fail_safe` posture inherited from A1 + `unscannable_hold`.
- **Double-forward on retry/timeout** → UNIQUE(tenant, sha256) + intent row + replay-adopt via `[APH-{sha8}]` sent-mail search; proven by `no_double_forward`.
- **Alert channel dies silently** → `alert_failed` exception + retry + visible in `gatekeeper held`; holds never depend on alert success.
- **White-label drift** — a hardcoded business value sneaks in → `white_label_install` test runs the pipeline on a second tenant fixture every CI run.

## 15. Glossary

**QBO capture address** — the per-company email (…@qbodocs.com) QuickBooks provides; mail sent there appears as draft documents for review. **Hold** — a gatekeeper decision to not forward; reversible only by human `release`. **Subject tag** — `[APH-{sha8}]`, the deterministic marker making forwards replay-detectable in Gmail search.

## 16. Monitoring & Metrics

Platform logs + `forwards` status counts (the §13 verification query) + Telegram itself (every hold is an alert; `test-alert` proves the channel). Success-metric query: forwarded-within-10-min % over the pilot window from `forwards.created_at → updated_at`.

## 17. Alternative Designs Considered

- **Gmail auto-forward filter straight to QBO (no gatekeeper):** rejected — zero fraud protection; the entire point is the scan-before-forward.
- **Full ap-hub first, gatekeeper never:** rejected as sequencing — the gatekeeper delivers fraud protection + the gap-test data in ~1 week and nothing about it is throwaway (same DB, client, guardrails).

## 18. Build Phases & Final Checklist

### Build Phases
1. **Schema + config** — `forwards` table (into CHUNK_1 migrations), 4 new env vars in typed config, redaction for Telegram token.
2. **Scan + decision engine** — `gatekeep` job: InvoiceProof PDF scan via the CHUNK_1 client, decision rules (clean/hold), proof_refs + exceptions + audit writes.
3. **Locked-down forwarder** — Gmail send wrapper (no recipient parameter), subject tag, intent row, replay-adopt search, `gmail.send` scope addition.
4. **Alerts + CLI** — Telegram sender + retry, `gatekeeper held/release/test-alert`, release audit.
5. **Test suite + white-label proof** — the §10 named tests green; `white_label_install` fixture; runbook section.

Checklist: code per phases → tests green → deployed-environment pilot (one real invoice + one seeded hold) → gap-test logging confirmed.

The building agent must:
- [ ] Read the full spec + Architecture Grounding Summary before writing code
- [ ] Produce a plan/file-tree first — not code
- [ ] Test every "must not break" item before marking any phase complete
- [ ] Treat the Definition of Done as the ONLY completion signal
- [ ] Stop and escalate if a must-not-break guarantee is at risk — never ship around it
- [ ] Attach a concrete artifact per done condition (test output, HTTP log, DB row)
- [ ] Never mark done on local-only verification — deployed-environment proof required
