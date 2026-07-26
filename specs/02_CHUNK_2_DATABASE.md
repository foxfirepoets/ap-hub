# CHUNK_2_DATABASE: Bundle a private PostgreSQL that starts invisibly on a probed port and migrates itself.

## Summary

Ships PostgreSQL 16 inside the installer, starts it as a supervised child on its own data directory,
and runs migrations automatically at launch. It comes second because every product operation in
CHUNK_3 needs a database to talk to, and because the port-probing and isolation rules must be proven
before any user data exists. It hands the next chunk a running, migrated database whose connection
details never reach the user.

This chunk also resolves **Open Question 1** — which PostgreSQL distribution to bundle — by spiking
both candidates and choosing on measured installer size and cold-start time.

## Acceptance Criteria

- [ ] Both candidate distributions (official PostgreSQL zip/relocatable build vs `embedded-postgres`) are spiked, and the choice is recorded with **measured** installer size and cold-start numbers, not estimates.
- [ ] PostgreSQL starts as a supervised child on a port probed from 55432 upward, bound to loopback only.
- [ ] With 5432 occupied by a system instance, AP-Hub installs and runs without connecting to, stopping or altering that instance.
- [ ] With 55432 also occupied, the probe resolves upward to the next free port.
- [ ] The bundled instance uses its own private data directory and never writes into an existing PostgreSQL data directory.
- [ ] The chosen port is recorded in `install.json` and in `local_install.db_port`.
- [ ] `migrations/014_local_install.sql` and `migrations/015_backups.sql` apply, with tested DOWN scripts; UP → DOWN → UP stays green.
- [ ] Migrations run automatically at launch inside a transaction; a failed migration leaves the previous version usable.
- [ ] A fresh data directory reaches migration head on first launch.
- [ ] All tests pass with zero failures (`npm run verify` exits 0).

## Endpoints / Interfaces

No HTTP endpoints. Internal interfaces only:

| Interface | Responsibility |
|---|---|
| `probePort(from: number)` | Returns the first free loopback port at or above `from` (55432) |
| `startPostgres(dataDir, port)` | Initializes if absent, starts as a child, resolves when accepting connections |
| `runMigrations(url)` | Applies pending migrations in a transaction; reports typed failure |

Engine → PostgreSQL is loopback TCP on the probed private port, password-protected. This is the only
listening socket the phase adds beyond the transient OAuth callback.

## Database Changes

- `local_install`: single-row install identity — install id, OS account id, platform, app version, db port (NEW)
- `backups`: backup bookkeeping — kind, path, size, manifest hash, row counts, `verified_at`, external copy (NEW)

No existing table is altered. Both DOWN scripts drop only tables this phase created.

**No secret, key or credential is stored in either table.** The backup encryption key lives only in
the OS credential store; `backups` records what exists and whether it verified.

## Test Scenarios

- **Happy path**: fresh data directory → PostgreSQL starts on 55432 → migrations reach head → `SELECT count(*) = 1 FROM local_install` is true.
- **Edge case**: 5432 and 55432 both occupied → probe resolves to 55434 (or next free) and the occupied instances are untouched, verified by connecting to 5432 independently and finding it unchanged.
- **Failure case**: a migration that throws rolls back inside its transaction, surfaces as `DB_FAILED`, and leaves the previous schema version usable — never a half-applied schema.
- **Integration**: CHUNK_3's IPC handlers connect through the pool this chunk configures; CHUNK_7's backup reads the `backups` table this chunk creates.

## Dependencies

- **Requires**: CHUNK_1_SHELL (the main process supervises the PostgreSQL child).
- **Blocks**: CHUNK_3_IPC, CHUNK_4_IDENTITY, CHUNK_7_BACKUP.

## Completion Promise

<promise>CHUNK COMPLETE: CHUNK_2_DATABASE</promise>

<promise>CHUNK COMPLETE: CHUNK_2_DATABASE</promise>
