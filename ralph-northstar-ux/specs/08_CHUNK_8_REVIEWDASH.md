# CHUNK_8_REVIEWDASH: Generate an offline reviewer dashboard and replay its decisions through the guarded services

## Summary

Adds a portable, offline review capability on top of the North Star UX build. A build-time Node generator turns a tenant's current proposals/exceptions (+ evidence + SwarmSync proof verdicts) into a single self-contained HTML artifact — no backend, no framework, no external hosts — where a licensed reviewer (CPA persona) approves/rejects each item and exports decisions. A CLI then replays those decisions **only through the existing guarded services** (`approveProposal`/`rejectProposal`), applying approved items to the QBO sandbox with the same rails as the live app. Comes last; depends on the read + action service layers (CHUNK_2/3/4). No new tables, no new migration, no new QBO-write/Gmail-send path. Design source: `reviewer-dashboard-guide.md`; full spec: `specs/SPEC-reviewer-dashboard.md`.

## Acceptance Criteria

- [ ] Task 1 — `src/services/review/snapshot.ts` + `cli review-snapshot --tenant <id> --out <path.json>` writes a read-only, tenant-scoped snapshot (proposals with vendor, integer minor-unit amount from `proposed_txn`, derived risk, source/evidence refs, `proof_refs` verdict, per-vendor totals, summary); a foreign tenant's proposal never appears; no token/secret-shaped strings present.
- [ ] Task 2 — `scripts/build-review-dashboard.mjs <snapshot.json> <out.html>` writes a self-contained artifact (inline CSS+JS, NO `http(s)://` resource refs); `const DATA` has `<` escaped to `<`; all data rendered via `textContent` (an injected `<script>` in a vendor name renders as text); DRAFT stamp, KPI band, per-vendor cards cross-filtering the table, proof panel, risk/vendor/decision filters + search, severity-stripe table, per-row Approve/Reject persisted in `localStorage` under `aphub-review-<runId>` (survives reload), JSON+CSV export keyed by `proposal_id`, both light/dark themes at the token level.
- [ ] Task 3 — `src/services/review/apply-decisions.ts` + `cli apply-review-decisions <decisions.json> [--tenant <id>]`: approved → `approveProposal`, rejected → `rejectProposal`, pending/unknown → skip; one approved item → exactly one sandbox `postings` row + one `audit_log` row; re-running the same file → zero new postings (idempotent); an approved item lacking proof coverage → held, CLI exits non-zero and names it; foreign-tenant ids skipped.
- [ ] Task 4 — Vitest unit + DB tests cover every acceptance criterion above; `src/qbo/write.ts`, `src/gatekeeper/forwarder.ts`, and the pipeline are confirmed untouched; the six-guarantee suite is green.
- [ ] All tests pass with zero failures.

## Endpoints / Interfaces

No HTTP endpoints — CLI subcommands + a Node generator script (internal/operator tools).

| Interface | Description |
|---|---|
| `cli review-snapshot --tenant <id> --out <path.json>` | Read-only tenant snapshot (reuses `src/services/read/*` + proof_refs) |
| `node scripts/build-review-dashboard.mjs <snapshot.json> <out.html>` | Self-contained offline HTML artifact |
| `cli apply-review-decisions <decisions.json> [--tenant <id>]` | Replay decisions via `approveProposal`/`rejectProposal` only |

## Database Changes

No schema changes in this chunk. No new tables, no migration. All data is read from existing tables (`proposals`, `postings`, `exceptions`, `mappings`, `extractions`, `attachments`, `messages`, `proof_refs`) via existing read services, and written back only through the existing guarded action services.

## Test Scenarios

- **Happy path**: snapshot a tenant → generate HTML → (export a decisions file) → `apply-review-decisions` posts exactly the approved items to the sandbox with audit rows.
- **Edge case**: vendor/finding text containing `<script>` is escaped in `DATA` and rendered via `textContent`; generator output has zero external hosts.
- **Failure case**: an approved item without proof coverage → held, never fail-open; CLI exits non-zero. Re-running the same decisions file posts nothing new (idempotent).
- **Integration**: replay flows only through `src/services/approve.ts`/`proposals.ts` → `write.ts` (sandbox); `write.ts`/`forwarder.ts`/pipeline untouched; six-guarantee suite green.

## Dependencies

- **Requires**: CHUNK_2_SERVICES (approve/reject), CHUNK_3_READ (read services + evidence). (Independent of CHUNK_6/7.)
- **Blocks**: None (final chunk).

## Completion Promise

<promise>CHUNK COMPLETE: CHUNK_8_REVIEWDASH</promise>
