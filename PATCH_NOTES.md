# PATCH_NOTES — CHUNK_7_BACKUP IPC (branch `agent/chunk7-backup-ipc`)

## What this adds

Three owner-only IPC channels wrapping the existing `src/backup/*` module:

| Channel | Kind | Wrapper |
|---|---|---|
| `aphub:backup:list` | read (GET) | `runListBackups` (`src/backup/http.ts`) |
| `aphub:backup:restore` | action (POST) | `runRestoreBackup` (`src/backup/http.ts`) |
| `aphub:backup:export` | action (POST) | `runExportBackup` (`src/backup/http.ts`) |

New files: `src/backup/http.ts`, `desktop/ipc/read/backup.ts`, `desktop/ipc/action/backup.ts`,
`test/backup-ipc.test.ts`. `backups` has no `tenant_id` column (`migrations/015_backups.sql`) —
it covers the whole local install, not a tenant — so these handlers gate on ROLE only, never
tenant-scope a query.

Neither `list` nor `restore` ever returns the encryption key or a credential-store handle:
`runListBackups` selects only `id/kind/created_at/size_bytes/verified_at/external_copy`, and
`runExportBackup` copies the already-encrypted file byte-for-byte without touching
`BACKUP_ENCRYPTION_KEY_TARGET`.

## No `desktop/main.ts` change needed

`desktop/main.ts` already imports `READ_ENTRIES`/`READ_CHANNELS` and `ACTION_ENTRIES`/
`ACTION_CHANNELS` from the two barrels this branch extends, and `desktop/channels.ts` already
spreads `READ_CHANNELS`/`ACTION_CHANNELS` into `IPC_CHANNELS`. The three new channels flow
through automatically once this branch merges — nothing in `desktop/main.ts` or
`desktop/channels.ts` needs editing.

## One thing the integration lead should verify before packaging (pre-existing gap, not introduced here)

`runRestoreBackup` resolves the live Postgres connection from `process.env.DATABASE_URL` (which
`desktop/main.ts:339` already sets from the running bundled instance) and falls back to
`process.env.APHUB_PG_BIN_DIR` / `APHUB_BACKUP_DIR` for the bundled `pg_restore`/`createdb`/
`dropdb` binaries and the backup directory, defaulting to the dev-checkout path
`vendor/pgsql/bin` when those env vars are unset — the **same** resolution
`backupNightlyHandler` in `src/backup/rotation.ts` already uses, and the same **known gap**
that file's own doc comment flags: this is correct for `npm run dev`, but is **not** the
packaged resource path `desktop/database.ts`'s `postgresRoot()` / `host.postgresBinDir()`
resolves to.

Recommend setting `APHUB_PG_BIN_DIR` / `APHUB_BACKUP_DIR` from the same `binDir`/`dataRoot`
`desktop/database.ts`'s `startDatabase()` already computes, right beside where it sets
`process.env.DATABASE_URL` — this fixes the gap for the nightly job and this IPC surface at
once, since both read the same two env vars.

## Tests / gate

- `npm run lint` — clean
- `npm run lint:noleak` — clean
- `npm run typecheck` — clean
- `npx vitest run` — 84 files, 1742 tests, all green (includes the updated exhaustive
  `test/ipc-contract.test.ts` / `test/ipc-action-domains.test.ts` / `test/ipc-renderer-transport.test.ts`
  contract suites, the new `test/backup-ipc.test.ts`, and every named guarantee test —
  `lockdown.test.ts`, `gatekeeper.test.ts`, `anchor-whitelabel.test.ts`,
  `architecture-connector-path.test.ts` — untouched and passing).

### Files also touched (shared, but not in the forbidden list) and why

- `desktop/ipc/errors.ts` + `app/lib/onboardingErrors.ts` — added the 4 new closed error codes
  (`RESTORE_FAILED`, `BACKUP_KEY_MISSING`, `BACKUP_FAILED`, `DISK_FULL`) the spec requires; the
  two files are asserted to mirror each other 1:1 by `test/error-mapping.test.ts`, and `tsc`
  enforces the mirror via an exhaustive `switch`.
- `app/lib/ipc-routes.ts` — added the 3 new `(method, pathTemplate)` routes; required by
  `test/ipc-renderer-transport.test.ts`'s exhaustive registry↔table parity check.
- `test/ipc-contract.test.ts`, `test/ipc-action-domains.test.ts`, `test/ipc-renderer-transport.test.ts`
  — these are the pre-existing exhaustive, hard-coded-count contract suites (52 → 55 channels
  etc.); every prior chunk that added a channel had to update them the same way. `backup:restore`
  / `backup:export` are documented as a new, deliberate exception to the cross-tenant-isolation
  bucket (they take a required id but `backups` is not tenant-scoped by design) rather than
  forced into either existing bucket.

## Not done (out of scope for this branch)

No Settings UI page for backups exists yet — `app/lib/ipc-routes.ts` gained the route entries
the parity test requires, but no page component calls them. Repair mode and the scheduled/
pre-update backup triggers are pre-existing (`src/backup/rotation.ts`, `repair.ts`) and were not
touched.
