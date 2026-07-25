# CHUNK_1_SECRETS: Establish Windows Credential Manager as the only runtime secret authority

## Summary

This chunk adds credential references, provider transport metadata, and a Win32 Credential
Manager implementation behind the existing host seam. It safely migrates legacy DPAPI and
environment-backed secrets without deleting the old copy until read-back verification succeeds.

## Acceptance Criteria

- [ ] Migration 013 creates `credential_refs` and adds constrained transport metadata to `connections`.
- [ ] Standard-user put/get/update/delete works through Windows Credential Manager Generic Credentials.
- [ ] Credential values never enter PostgreSQL, logs, command lines, browser storage, or new files.
- [ ] Injected migration failure preserves the legacy secret and removes any unverified new entry.
- [ ] Existing accounting data and token compatibility remain intact.
- [ ] All tests pass with zero failures.

## Endpoints / Interfaces

No HTTP endpoints — internal host, repository, and migration interfaces only.

## Database Changes

- `credential_refs`: non-secret Windows credential target references (NEW)
- `connections`: adds `transport_mode` and non-secret `transport_config` (ALTER)

## Test Scenarios

- **Happy path**: migrate a legacy secret, read it from Credential Manager, then retire the old value.
- **Edge case**: update and delete an already-missing target idempotently.
- **Failure case**: verification mismatch leaves the old secret readable.
- **Integration**: later auth and provider chunks resolve secrets exclusively through this seam.

## Dependencies

- **Requires**: None
- **Blocks**: CHUNK_2_AUTH, CHUNK_3_GMAIL, CHUNK_4_TRANSPORTS

## Completion Promise

<promise>CHUNK COMPLETE: CHUNK_1_SECRETS</promise>
