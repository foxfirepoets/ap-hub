# SPEC: AP-hub Reviewer Dashboard (CHUNK_8_REVIEWDASH)

## Metadata
- Version: 1.0 | Date: 2026-07-15 | Tier: FULL | Greenfield/Brownfield: Brownfield (adds one chunk to the North Star UX build)
- Status: Ready for Build
- Success measure: From a tenant's real data, generate a self-contained offline HTML dashboard; a reviewer approves/rejects proposals; the exported decisions replay through the existing guarded services applying ONLY approved items — producing postings + audit rows in the QBO sandbox, with all six guarantees still green.
- Architecture grounding: `architecture-decision-packet-ap-hub-northstar-ux-2026-07-14.md` (verdict READY_FOR_SPEC); design source `reviewer-dashboard-guide.md`
- Open questions: 1

## Tech Stack
- Language: TypeScript (ESM, `moduleResolution: Bundler`) + a plain `.mjs` Node generator script.
- Generator: `scripts/build-review-dashboard.mjs` (Node 20, no framework, no deps) — reads a JSON snapshot, injects into an HTML template, writes a self-contained artifact.
- Snapshot producer + replay: existing `src/services/read/*` (read) and `src/services/{approve,proposals}.ts` (replay), invoked via the existing `commander` CLI (`src/cli.ts`).
- DB: PostgreSQL (existing) — **no new tables, no new migration**.
- Dashboard runtime: vanilla HTML + inline CSS + inline JS, `localStorage` for decisions. No backend, no external hosts (CSP-safe).
- Testing: Vitest (unit + DB-backed).

## Architecture Grounding Summary

**Systems touched (new):** `scripts/build-review-dashboard.mjs` (generator), `src/services/review/snapshot.ts` (assembles the read-only JSON snapshot from read services), `src/services/review/apply-decisions.ts` (replay logic), two new `src/cli.ts` subcommands (`review-snapshot`, `apply-review-decisions`), Vitest tests.

**Systems reused (not rebuilt):** `src/services/read/{today,exceptions,transactions,evidence}.ts`, `src/services/approve.ts` (`approveProposal`), `src/services/proposals.ts` (`rejectProposal`), `proof_refs` (verify panel), `src/db/scoped.ts`, `src/config.ts`, `src/logger.ts`, `src/audit.ts`.

**Systems NOT touched (left alone):** `src/qbo/write.ts`, `src/qbo/client.ts`, `src/gatekeeper/forwarder.ts`, the CHUNK_1–8 pipeline. The replay CLI calls existing services; it never writes to QBO/Gmail directly.

**Source of truth (from packet §5):** QBO sandbox = ledger; local Postgres = pipeline state. The dashboard artifact and its `localStorage` decisions are a **transient, offline reviewer scratchpad** — NOT a source of truth. Authority re-enters the system only when decisions are replayed through the guarded services.

**Must NOT break (→ regression tests §10):**
1. No QBO write outside `write.ts`; Gmail unmodified (guarantee 1). Replay approve → `approveProposal` → `write.ts` only.
2. Only send path is the locked forwarder (guarantee 2). Replay touches NO send path.
3. QBO writes sandbox-only (guarantee 3).
4. No double-post (guarantee 4). Replay is idempotent — re-running the same decisions file posts nothing new.
5. Proof-gating holds (guarantee 5). Replay of an item lacking proof coverage → held/exception, never fail-open.
6. White-label = config only (guarantee 6). The generator injects tenant data; no tenant-specific value in code or template.

---

## 1. Executive Summary

AP-hub already lets someone review and approve proposed accounting entries inside the web app. This chunk adds a **portable, offline version of that review**: a single self-contained HTML file, generated from a tenant's real proposals, that a reviewer (typically a CPA who doesn't have live app access) can open anywhere, approve or reject each item with full evidence in front of them, and export their decisions as a file. That decisions file is then fed back through AP-hub's **existing, guarded** approve/reject machinery — applying only the approved items to the QuickBooks sandbox, with the same safety rails as the live app. It never posts on its own and never invents a second way to write. Success in 30 days: generate the dashboard from real data, a reviewer clears a batch offline, and the replay posts exactly the approved items with an audit trail — every guarantee still green. Build size: about **2–3 days** of agent work.

---

## 2. Scope & Do Not Build

**In scope:**
- `src/services/review/snapshot.ts` — assembles a read-only JSON snapshot for one tenant: proposals in `review`/`ready`/`exception` status with vendor, amount (from `proposed_txn`), risk (derived from flags/confidence), source/evidence refs, and `proof_refs` verdicts; plus per-vendor totals and a header summary.
- `src/cli.ts` subcommand `review-snapshot --tenant <id> --out <path.json>` — writes the snapshot (read-only).
- `scripts/build-review-dashboard.mjs` — reads the snapshot JSON, injects it into an HTML template as one escaped `const DATA`, writes `<out>.html` (self-contained: inline CSS+JS, no external fonts/scripts).
- The dashboard artifact (per `reviewer-dashboard-guide.md`): DRAFT stamp, KPI band, per-vendor totals cards (cross-filter the table on click), a proof/verify panel from `proof_refs`, risk chips + vendor select + decision select + search filters, a table with left severity stripe, per-row Approve/Reject, `localStorage` persistence under a run-scoped key `aphub-review-<runId>`, JSON+CSV export, both light/dark themes at the token level, `textContent`-only rendering, tabular-nums figures.
- `src/services/review/apply-decisions.ts` + `src/cli.ts` subcommand `apply-review-decisions <decisions.json> [--tenant <id>]` — replays decisions through existing services: `approved → approveProposal`, `rejected → rejectProposal`; `pending`/unknown → skipped. Idempotent, tenant-scoped, audit-logged; exits non-zero if any approved item fails to post safely.

### Do Not Build
- **A new QBO-write or Gmail-send path** — the replay calls `approveProposal`/`rejectProposal` only; guarantees 1/2/3.
- **A live/hosted dashboard with a backend** — the artifact is deliberately offline/no-backend (the guide's whole point); the exported file is the only wire back. Reason: portability + zero attack surface + works for a reviewer with no system access.
- **Writing decisions from the browser to the DB** — the dashboard has no network calls; `localStorage` + export only. Reason: preserves the single guarded write path.
- **A new "reviewer" role or auth surface** — reuses the existing CPA/owner_controller RBAC; the snapshot CLI is operator-run. Reason: guarantee 6 / no new auth.
- **Editing/ remapping from the dashboard** — offline artifact captures approve/reject only; remap stays in the live app (CHUNK_4). Reason: remap needs live QBO lookups.
- **Changes to `write.ts`, `forwarder.ts`, or the pipeline** — out of scope; they carry the guarantees.

---

## 3. Business Context & Acceptance Criteria

**Goal:** Give a licensed reviewer a portable, evidence-rich, offline way to triage proposed entries, and a safe, guaranteed way to apply their decisions.

**Success target:** Generate → review offline → replay applies ONLY approved items to the QBO sandbox via `write.ts`, with postings + audit rows, and the six-guarantee suite green.

**Acceptance criteria (machine-verifiable):**
- [ ] `cli review-snapshot --tenant T --out s.json` writes valid JSON containing only tenant T's proposals; a foreign tenant's proposal never appears — FAIL if any foreign row present.
- [ ] `node scripts/build-review-dashboard.mjs s.json out.html` writes a file that contains NO `http://`/`https://` resource URLs (no external fonts/scripts/images) — FAIL if any external host reference exists.
- [ ] Every amount in the snapshot is an integer minor-unit value derived from `proposed_txn`; the generator formats at render time — FAIL if a pre-formatted currency string is embedded.
- [ ] The embedded `const DATA` has every `<` escaped to `<`; opening the file and reading a proposal whose vendor name contains `<script>` renders it as text (via `textContent`), not markup — FAIL if it executes or breaks the page.
- [ ] Dashboard: approving a row then reloading the page preserves the decision (localStorage under `aphub-review-<runId>`) — FAIL if lost.
- [ ] Export produces JSON `{run, tenant, exported, summary, decisions:[{id, vendor, risk, amount_cents, decision, finding, source}]}` and a matching CSV — FAIL if `id` is not the stable `proposal_id`.
- [ ] `cli apply-review-decisions d.json` with one `approved` proposal → exactly one new `postings` row (mode=sandbox) + one `audit_log` row; re-running the SAME file → zero additional postings (idempotent) — FAIL on 0 or >1 postings, or a second posting on replay.
- [ ] `apply-review-decisions` applies ONLY `approved`; `rejected` → proposal rejected; `pending`/unknown → skipped, no write — FAIL if a non-approved item posts.
- [ ] An `approved` item lacking proof coverage → held/exception, never fail-open; the CLI exits non-zero and names it — FAIL if it posts unproven.
- [ ] `src/qbo/write.ts`, `src/gatekeeper/forwarder.ts`, pipeline unchanged; full existing guarantee suite (`npm test`) green — FAIL on any regression.

**DONE means ALL true, with an artifact per item (file, DB row, log line):**
1. Each acceptance criterion above, observed by running the commands.
**NOT done if:** verified only by reading code; "tests should pass"; any must-not-break item untested.

---

## 4. Architecture & System Integration

```
[operator] cli review-snapshot --tenant T --out s.json
   └─ src/services/review/snapshot.ts → src/services/read/* (tenant-scoped) → s.json (read-only)

[operator] node scripts/build-review-dashboard.mjs s.json out.html
   └─ reads s.json, injects escaped `const DATA`, writes self-contained out.html

[reviewer, OFFLINE] opens out.html → approve/reject → localStorage → Export → decisions.json
   (no network; the file IS the wire back)

[owner/controller] cli apply-review-decisions decisions.json --tenant T
   └─ src/services/review/apply-decisions.ts
        ├─ approved → src/services/approve.approveProposal → postOnce → src/qbo/write.ts (sandbox, idempotent)
        ├─ rejected → src/services/proposals.rejectProposal
        └─ pending/unknown → skip;  re-verify → nonzero exit on any unsafe approved item
   → postings + audit_log (existing guarded path)
```

New infra: none (no tables, no server). Integration: read services (in), guarded action services (out). Agrees with grounding summary: single write path, offline artifact, tenant-scoped.

---

## 5. User Flows & Happy Path

**Flow A — Generate the packet.** Actor: operator (CLI). Steps: 1) `cli review-snapshot --tenant 1 --out run.json`. 2) `node scripts/build-review-dashboard.mjs run.json review.html`. Postcondition: a self-contained `review.html`, zero external refs, data matches the tenant's proposals. Alt: tenant has no reviewable proposals → snapshot `{proposals:[]}`, dashboard renders an explicit "nothing to review" empty state.

**Flow B — Offline review.** Actor: CPA/reviewer (browser, no system access). Steps: open `review.html` → scan KPI band + per-vendor cards → click a vendor card to cross-filter → open a row's evidence (source email/attachment/proof verdict) → Approve or Reject → repeat → Export JSON. Postcondition: `decisions.json` downloaded; decisions survive reload. Alt: reviewer clicks the active decision again → row returns to pending.

**Flow C — Replay decisions (the loop).** Actor: owner/controller (CLI). Steps: `cli apply-review-decisions decisions.json --tenant 1`. System: for each decision — approved → `approveProposal` (→ sandbox posting via write.ts); rejected → `rejectProposal`; pending/unknown → skip. Re-verify; exit non-zero if any approved item couldn't post safely. Postcondition: only approved items posted, audit rows written. Alt (idempotent): re-running the same file posts nothing new (proposals already `posted_sandbox`).

---

## 6. Data Models & Schema

**No schema changes. No migration.** All data comes from existing tables (`proposals`, `postings`, `exceptions`, `mappings`, `extractions`, `attachments`, `messages`, `proof_refs`) via read services.

**Snapshot JSON (produced by `review-snapshot`):**
```jsonc
{
  "run": "run-<iso-ish-id>", "tenant": 1, "company": "<config company name>",
  "generated": "2026-07-15T...",
  "proposals": [
    { "id": 42,                       // proposal_id — the stable _id for decisions/export
      "vendor": "Plumbing Co.",       // from proposed_txn / mapping
      "amount_cents": 2400000,        // integer minor units from proposed_txn (NUMERIC*100); 0 = no amount
      "risk": "high|med|low",         // derived from flags + extraction confidence
      "issue": "missing project",     // short human label from flags/status
      "source": "invoice.pdf",        // provenance: attachment filename / message subject
      "status": "review|ready|exception",
      "proof": { "product": "invoiceproof", "verdict": "pass|fail|unavailable" } | null }
  ],
  "vendorTotals": [ { "vendor":"Plumbing Co.", "count":7, "amount_cents":16800000 } ],
  "summary": { "count": 21, "ready": 12, "review": 7, "exception": 2, "amount_cents": 51200000 }
}
```
Valid decisions export: `{ "run":"run-x", "tenant":1, "exported":"...", "summary":{...}, "decisions":[ {"id":42,"vendor":"Plumbing Co.","risk":"high","amount_cents":2400000,"decision":"approved","finding":"missing project","source":"invoice.pdf"} ] }`.
Invalid (rejected by replay): a decision whose `id` is not a positive integer, or `decision` ∉ {approved,rejected,pending} → skipped + logged, never posted.

Validation: replay resolves each `id` against the tenant's proposals via `scopedQuery`; ids not belonging to the tenant are skipped (never cross-tenant).

---

## 7. Error Handling & Edge Cases

| Scenario | Status/Exit | Code | Response / Recovery |
|---|---|---|---|
| Snapshot for a tenant with no proposals | exit 0 | (empty) | `{proposals:[]}`; dashboard shows "nothing to review" |
| Generator given malformed snapshot JSON | exit 1 | BAD_SNAPSHOT | Print parse error + path; write no HTML |
| Vendor/label text contains HTML/`<script>` | rendered safe | — | `textContent` + `<`→`<` in DATA; never executes |
| Decisions file references a foreign-tenant id | skip | FOREIGN_ID | Not resolved under tenant scope → skipped + logged |
| Approved item, proof coverage missing | held | HELD_FOR_REVIEW | `approveProposal` returns held; CLI marks it, exits non-zero |
| Approved item already `posted_sandbox` (replay) | skip | ALREADY_POSTED | Idempotent — zero new postings |
| Approved item, QBO API failure | held/exception | QBO_RETRY | Surfaced by `approveProposal`; CLI exits non-zero, names item |
| Decision value unknown / pending | skip | (none) | No write; counted in the CLI summary |
| localStorage unavailable (private mode) | degraded | — | Decisions in-memory for the session; export still works; page warns |

**Edge cases:** duplicate proposal flagged → shown with a duplicate chip (approving still routes through the guarded dedup); a proposal that changed status between snapshot and replay → replay uses live DB status, not the snapshot (source of truth is the DB, not the artifact).

---

## 8. Performance & Scalability

Solo/SMB scale: a snapshot of tens–hundreds of proposals. Generator runs in < 2s for 1,000 rows; HTML stays a single file (< ~1MB for hundreds of rows). Dashboard `render()` rebuilds `<tbody>` on filter in < 50ms for hundreds of rows. Replay is sequential through `approveProposal` (each an existing sandbox round-trip) — throughput bounded by QBO sandbox, not this code; the CLI prints progress per item. No new paid API.

## 9. Security & Compliance

- **Access:** snapshot + replay are operator/CLI actions (owner/controller equivalent); no new auth surface. Reviewer access to the artifact is out-of-band (the operator hands them the file) — matching the CPA "read + evidence/export" role intent.
- **The artifact contains real financial data** → treat as sensitive: it is a local file, no telemetry, no external calls (CSP-safe by construction). Do NOT embed tokens/secrets/bank fields in the snapshot; the snapshot builder must exclude anything the logger redacts (`ssk_`, tokens, bank details). Evidence refs are filenames/subjects/verdicts, not raw secrets.
- **XSS:** all data rendered via `textContent`; `const DATA` has `<`→`<`. No `innerHTML` with data.
- **Write safety:** replay flows only through `approveProposal`/`rejectProposal` → sandbox `write.ts`; no bypass, idempotent, tenant-scoped, audit-logged.
- **Compliance:** none formal (sandbox data, no real payments). Honesty rule: the dashboard never fabricates a number or verdict — every figure comes from the snapshot or is labeled "not available".

## 10. Testing Strategy

**Unit (Vitest):** snapshot risk-derivation + amount extraction (minor units) from `proposed_txn`; `<`-escaping + `textContent` invariants asserted on generator output (grep the HTML for external hosts and for an unescaped injected `<script>`); decisions-file parser (valid/invalid ids, unknown decisions).

**Integration (Vitest + real DB):**
- `review-snapshot` returns only the tenant's proposals; a second tenant's proposal is absent (cross-tenant). Maps to §3.
- `apply-review-decisions`: one approved → exactly one `postings` (mode=sandbox) + one `audit_log`; re-run same file → zero new postings (idempotent, guarantee 4).
- Only approved applied; rejected → rejected; pending/unknown → skipped, no write.
- Approved item without proof coverage → held, CLI non-zero (guarantee 5, proof-gate).
- Generator output contains no `http(s)://` resource refs; injected `<script>` in a vendor name is escaped.

**Regression — must-not-break (existing suite, unchanged):** `no_prod_write`, `send_lockdown`, `proof_fail_safe`, `gatekeeper_hold`, `proof_gate_posting`, `white_label_install`. Gate: `npm run lint && npm run typecheck && npm test` green.

## 11. Deployment & Rollout

N/A — no service change. This ships as CLI subcommands + a `scripts/*.mjs` generator inside the existing repo. Env: reuses existing (`DATABASE_URL`, `QBO_ENV=sandbox`, config company name). "Deploy" = merge the chunk; the generator is run on demand by the operator. Rollback = revert the chunk commit; nothing stateful to undo (no migration).

## 12. API Documentation

No HTTP endpoints. CLI contracts:
```
cli review-snapshot --tenant <id> --out <path.json>
  → writes read-only snapshot JSON (tenant-scoped). Exit 0; exit 1 on unknown tenant / write error.

node scripts/build-review-dashboard.mjs <snapshot.json> <out.html>
  → writes self-contained HTML. Exit 0; exit 1 BAD_SNAPSHOT on parse/validation failure.

cli apply-review-decisions <decisions.json> [--tenant <id>]
  → approved→approveProposal, rejected→rejectProposal, else skip; idempotent, audit-logged.
    Exit 0 if all approved items posted or safely held-with-no-error;
    Exit non-zero if any approved item failed to post safely (names each). Prints a summary:
    {approved_posted, approved_held, rejected, skipped, errors}.
```

## 13. Database Migrations

N/A — no schema changes, no new tables, no migration. (The reviewer dashboard is a read + replay layer over existing tables.) Verification that this stays true: `git diff` touches no file under `migrations/`.

## 14. Known Limitations, Open Questions & Future Work

**Limitations:** decisions live in the reviewer's `localStorage`/exported file, not the DB, until replayed (by design); the snapshot is a point-in-time copy — the DB is authoritative at replay; remap/edit is not available offline (approve/reject only); one tenant per snapshot.

**Open Questions (1):**
1. **Risk-tier derivation** — exact mapping from `proposals.flags` + `extractions.confidence` to `high|med|low`. Resolution action: reuse the SwarmSync severity vocabulary already used by the gatekeeper/digest; default mapping — any critical/bank-change flag → high, confidence < REVIEW_THRESHOLD → med, else low. (Not money/auth-blocking; has a safe default.)

**Future work:** hosted read-only viewer; multi-tenant packet; remap-offline with a queued live-lookup on replay.

## Risks
- **Replay becomes a second write path** if an agent posts to QBO directly instead of via `approveProposal`. Mitigation: apply-decisions may ONLY call `src/services/approve|proposals`; guarantee tests + `git diff` on write.ts catch bypass.
- **Idempotency gap** — replaying a decisions file twice double-posts. Mitigation: rely on the existing `UNIQUE(tenant,idempotency_key)` + status gate; explicit idempotent-replay test.
- **Fail-open on unproven approve** — an approved item without proof coverage posts. Mitigation: `approveProposal` already holds on missing proof; CLI exits non-zero; explicit test.
- **XSS via injected vendor/finding text** in the generated HTML. Mitigation: `textContent`-only + `<`-escaped DATA; generator test greps for the escape + absence of external hosts.
- **Secret/PII leakage into the artifact** (a local file that may be emailed). Mitigation: snapshot excludes redacted fields; test asserts no token-shaped strings in the snapshot.
- **Cross-tenant replay** — a decisions file applied under the wrong tenant. Mitigation: every id resolved via `scopedQuery`; foreign ids skipped; cross-tenant test.

## 15. Glossary

- **Snapshot:** point-in-time read-only JSON of a tenant's reviewable proposals + evidence.
- **Artifact/dashboard:** the self-contained offline HTML file generated from the snapshot.
- **Decisions file:** the reviewer's exported approve/reject choices — the wire back into the system.
- **Replay:** applying decisions through the existing guarded services (`approveProposal`/`rejectProposal`).
- **Run id:** a per-snapshot key namespacing the reviewer's `localStorage` decisions.

## 16. Monitoring & Metrics

Reuses existing pino logging + `audit_log`. The replay CLI prints a per-run summary (`approved_posted/held/rejected/skipped/errors`) and writes audit rows via the existing services. Success-metric query: count postings whose audit trail shows a `apply-review-decisions` actor / batch. No new monitoring infra.

## 17. Alternative Designs Considered

1. **Live hosted reviewer page that writes decisions straight to the DB** — rejected: creates a second write path and a new backend/auth surface (guarantees 1/3/6); the offline artifact + guarded replay is safer and matches the guide.
2. **Reviewer works directly in the existing web app (CHUNK_5)** — kept for online reviewers; this chunk exists specifically for the offline/portable/no-access case the CPA persona needs. Not a strawman — it's the complement.

## 18. Build Phases & Final Checklist

### Build Phases
1. **Snapshot service + CLI** — `src/services/review/snapshot.ts` (tenant-scoped, reuses read services + proof_refs; excludes redacted fields; amounts as minor units) and `cli review-snapshot`. Verifiable: JSON has only the tenant's rows; no token-shaped strings.
2. **Generator + template** — `scripts/build-review-dashboard.mjs` producing the self-contained HTML per `reviewer-dashboard-guide.md` (tokens/both themes, DRAFT stamp, KPI band, per-vendor cards cross-filtering the table, proof panel, filters, severity-stripe table, approve/reject rows, localStorage `aphub-review-<runId>`, JSON+CSV export, `textContent`, `<`-escaped DATA). Verifiable: no external hosts; injected `<script>` escaped; reload persists decisions.
3. **Replay service + CLI** — `src/services/review/apply-decisions.ts` + `cli apply-review-decisions`: approved→`approveProposal`, rejected→`rejectProposal`, else skip; idempotent, tenant-scoped, audit-logged, non-zero exit on unsafe approved item. Verifiable: one approved → one sandbox posting + audit row; re-run → zero new; unproven approved → held + non-zero.
4. **Tests + guarantee regression** — unit + DB integration for all §3 criteria; confirm `write.ts`/`forwarder.ts`/pipeline untouched and the six-guarantee suite green.

### Build Checklist
- [ ] `review-snapshot` tenant-scoped, secret-free, minor-unit amounts
- [ ] Generator output self-contained (no external hosts), XSS-safe (`textContent` + escaped DATA)
- [ ] Dashboard: approve/reject persist in localStorage; JSON+CSV export keyed by proposal_id
- [ ] `apply-review-decisions`: approved-only, idempotent, audit-logged, non-zero on unsafe approve
- [ ] No new QBO-write/Gmail-send path; write.ts/forwarder.ts/pipeline untouched
- [ ] `npm run lint && npm run typecheck && npm test` green (six-guarantee suite included)

### AI Agent Execution Contract
The building agent must:
- [ ] Read the full spec + Architecture Grounding Summary + `reviewer-dashboard-guide.md` before writing code
- [ ] Produce a plan/file-tree first — not code
- [ ] Test every "must not break" item before marking any phase complete
- [ ] Treat the Definition of Done as the ONLY completion signal
- [ ] Stop and escalate if a must-not-break guarantee is at risk — never ship around it
- [ ] Attach a concrete artifact per done condition (test output, generated HTML, DB row)
- [ ] Never mark done on local-only verification — run the commands and observe the outputs
