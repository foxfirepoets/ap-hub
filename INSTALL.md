# AP Hub installation and operating modes

## Choose the correct path

| Audience | Supported path | Result |
|---|---|---|
| Developer or owner-operated Windows machine | `deploy/Install-ap-hub.cmd` | Guided install of PostgreSQL, backend workers, and the web UI |
| Command-line operator | `deploy/install.ps1` | Same installer core without the GUI |
| Managed pilot distributor | `pilot/install-pilot.ps1` | Portable runtime, hosted broker, watchdog, and distributor-supplied credentials |

`deploy/` is the canonical owner/developer installer. `pilot/` is a managed
distribution harness and needs an operator-provisioned broker token and runtime
archives.

## Developer setup

1. Install Node.js 20 or newer.
2. Start PostgreSQL:

   ```powershell
   docker compose up -d db
   docker compose ps
   ```

3. Copy `.env.example` to `.env` and fill every required value. Register:

   - `http://localhost:3000/api/auth/callback` for Google human sign-in;
   - `http://localhost:3001/oauth/gmail/callback` for Gmail;
   - `http://localhost:3001/oauth/qbo/callback` for the Intuit sandbox.

4. Install, migrate, and provision the first owner:

   ```powershell
   npm install
   npm run migrate:up
   npm run cli -- bootstrap-tenant --name "Example Company" --owner-email "owner@example.com"
   ```

5. Start the backend and web UI in separate terminals:

   ```powershell
   npm run dev
   npm run web:dev
   ```

6. Open `http://localhost:3000/api/auth/login?tenant=1`, replacing `1` with
   the tenant id printed by `bootstrap-tenant`.

## Safety boundaries

- QuickBooks Online production is refused; the REST writer targets a sandbox.
- QuickBooks Desktop support is read-only.
- Turning SwarmSync off forces review; it never enables proofless autopost.
- `test:ui-contract` stubs internal APIs and is not live certification.

## Verification levels

```powershell
npm run verify       # static gates, DB-backed tests, web build, UI contract
npm run verify:live  # credential-gated external integration suite
```

Passing `verify` proves repository-level contracts. Live certification also
requires `verify:live`, a clean standard-user install/reboot check, and a real
Gmail-to-QBO-sandbox transaction trace.

## Backup and restore

The database contains financial documents, audit history, and encrypted OAuth
tokens. The encryption key alone is not a database backup.

Before upgrades, create a restricted custom-format PostgreSQL dump:

```powershell
pg_dump --format=custom --file C:\Backups\aphub-YYYYMMDD.dump $env:DATABASE_URL
```

Store it with an offline copy of the matching `ENCRYPTION_KEY`. Periodically
restore into a disposable database and verify row counts and token decryption:

```powershell
createdb aphub_restore_test
pg_restore --clean --if-exists --no-owner --dbname aphub_restore_test C:\Backups\aphub-YYYYMMDD.dump
```

Do not purge local data until a recent backup has been restored successfully.
