# F4 — Full Connector Rewrite: migration design + guarantee-preservation record

**Approved** (Decision 1): migrate the guarantee tests to the connector boundary, **without**
weakening any guarantee. This document is the mandatory pre-change record. Clean rollback
point before execution: **`b86f764`**.

## Target architecture (the only authorized live path)

`proposed_txn → billFromStored (canonical) → AccountingConnector → QBO adapter → wrapped
QBO write → authoritative read-back → canonical verified result`

`postOnce` must work in **canonical** terms and call only the connector; no `src/pipeline/**`
file may import `src/qbo/write.ts`.

## Interface + code moves (adapter, not pipeline)

1. **Extend `AccountingConnector`** (`src/connectors/types.ts`) with the two things `postOnce`
   still needs that aren't on it yet:
   - `detectDuplicate(record, idempotencyKey): Promise<{ externalId: string; revision: string; raw: unknown } | null>` — replaces the QBO `queryExisting`+`buildDedupWhere` path (Layer-2 dedup). Fail-closed contract: **throws** on an unknown/unavailable result (pipeline holds `dedup_unavailable`), returns `null` when definitively absent, a ref when present.
   - `readonly companyId: string` (or `identity(): {companyId}`) — replaces `writer.realm` for the audit/reconciliation rows.
2. **Move QBO-specific helpers into `src/connectors/qbo.ts`** (delete from `posting.ts`):
   `buildDedupWhere`, `buildQboPayload` (incl. F5 tax + dimension emission), `verifyMatches`,
   `firstDimensionMismatch`, `readBackDimensionValue`. The adapter's `create()` builds the QBO
   payload internally; `readBack()` returns a `CanonicalRecord` whose `canonical` carries the
   normalized amount/docNumber/dimensions so the **pipeline** compares canonical-vs-canonical
   (the QBO shapes `DepartmentRef`/`ClassRef` never leave the adapter).
3. **`postOnce` signature**: `PostDeps.writer: QboWriteClient` → `PostDeps.connector: AccountingConnector`.
   Every current call maps 1:1: `queryExisting→detectDuplicate`, `createEntity→create`,
   `attach→attach`, `readEntity→readBack`, `realm→connector.companyId`, `verifyCompany→connector.verifyCompanyIdentity`.
   The order, gates, and hold/duplicate/posted outcomes are **unchanged**.
4. **Architectural enforcement** (new, fails CI): extend `scripts/lint-noleak.mjs` (or a new
   `lint:no-direct-write`) to error if any file under `src/pipeline/**` imports `../qbo/write`.
   This makes a future bypass impossible to merge.

## Per-test guarantee-preservation record (the 6 files that inject a writer)

For each: (1) guarantee protected · (2) why it can't stay structurally unchanged · (3) exact
change · (4) before→after assertion · (5) equal-or-stricter evidence.

| Test | (1) Guarantee | (2) Why change | (3) Change | (4) Before → After | (5) Strictness |
|---|---|---|---|---|---|
| `posting.test.ts` `create_and_verify` | one sandbox write + read-back + reconciliation | injects `QboWriteClient` mock | mock an `AccountingConnector` (`create`/`readBack`/`detectDuplicate`) | `expect(w.createEntity).toHaveBeenCalledTimes(1)` → `expect(c.create).toHaveBeenCalledTimes(1)` | identical count assertion, same DB-row assertions unchanged → equal |
| `posting.test.ts` `idempotent_double_post` | no double write | writer mock | connector mock | `createEntity` not re-called → `create` not re-called | equal (same "called once" invariant) |
| `posting.test.ts` `replay_after_timeout` | timeout → adopt, no duplicate | writer mock w/ `queryExisting` sequence | connector mock w/ `detectDuplicate` sequence (throw→then-found) | adopt via `queryExisting` → adopt via `detectDuplicate` | equal (same adopt-no-duplicate outcome) |
| `posting.test.ts` `posting_anchor` (+ failure) | anchor recorded; anchor failure never re-creates | writer mock | connector mock | `createEntity` called once after anchor throws → `create` called once | equal |
| `posting.test.ts` `gate_holds` / `proof_gate_posting` | over-ceiling/review/missing-proof never written | asserts `createEntity` not called | asserts `create` not called | `not.toHaveBeenCalled()` on write → on `create` | equal (write is still never reached) |
| `posting.test.ts` `company_mismatch_holds` (F5) | wrong company never written | `verifyCompany`+writer | connector `verifyCompanyIdentity`='mismatch' | hold before `createEntity` → hold before `create` | equal-or-stricter (now via the real connector method) |
| `action.test.ts` | approve→post surfaces qbo_type/qbo_id; role gating | `postDeps(writer)` | `postDeps(connector)` | response-body asserts unchanged; `create` replaces `createEntity` | equal (response contract unchanged) |
| `dry-run-lock-pipeline.test.ts` | `DRY_RUN_LOCKED` blocks posting | writer mock | connector mock | lock holds before any write → before `create` | equal (lock unchanged, still pre-write) |
| `onboarding.test.ts` | automation-off blocks; F1 unlock → 201 | `postDeps(writer)` | `postDeps(connector)` | 403→201 with one posting row; `create` count | equal |
| `review-apply-decisions.test.ts` | reviewer decisions drive posting | `postDeps(writer)` | `postDeps(connector)` | same posted/held outcomes; `create` count | equal |
| `services.test.ts` | service wiring posts through the path | `postDeps(writer)` | `postDeps(connector)` | same outcomes; `create` count | equal |

`lockdown.test.ts` is **NOT** migrated: it asserts the **read** client has no write method
(`(c as any).createEntity).toBeUndefined()` — the `no_qbo_write` guarantee on `client.ts`). It
does not inject a writer into `postOnce` and stays byte-for-byte unchanged.

## Services to update (build `PostDeps`)

`src/services/action/index.ts`, `src/services/approve.ts`, `src/services/onboarding.ts`,
`src/services/review/apply-decisions.ts` build the deps that reach `postOnce`/`postSandboxHandler`.
They construct the connector via `qboConnectorFromDeps` (which already wraps the write+read
clients — delegation only, no second implementation) and pass `connector` instead of `writer`.

## Acceptance for the rewrite (all required, none optional)

- No `src/pipeline/**` imports `../qbo/write` (enforced by the new lint rule).
- `postOnce` calls only the connector; `write.ts` logic unchanged (still the sole write impl,
  wrapped by the adapter — delegation only).
- Every migrated assertion is equal-or-stricter per the table; **zero** guarantee removed,
  weakened, skipped, or broadened.
- Full suite green (≥282, only the 6 migrated files + arch-rule file changed under `test/`).
- `no_prod_write`, `send_lockdown`, `proof_gate_posting`, `gatekeeper_hold`, `proof_fail_safe`,
  `white_label_install` all pass unmodified.

## Status

Design recorded and approved. Execution is an **atomic** change (interface + adapter moves +
`postOnce` + 6 test migrations + 4 services + lint rule) that must land green in one increment;
it is the next unit of work, on top of `b86f764`, with that commit as the rollback point.
