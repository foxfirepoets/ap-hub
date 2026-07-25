# CHUNK_4_IDENTITY: Make the logged-in OS account the owner and prove accounts cannot reach each other's data.

## Summary

Replaces Google SSO as the product entry point with the operating-system account that already
authenticated the user, writes the non-secret `install.json`, and proves cross-account isolation.
It comes after IPC because the identity must be established on the same seam the service layer
reads. It hands the next chunks an authenticated owner with no password and no hosted login.

Role checks (owner / bookkeeper / CPA) are **unchanged** and still enforced in the service layer.
Removing SSO removes the front door, not the authorization model.

## Acceptance Criteria

- [ ] OS-account identity (Windows SID, macOS UID) is added to `src/host/types.ts`, `src/host/windows.ts` and `src/host/macos.ts` — **macOS is implemented, not stubbed**.
- [ ] `install.json` is written under the install root with install id, OS account id, platform, app version, db port, data directory and log directory.
- [ ] Any key in `install.json` whose name or value resembles a credential is **rejected at load**, as is a `dbPort` outside 1024–65535.
- [ ] A corrupted `install.json` is regenerated from the database and the OS account rather than failing.
- [ ] The OS account holder is the owner; Google SSO is removed as the product entry point from `app/login/page.tsx` and `src/auth/**`, with all tenant and role authorization preserved.
- [ ] An OS-account mismatch fails **closed**.
- [ ] Opening AP-Hub as a different OS account reaches no document, proposal or token belonging to the first account.
- [ ] A second OS account is told in plain language *"This is your own AP-Hub. It doesn't share information with other people who use this computer."* — never shown an unexplained empty database.
- [ ] All tests pass with zero failures (`npm run verify` exits 0).

## Endpoints / Interfaces

No HTTP endpoints. Host adapter additions behind `src/host/types.ts`:

| Interface | Windows | macOS |
|---|---|---|
| `getOsAccountId()` | Current-user SID | Current-user UID |
| `getInstallRoot()` | `%LOCALAPPDATA%\APHub` | `~/Library/Application Support/APHub` |
| `secretStore` | Credential Manager (already built, `src/host/windows.ts:176`) | Keychain |

## Database Changes

- `local_install`: **populated** by this chunk (created in CHUNK_2). One row, `os_account_id` set from the host adapter.

No new tables. No existing table altered.

## Test Scenarios

- **Happy path**: first launch writes one `local_install` row whose `os_account_id` matches the current OS account, and `install.json` round-trips.
- **Edge case**: a corrupted or truncated `install.json` is regenerated from the database and the OS account without user-visible failure; a second OS account gets a distinct install id and the explanatory state.
- **Failure case**: an `install.json` containing a secret-shaped key, or a `dbPort` of `70000`, is rejected at load; an OS-account mismatch fails closed rather than proceeding with the wrong identity.
- **Integration**: CHUNK_5 stores provider tokens under this account's credential-store namespace; CHUNK_7 derives the backup encryption key from it.

## Dependencies

- **Requires**: CHUNK_2_DATABASE (`local_install` table), CHUNK_3_IPC (the service seam identity is read on).
- **Blocks**: CHUNK_5_CONNECT, CHUNK_7_BACKUP.

## Completion Promise

<promise>CHUNK COMPLETE: CHUNK_4_IDENTITY</promise>
