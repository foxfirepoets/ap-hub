# CHUNK_5_CONNECTOR: Extract the provider-neutral connector seam and canonical AP model (QBO reference)

## Summary

Lay the durable provider-neutral seam so QBD/Xero/Sage can slot in later without touching core. Define the `AccountingConnector` interface + canonical AP model, implement the QBO reference adapter by **wrapping** the existing `src/qbo/` code (delegation only — zero logic change to `write.ts`), and lock the boundary with a contract-test suite + a no-leak lint rule. This is what stops the pilot from rotting into a QBO-only monolith. See `specs/reference/ARCHITECTURE-ap-hub-platform.md` §4–5.

## Acceptance Criteria

- [ ] `src/canonical/` — canonical AP model types (dimensions as an **extensible list**, not fixed columns) + mapping helpers onto existing `proposals.proposed_txn` (JSONB) and `mappings`.
- [ ] `src/connectors/` — `AccountingConnector` + `CapabilityMatrix` + `Unsupported`; **QBO reference adapter wrapping `src/qbo/write.ts`+`client.ts` (delegation only)**; a reusable connector contract-test suite the QBO adapter passes (read vendors/accounts, create bill in sandbox, `readBack` confirms externalId+revision, `verifyCompanyIdentity` → match).
- [ ] QBD/Xero/Sage adapters are capability-declaring **stubs** that throw `NotImplementedInPhase` on `read`/`create`.
- [ ] Additive migration `migrations/006_provider_neutral.sql`: rename `postings.qbo_type→entity_type`, `qbo_id→external_id`, `sync_token→revision`; add back-compat `VIEW v_postings_qbo`; add `connections` table. DOWN fully reverses. UP→DOWN→UP clean.
- [ ] `src/auth/tokens.ts` `Provider` enum widened to `gmail|qbo|xero|sage_intacct|qbd` (enum only).
- [ ] `npm run lint:noleak` added and **green**: no provider identifier (`Bill`,`SyncToken`,`Realm`,`qbo`,`.QBW`,`Xero`,`Intacct`) outside `src/connectors/**`; no OS identifier outside `src/host/**`.
- [ ] **`test/posting.test.ts` passes unmodified** — behavior through the interface is identical to the pre-refactor direct path (same `postings` row, idempotency, `proposal_vs_created` reconciliation).
- [ ] Capability mapping returns `Unsupported` (surfaced + audit-logged) for a field QBO lacks — never silently dropped.
- [ ] `src/qbo/write.ts` logic **unchanged**. Full suite ≥ 212, zero existing tests modified.
- [ ] All tests pass with zero failures.

## Endpoints / Interfaces

No HTTP endpoints — internal service-layer interfaces (`AccountingConnector`, canonical model) + a lint rule.

## Database Changes

- `postings`: columns `qbo_type→entity_type`, `qbo_id→external_id`, `sync_token→revision` (ALTER RENAME, additive, back-compat VIEW)
- `connections`: non-OAuth connection metadata, `connection_class ∈ (cloud|local_desktop)` (NEW)

## Test Scenarios

- **Happy path**: QBO adapter posts a sandbox bill through `AccountingConnector` → same result as today.
- **Edge case**: an unrepresentable canonical field → `Unsupported`, surfaced + audited.
- **Failure case**: a stub adapter `create` call → `NotImplementedInPhase`; `lint:noleak` fails the build if a provider symbol appears in core.
- **Integration**: the seam is what CHUNK_7's host adapter and future 1B/1C provider adapters build against.

## Dependencies

- **Requires**: CHUNK_4_BROKERMODE
- **Blocks**: CHUNK_6_TELEMETRY

## Completion Promise

<promise>CHUNK COMPLETE: CHUNK_5_CONNECTOR</promise>
