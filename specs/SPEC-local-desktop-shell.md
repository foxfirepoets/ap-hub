# SPEC: AP-Hub Local Desktop Shell (Phase P1)

> ## SCOPE AMENDMENT — 2026-07-25: Version 1 is WINDOWS ONLY
>
> macOS is removed from Version 1 development, packaging, signing, notarization, testing,
> documentation and acceptance criteria. Authoritative decision:
> **`docs/decisions/windows-only-v1-2026-07-25.md`** — where this spec still says "both
> platforms" or names macOS as required, that decision wins and this spec is the defect.
>
> Cross-platform abstractions are **preserved and must keep compiling** (`src/host/types.ts`,
> `src/host/macos.ts`). They must never appear in a Version 1 acceptance criterion or
> completion claim. macOS may be reconsidered after the Windows product is proven.

## Metadata
- Version: 1.1 | Date: 2026-07-25 | Tier: FULL | Greenfield/Brownfield: Brownfield
- Status: Ready for Build · **Windows-only Version 1**
- Success measure: On a clean Windows computer with no Node, PostgreSQL, Docker or Git installed, a standard non-admin user installs one downloaded file, double-clicks an icon, and reaches a working AP-Hub window — without a browser, a URL, a port number, or an environment variable ever appearing — and that install can be destroyed and fully restored from its own backup with no data loss.
- Architecture grounding: `architecture-decision-packet-ap-hub-local-desktop-2026-07-25.md` — verdict `READY_FOR_SPEC` · route-by-route migration evidence: `docs/audits/electron-migration-inventory-2026-07-25.md`
- Open questions: 3

## Tech Stack

- Electron 32+ (main process, preload, renderer), packaged with electron-builder
- Node.js 20+ and TypeScript ESM (existing engine, unchanged)
- React 18 + Next.js 14 App Router — **static export** into the renderer, no Next server
- PostgreSQL 16, bundled as a private embedded binary (no Docker, no system install)
- pg + pg-boss for data and durable jobs (existing)
- Vitest for unit and integration tests; Playwright for renderer contract tests
- Windows Credential Manager (Win32 Advapi32) for secrets
- Windows: Task Scheduler autostart, signed NSIS installer
- (macOS LaunchAgent / notarized DMG — OUT OF VERSION 1 SCOPE)

## Architecture Grounding Summary

**Systems touched:** Electron shell (new) · `app/**` React tree (moved, not rewritten) ·
`src/index.ts` boot path · `src/config.ts` · `src/host/**` · `src/auth/session.ts` ·
`src/db/pool.ts` · `src/telemetry.ts` · `src/services.ts` · `src/extract/model.ts` ·
`app/lib/onboardingErrors.ts` · `package.json` · `.env.example`.

**Systems NOT touched:** `src/pipeline/**` · `src/extract/**` (except the broker branch) ·
`src/llm/**` · `src/canonical/**` · `src/accounting/**` · `src/connectors/**` · `src/qbo/**` ·
`src/qbdesktop/**` · `src/statements/**` · `src/gmail/**` · `src/mapping/**` · `migrations/**`.

**Source of truth**

| Entity | Authority |
|---|---|
| Product data (documents, proposals, postings, audit) | Bundled local PostgreSQL |
| Provider tokens | OS credential store (Credential Manager / Keychain) |
| Runtime configuration | `install.json` under the install root, written by the installer |
| User identity | The logged-in OS account (SID on Windows, UID on macOS) |
| Accounting truth | The connected accounting system, via read-back |

**Must not break** (each maps to a regression test in §10): the six guarantee behaviors ·
tenant and RBAC isolation · no double-post · no double-forward · draft-only Gmail replies ·
the locked-forwarder recipient binding · migration UP → DOWN → UP · QBO and QBD posting contracts.

**Reuse decisions:** the entire pipeline, extraction, connector and statement layers are reused
unmodified. The React tree is relocated, not rewritten. `WindowsCredentialManagerSecretStore`
(`src/host/windows.ts:176`, already built and tested) is the credential implementation.

---

## 1. Executive Summary

Today AP-Hub is a web application: you start a server, open Chrome, and type an address. This phase
turns it into a normal desktop program. The user downloads one file, double-clicks it, and gets an
AP-Hub icon. Clicking the icon opens AP-Hub. Everything it needs — the engine, the database, the
background workers — installs and runs invisibly underneath. Nothing about ports, databases, Docker
or settings files is ever shown to them. The screens they see are the same screens that already
exist; only the way AP-Hub is delivered changes. Because everything now lives on their own computer,
this phase also builds the safety net: AP-Hub backs itself up automatically, checks that each backup
can actually be read, and can put everything back with one click if the computer fails. This is
roughly two to three weeks of agent work and it unblocks every later phase, because discovery, the
setup wizard and the extra accounting systems all need a desktop app to live in.

## 2. Scope & Do Not Build

In scope:

- An Electron main process that owns the window, the tray icon, and the lifecycle of every child process.
- A preload bridge exposing a frozen, explicitly enumerated API to the renderer.
- The existing React tree rendered inside Electron, reached by IPC instead of HTTP.
- A bundled private PostgreSQL started as a supervised child on a probed port from 55432 upward.
- Automatic migration execution on first launch and after every update.
- Local owner identity derived from the OS account, replacing Google SSO as the product entry point.
- Provider login opened in the system browser with a loopback callback that returns focus to the app.
- Removal of the hosted key broker, Docker Compose, and every user-facing environment variable.
- Exhaustive plain-language error mapping with no raw-message fallback.
- Local rotating logs and an explicit, redacted support export. No telemetry by default.
- **Encrypted automatic local backup with verification, rotation, one-click restore, repair mode, exportable backup, and an optional user-nominated external copy folder** (architecture packet §7). This is P0 — a local-only product without proven restore is one drive failure from destroying the user's entire AP history.
- Signed Windows installer, non-admin. (macOS installer out of Version 1 scope.)
- Autostart and crash recovery on Windows.
- Uninstall and repair, with data removal as an explicit user choice.

### Do Not Build

> **SCOPE EXPANSION — 2026-07-25.** The owner has pulled discovery, the setup wizard, inference,
> and the Xero / Sage Intacct connectors **into Windows Version 1**. The four entries below are
> therefore **superseded** and are retained only to record what changed. See
> `docs/decisions/windows-only-v1-2026-07-25.md`.

- ~~**Filesystem discovery** — Phase P2.~~ **NOW IN V1 SCOPE.**
- ~~**The eight-screen setup wizard** — Phase P3.~~ **NOW IN V1 SCOPE.**
- ~~**Inference of vendors, accounts or coding patterns** — Phase P3.~~ **NOW IN V1 SCOPE.**
- ~~**Xero and Sage Intacct connectors** — Phase P4.~~ **NOW IN V1 SCOPE.** They must not remain
  silent or indefinite stubs; where live credentials are absent, everything up to the real
  connection boundary ships and only the external proof is marked awaiting credentials.
- **Automatic update checking and delivery** — Phase P4. This phase must not foreclose it (architecture packet §8 fixes the design), and the manual path — download the next signed installer and run it — works from day one without it.
- **Extraction changes of any kind** — the deterministic tier-1 parser and the consent-gated extraction ladder (architecture packet §6) are P2 and P3. Extraction behaves exactly as it does today in this phase.
- **Shared or remote multi-user access** — v1 is one Windows user profile, one install, many companies. The database and credentials belong to that profile; other Windows accounts cannot reach it. Nothing here builds toward shared installs.
- **The Mac ↔ Windows QuickBooks Desktop bridge pairing** — Phase P4.
- **Any new accounting logic, posting path, mapping rule or extraction change** — this is a delivery-shell phase; the engine is reused verbatim.
- **Removal of the locked gatekeeper forwarder** — explicitly retained per the architecture packet §6.
- **Linux packaging** — not required for the initial product.

## 3. Business Context & Acceptance Criteria

Business goal: make AP-Hub installable and usable by someone who has never opened a terminal, so that
later phases can assume a desktop app exists.

Target: a standard non-admin user on a clean machine reaches a working AP-Hub window in under ten
minutes with zero technical questions asked.

- [ ] Double-clicking the installer on a clean Windows machine with no Node, PostgreSQL, Docker or Git produces a working AP-Hub icon. FAIL if any prerequisite must be installed manually.
- [ ] Launching from the icon opens the AP-Hub window with no browser process started by AP-Hub. FAIL if a browser opens for anything except provider login.
- [ ] `Get-NetTCPConnection` (Windows) shows no AP-Hub listening socket other than the bundled PostgreSQL on its probed port and, transiently, the OAuth callback. FAIL on any other listener, and FAIL on any non-loopback binding.
- [ ] The bundled PostgreSQL runs on a probed port at or above 55432 with its own data directory. FAIL if it binds 5432 or writes into an existing PostgreSQL data directory.
- [ ] With a system PostgreSQL already running on 5432, AP-Hub installs and runs without disturbing it. FAIL if the existing instance stops, changes, or is connected to.
- [ ] The renderer performs zero HTTP requests to an AP-Hub origin; every product operation travels over IPC. FAIL if any `fetch` to a local AP-Hub port appears in a renderer network trace.
- [ ] The renderer runs with `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`. FAIL if `window.require`, `window.process` or a Node primitive is reachable from renderer JavaScript.
- [ ] Opening AP-Hub as a different OS account on the same machine does not reach the first account's data or tokens. FAIL if any document, proposal or token is readable across accounts.
- [ ] Connecting Gmail opens the system browser, completes consent, and returns focus to the AP-Hub window with the connection shown as active. FAIL if consent renders inside an Electron window, or if the user must copy a code back manually.
- [ ] Killing the engine, the PostgreSQL child, or both restores them within 90 seconds with jobs intact. FAIL on job loss or duplicate work.
- [ ] Five induced crashes within ten minutes stop the restart loop and show a plain-language message with a next action. FAIL on an unbounded restart loop or a raw error.
- [ ] Rebooting the computer brings AP-Hub back automatically under the same OS account. FAIL if the user must relaunch manually.
- [ ] Every error surface renders mapped plain language. FAIL if any provider message, stack trace, error code, port number, environment-variable name or SQL text reaches the UI.
- [ ] `grep -rn "BROKER_" src/ app/` returns zero results and no runtime path contacts a hosted AP-Hub URL. FAIL on any remaining hosted dependency.
- [ ] `SWARMSYNC_ENABLED` defaults to false and a default install makes no outbound SwarmSync request. FAIL if a fresh install contacts SwarmSync.
- [ ] A repository scan finds exactly one provider-send call site — `sendForward` in `src/gmail/adapter.ts` — and it remains recipient-bound with no recipient parameter. FAIL on zero occurrences (the control was deleted) and FAIL on two or more.
- [ ] A backup runs automatically, is encrypted with a key held only in the OS credential store, and is verified by re-reading it. FAIL if a backup is counted as successful without a verification pass, or if the key is recoverable from disk.
- [ ] **Destroy-and-restore drill:** back up, delete the entire data directory, restore from the AP-Hub UI in one confirmation, and every document count, audit row and posting matches the pre-destruction state exactly. FAIL on any mismatch.
- [ ] Rotation never prunes the last verified backup, and a corrupted backup is reported as failed with a visible plain-language warning. FAIL on silent backup failure or on pruning down to zero verified copies.
- [ ] Restore works from a user-nominated external folder (OneDrive, Drive, Dropbox, network share or external drive). FAIL if the external copy is automatic, or if it targets any AP-Hub-operated location.
- [ ] Repair mode reinstalls program components without altering user data. FAIL if any document, proposal, posting or audit row changes.
- [ ] A second OS account opening AP-Hub is told in plain language that it has its own separate AP-Hub. FAIL if it shows an empty database with no explanation.
- [ ] All existing tests pass unmodified, and `npm run verify` exits 0. FAIL on any weakened or deleted safety test.
- [ ] Uninstall removes program components and asks explicitly what to do with user data. FAIL if data is deleted without asking or left with no way to remove it.

DONE means ALL true in the DEPLOYED environment, with an artifact per item
(HTTP response, DB row, screenshot, log line):
1. Each acceptance criterion is observed on **a clean Windows machine** (Version 1 scope — see
   `docs/decisions/windows-only-v1-2026-07-25.md`), with the `Get-NetTCPConnection` listener
   inspection, the cross-account check, and the crash and reboot drills captured.
   The macOS clean-machine run and the `lsof -i` inspection are **retired from Version 1**.

NOT done if:
- Verified only locally ("works on my machine" is not done)
- "Code looks correct" / "tests should pass" — only observed behavior counts
- Any must-not-break item is untested

## 4. Architecture & System Integration

```text
Electron main ──spawn──► PostgreSQL child (probed port ≥55432, own data dir)
      │        ──spawn──► AP-Hub engine (existing src/index.ts, DB URL injected)
      │        ──ipcMain.handle──► service layer (src/services/**)
      │        ──shell.openExternal──► system browser (provider consent only)
      │        ──http listener──► 127.0.0.1:ephemeral (OAuth callback, single-use)
      ▼
   preload (contextBridge, frozen API)
      ▼
   renderer (existing React tree, statically exported)
```

The engine keeps its own process so a renderer crash cannot take down job processing, and so the
existing `src/index.ts` boot path is reused unchanged. The main process is the only component that
touches the credential store.

**IPC surface.** One channel per existing service operation, named `aphub:<domain>:<action>`. The
preload exposes them as typed functions. Every handler validates its payload with the existing zod
schemas and enforces the same tenant and RBAC checks the HTTP routes enforce today — the check moves,
it is not removed.

**Next.js.** `next build` becomes a static export consumed by the renderer via `file://`. No Next
server runs. The 52 route handlers under `app/api/**` are replaced by IPC handlers that call the same
underlying `src/services/**` functions, so business logic is untouched.

## 5. User Flows & Happy Path

**Actor:** a non-technical business owner on their own Windows or Mac computer.

**Happy path — first install**
Precondition: a clean computer, no developer tooling.
1. Downloads one installer file.
2. Double-clicks it; the installer runs without an administrator prompt.
3. Components install silently; an AP-Hub icon appears.
4. Clicks the icon; AP-Hub opens.
5. On first launch the engine and database start, migrations run, and a progress indicator shows plain-language status.
6. The existing onboarding screens appear inside the window.
Postcondition: AP-Hub is running, its database is local and private, and nothing technical was shown.

**Alternate — connecting a provider**
1. Clicks Connect Gmail.
2. The system browser opens Google's consent screen.
3. Approves; the browser shows "You can close this and return to AP-Hub."
4. The AP-Hub window comes to the front with Gmail shown as connected.
Postcondition: the token is in the OS credential store; PostgreSQL holds only a reference.

**Alternate — a child process dies**
1. The engine is killed by the OS or crashes.
2. The tray icon changes state; the supervisor restarts it within 90 seconds.
3. If five failures occur within ten minutes, restarting stops and the window shows "AP-Hub is having trouble starting. Your information is safe." with a Retry and a Get support export action.

**Alternate — a second OS account opens AP-Hub**
1. A different user on the same machine launches AP-Hub.
2. They get their own empty install state — their own credential-store entries and their own data.
Postcondition: no cross-account read is possible.

## 6. Data Models & Schema

No changes to the existing 13 migrations. Two new migrations add local install identity and backup
bookkeeping (full SQL in §13).

```sql
CREATE TABLE local_install (
  id              SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  install_id      UUID        NOT NULL,
  os_account_id   TEXT        NOT NULL,          -- Windows SID or macOS UID
  platform        TEXT        NOT NULL CHECK (platform IN ('win32','darwin')),
  app_version     TEXT        NOT NULL,
  db_port         INTEGER     NOT NULL CHECK (db_port BETWEEN 1024 AND 65535),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Non-secret runtime facts live in `install.json` under the install root: install id, OS account id,
platform, app version, database port, data directory, log directory. **No secret, token, password or
key may appear in this file** — those live only in the OS credential store.

Valid: `{"installId":"b2c1…","osAccountId":"S-1-5-21-…-1001","platform":"win32","dbPort":55433}`
Invalid (rejected at load): the same object with any additional key whose name or value resembles a
credential, or a `dbPort` outside 1024–65535.

## 7. Error Handling & Edge Cases

Every error the user can reach is mapped. There is **no** raw-message fallback — the current
`app/lib/onboardingErrors.ts:34` behavior of appending `Details: ${fallbackMessage}` is removed.

| Scenario | Code | User-visible message | Recovery |
|---|---|---|---|
| Provider token expired or revoked | `PROVIDER_REAUTH` | "QuickBooks needs to be reconnected. Your information is safe. Sign in again to continue." | Reconnect button |
| Provider unreachable | `PROVIDER_OFFLINE` | "We can't reach QuickBooks right now. We'll keep trying and let you know." | Automatic retry, status in tray |
| Database not ready at launch | `DB_STARTING` | "AP-Hub is starting up." | Progress indicator, then automatic |
| Database will not start | `DB_FAILED` | "AP-Hub couldn't start its storage. Your information is safe." | Repair action; support export |
| Port range exhausted | `DB_FAILED` | same as above | Repair action |
| Migration failed | `DB_FAILED` | same as above | Automatic rollback; previous version remains usable |
| Engine crash-looping | `ENGINE_UNSTABLE` | "AP-Hub is having trouble starting. Your information is safe." | Retry; support export |
| OAuth callback expired | `CONNECT_TIMEOUT` | "That sign-in took too long. Let's try again." | Restart the connect flow |
| OAuth state mismatch or replay | `CONNECT_TIMEOUT` | same as above | Restart the connect flow; the attempt is audited |
| Credential store unavailable | `SECURE_STORE` | "Windows wouldn't let AP-Hub open its secure storage." | Retry; support export |
| Second AP-Hub instance launched | — | Focuses the existing window | Single-instance lock |
| Disk full | `DISK_FULL` | "Your computer is out of space. AP-Hub paused to keep your information safe." | Pauses; resumes when space returns |
| Computer slept mid-job | — | No message | Durable jobs resume; no duplicate work |
| Backup failed or failed verification | `BACKUP_FAILED` | "AP-Hub couldn't finish today's backup. Your information is safe, but please check your available space." | Visible warning until a backup verifies; older verified backups are never pruned |
| Backup encryption key missing | `BACKUP_KEY_MISSING` | "AP-Hub can't open this backup on this computer." | Explains the key lives in this computer's secure storage; offers the current install's backups |
| Restore source unreadable or corrupt | `RESTORE_FAILED` | "That backup can't be read. Your current information hasn't changed." | Current data untouched; offers other verified backups |
| Second OS account opens AP-Hub | — | "This is your own AP-Hub. It doesn't share information with other people who use this computer." | Proceeds with its own install |

**Edge cases:** an existing PostgreSQL on 5432 is never contacted · a corrupted `install.json` is
regenerated from the database and the OS account · a second OS account gets a separate install ·
an antivirus quarantine of a child binary surfaces as `ENGINE_UNSTABLE` with a repair action ·
clock skew does not invalidate durable jobs.

## 8. Performance & Scalability

Realistic single-business scale: one to five users per install, thousands of documents per year.

| Target | Number |
|---|---|
| Installer size | ≤ 200 MB |
| Install duration on a clean machine | ≤ 5 minutes |
| Cold launch to a usable window | ≤ 15 seconds |
| Warm launch | ≤ 4 seconds |
| IPC round trip, p95 | < 100 ms |
| Child restart after a kill | ≤ 90 seconds |
| Idle memory, all processes | ≤ 900 MB |
| Idle CPU | < 2% |

No paid API is introduced by this phase; extraction cost is unchanged and depends on the model the
user chose.

## 9. Security & Compliance

- **Identity.** The owner is the OS account holder. There is no password and no hosted login, because the operating system already authenticated them. Role checks (owner / bookkeeper / CPA) are unchanged and still enforced in the service layer.
- **Renderer.** `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webSecurity` on, a CSP with no remote origins, `shell.openExternal` restricted to an https allowlist of the four provider domains. Navigation to any non-`file://` origin inside the app window is blocked.
- **IPC.** Channels are enumerated and frozen at preload. Handlers validate payloads with zod and re-check tenant and role on every call. The renderer can never name a table, a file path or a SQL fragment.
- **Secrets.** Provider tokens live only in Windows Credential Manager or macOS Keychain. Never in PostgreSQL, `install.json`, logs, command lines, environment variables or renderer storage. The existing redaction in `src/logger.ts` is retained and extended to the new surfaces.
- **Provider login.** System browser only; never an embedded webview. Loopback callback bound to `127.0.0.1`, exact redirect-URI match, single-use state, ten-minute expiry, listener closed immediately after exchange.
- **Locked forwarder.** Retained exactly as documented in the architecture packet §6: disabled by default, owner-only, single bound recipient, no recipient parameter, fully audited, hidden from the basic wizard, and surfaced only under Advanced → Security. Scans assert **exactly one** allowed send site, never zero.
- **Telemetry.** None by default. The support export is explicit, local-first, and redacted.
- **Compliance.** No formal regime applies to a single-tenant local desktop application. Accounting data never leaves the computer except to the systems the user connected.

## 10. Testing Strategy

| Requirement | Test |
|---|---|
| No non-loopback listener | `test/http-security.test.ts` + a platform listener assertion in the install harness |
| Renderer has no Node access | Playwright: `window.require`, `window.process`, `window.module` are all undefined |
| Renderer makes no AP-Hub HTTP calls | Playwright network trace asserts zero requests to a local AP-Hub origin |
| IPC enforces tenant + RBAC | `test/ipc-contract.test.ts` — every channel replays the cross-tenant and role matrices from `test/f5-cross-tenant-isolation.test.ts` |
| PostgreSQL port probing | `test/db-bootstrap.test.ts` — occupied 5432 and occupied 55432 both resolve upward |
| Migrations run on first launch | `test/db-bootstrap.test.ts` — fresh data directory reaches head; UP → DOWN → UP stays green |
| Local install identity | `test/local-install.test.ts` — OS-account mismatch fails closed; secret-shaped keys rejected in `install.json` |
| Supervisor restart + crash ceiling | `test/host-contract.test.ts` — child kill restores; 5 failures in 10 minutes stops with a typed state |
| Error mapping is exhaustive | `test/error-mapping.test.ts` — every code maps to plain language; **asserts no raw fallback path exists** |
| Broker fully removed | `test/no-hosted-dependency.test.ts` — zero `BROKER_` references; no https AP-Hub origin in any runtime path |
| SwarmSync off by default | `test/config.test.ts` — default false; disabled path returns `noop`, never a pass |
| Locked forwarder preserved | `test/lockdown.test.ts` — **exactly one** provider-send site; recipient binding holds; no recipient parameter |
| Backup encrypted, verified, rotated | `test/backup.test.ts` — key resolves only from the credential store; an unverified backup is never counted; rotation never reaches zero verified copies |
| Destroy-and-restore fidelity | `test/backup-restore.int.test.ts` — back up, drop the schema, restore, assert document counts, audit rows and postings match exactly |
| Repair leaves data untouched | `test/backup.test.ts` — row-level before/after comparison across repair |
| Cross-account separation explained | `test/local-install.test.ts` — a foreign OS account yields a distinct install id and the explanatory state, never a silent empty database |
| Six guarantees intact | Existing guarantee tests run unmodified |
| Posting contracts intact | `test/posting.test.ts`, `test/qbd-posting-contract.test.ts`, `test/connector-contract.test.ts` unmodified |
| Clean-machine install | `pilot/validate-clean-install.ps1` (Windows). macOS equivalent retired from V1. |

`npm run verify` remains the gate. Existing safety tests are never edited to accommodate the shell —
a conflict is a stop-and-escalate.

## 11. Deployment & Rollout

There is no server deployment. "Deploy" means producing two signed installers.

| Platform | Build | Signing | Install root | Autostart |
|---|---|---|---|---|
| Windows | `npm run dist:win` → NSIS `.exe` | Authenticode | `%LOCALAPPDATA%\APHub` | Per-user Task Scheduler |
| ~~macOS~~ | *Out of Version 1 scope — see `docs/decisions/windows-only-v1-2026-07-25.md`* | — | — | — |

Signing identities come from the build machine's secret store and are referenced by name only —
never committed. Rollback is reinstalling the previous signed installer; user data is preserved
because the data directory is versioned separately from the program directory, every migration ships
a tested DOWN, and a pre-update backup snapshot is taken before any version change.

**Update delivery in this phase is manual only:** the user downloads the next signed installer and
runs it. Automatic checking against a static signed-manifest endpoint is designed in architecture
packet §8 and built in P4. Nothing here may foreclose it — in particular the pre-update snapshot and
the version field in `local_install` exist so that P4 has what it needs.

Verification after building: install on a clean VM per §14 of the architecture packet, confirm the
listener inspection, the reboot drill and the child-kill drill.

## 12. API Documentation

No public HTTP API exists after this phase. The internal contract is the IPC surface.

```
aphub:connections:start — Auth: owner (OS account holder)
Req:  { provider: 'gmail' | 'qbo' | 'qbd' }
Res:  { ok: true, state: 'browser_opened' }
Err:  CONNECT_TIMEOUT | PROVIDER_OFFLINE | SECURE_STORE

aphub:today:list — Auth: any signed-in role
Req:  { }
Res:  { ok: true, data: TodayItem[] }
Err:  DB_STARTING | DB_FAILED

aphub:proposals:approve — Auth: owner only
Req:  { proposalId: number }
Res:  { ok: true, data: { status: 'approved' } }
Err:  FORBIDDEN | NOT_FOUND | PROVIDER_OFFLINE

aphub:backup:list — Auth: owner only
Req:  { }
Res:  { ok: true, data: Array<{ id, kind, createdAt, sizeBytes, verifiedAt, externalCopy }> }
Err:  DB_STARTING | DB_FAILED
      (never returns the encryption key or a credential-store handle)

aphub:backup:restore — Auth: owner only
Req:  { backupId: number }
Res:  { ok: true, data: { restored: true, rowCounts: Record<string, number> } }
Err:  FORBIDDEN | NOT_FOUND | RESTORE_FAILED | BACKUP_KEY_MISSING
```

Every response is `{ ok: true, data }` or `{ ok: false, code, message }` where `message` is already
plain language. Raw provider text never crosses the bridge.

Two loopback HTTP endpoints remain, neither reachable by the renderer: the single-use OAuth callback
on an ephemeral port, and the QuickBooks Web Connector SOAP endpoint on Windows.

## 13. Database Migrations

```sql
-- UP: 014_local_install.sql
CREATE TABLE local_install (
  id              SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  install_id      UUID        NOT NULL,
  os_account_id   TEXT        NOT NULL,
  platform        TEXT        NOT NULL CHECK (platform IN ('win32','darwin')),
  app_version     TEXT        NOT NULL,
  db_port         INTEGER     NOT NULL CHECK (db_port BETWEEN 1024 AND 65535),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX local_install_singleton ON local_install ((id));
```

```sql
-- UP: 015_backups.sql
CREATE TABLE backups (
  id            BIGSERIAL   PRIMARY KEY,
  kind          TEXT        NOT NULL CHECK (kind IN ('scheduled','pre_migration','pre_update','manual')),
  path          TEXT        NOT NULL,
  size_bytes    BIGINT      NOT NULL CHECK (size_bytes > 0),
  manifest_hash TEXT        NOT NULL,
  row_counts    JSONB       NOT NULL,
  verified_at   TIMESTAMPTZ,                     -- NULL = never counted as a usable backup
  external_copy TEXT,                            -- user-nominated folder, NULL if none
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX backups_verified ON backups (verified_at DESC NULLS LAST, created_at DESC);
```

```sql
-- DOWN: 015_backups.down.sql
DROP INDEX IF EXISTS backups_verified;
DROP TABLE IF EXISTS backups;

-- DOWN: 014_local_install.down.sql
DROP INDEX IF EXISTS local_install_singleton;
DROP TABLE IF EXISTS local_install;
```

**No secret, key or credential is stored in `backups`.** The encryption key lives only in the OS
credential store; this table records what exists and whether it verified. Rotation queries
`verified_at IS NOT NULL` and must never delete the newest verified row.

Verification: `SELECT count(*) = 1 FROM local_install;` after first launch, and a full
UP → DOWN → UP cycle green in `test/accounting-intake-migration.test.ts`. The DOWN drops only a table
this phase created; no existing table is altered. Migrations run automatically at launch, inside a
transaction, with the previous version left usable on failure.

## 14. Known Limitations, Open Questions & Future Work

**Limitations**
- The installer grows to roughly 200 MB because Electron, Node and PostgreSQL are all bundled. This is the accepted cost of "the user installs nothing themselves."
- QuickBooks Desktop remains Windows-only; no Intuit mechanism exists for macOS.
- Windows SmartScreen will warn until the signing certificate builds reputation.
- **Version 1 is Windows only.** macOS is deferred by an explicit scope decision, not by oversight.
- The onboarding screens in this phase are the existing ones. The eight-screen wizard arrives in P3.

**Open Questions**
1. ~~**Which PostgreSQL distribution to bundle**~~ — **RESOLVED 2026-07-25.** Both spikes were built and measured: `docs/audits/postgres-bundling-spike-2026-07-25.md`. Chosen: the **official PostgreSQL Windows binaries**, trimmed to `bin`+`lib`+`share` (119.6 MB), over `embedded-postgres` (99 MB). Decided on release channel — `embedded-postgres` has never shipped a stable release on any line — and on first-launch headroom (12,755 ms vs 14,838 ms against a 15 s budget). The macOS counter-argument for `embedded-postgres` is void under Windows-only V1.
2. **Whether the tray icon should offer Pause processing in P1 or P3** — Resolution: owner's call at the first working build; defaulting to including it, since the supervisor already exposes the state.
3. **Whether an exported backup should be openable on a different computer** — today the encryption key lives only in this machine's credential store, so an exported backup is useless if the machine dies, which is exactly the disaster backups exist for. Resolution: implement machine-bound encryption in this phase and state the limitation plainly in the export copy; evaluate an owner-held recovery phrase as a P2 addition. Flagged because it touches customer data: **this phase ships with the limitation documented, not hidden.**

**Future work:** P2 filesystem discovery · P3 inference and the eight-screen wizard · P4 Xero, Sage
Intacct, macOS validation, the Mac ↔ Windows QuickBooks Desktop bridge, and auto-update.

## Risks

- Electron renderer misconfiguration turning a local compromise into a total one — mitigated by `contextIsolation`, `sandbox`, a frozen preload API, and a CSP with no remote origins.
- Bundled PostgreSQL colliding with a system instance and confusing or corrupting data — mitigated by probing from 55432, a private data directory, and never connecting to 5432.
- A no-send scan finding the locked forwarder and deleting it — mitigated by the architecture packet §6 carve-out, and by `test/lockdown.test.ts` asserting exactly one allowed site rather than zero.
- Moving 52 HTTP routes to IPC silently dropping an authorization check — mitigated by replaying the existing cross-tenant and RBAC matrices against every IPC channel.
- ~~macOS being quietly deferred again~~ — **superseded.** macOS is now deferred by an explicit, documented owner decision (`docs/decisions/windows-only-v1-2026-07-25.md`), not quietly. The abstraction seam is preserved and must keep compiling so a later macOS version stays a thin addition.
- Removing the broker breaking extraction for anyone who relied on it — mitigated by the existing local-runtime and user-key paths in `src/llm/detect.ts`, which are already first-class.
- The 200 MB installer triggering security software — mitigated by signing both installers and recording SmartScreen and Gatekeeper friction in the clean-machine test plan.
- Backup appearing to work but being unrestorable — the classic failure mode — mitigated by verifying every backup by re-reading it, never pruning until a newer copy verifies, surfacing failure visibly, and proving the full destroy-and-restore drill in certification rather than trusting that a file was written.
- The backup encryption key being lost with the machine, making an exported backup useless — mitigated by stating this plainly in the export copy; a later phase may add an owner-held recovery phrase, which this phase must not foreclose.
- Moving 52 routes to IPC while backup work runs in parallel, hiding an authorization regression — mitigated by CHUNK_3 landing the full cross-tenant and RBAC replay before CHUNK_7 begins.

## 15. Glossary

- **Preload / contextBridge** — the only code allowed to pass messages between the AP-Hub window and the program underneath. It exposes a fixed list of operations and nothing else.
- **IPC** — messages passed inside one application between its own parts. Unlike a web request, nothing outside AP-Hub can send one.
- **Loopback** — an address that only reaches the same computer (`127.0.0.1`); it is not on the network.
- **Notarization** — Apple's automated check that a downloaded app is not malware. Without it, macOS refuses to open the app.
- **TCC** — the macOS privacy system that asks permission before an app reads Documents, Desktop or Downloads.
- **qbXML / Web Connector** — the only official way to talk to QuickBooks Desktop; Windows-only.

## 16. Monitoring & Metrics

What actually exists: local rotating JSON logs (10 MiB, 10 files) written by `src/logger.ts` with
existing redaction; a tray icon reflecting engine, database and connection health in words, not
codes; a Settings status panel showing the same; native OS notifications for crash-loop, disk-full
and reconnect-needed states.

Backup health is a first-class surface, not a log line: the Settings panel shows the most recent
verified backup in plain language ("Yesterday, 2:15 AM — checked and readable"), and a failed or
unverified backup raises a visible warning plus a native notification.

Success-metric queries, run against the local database:
`SELECT count(*) FROM local_install WHERE os_account_id = $1;` confirms a single healthy install;
`SELECT max(verified_at) FROM backups;` confirms a usable restore point exists; and the existing
exception counts show whether the pipeline is progressing.

No hosted dashboard, no error-reporting service, no analytics. The support export is explicit and
redacted.

## 17. Alternative Designs Considered

- **Tauri instead of Electron** — smaller binary, but adds a Rust toolchain and sidecar plumbing for a Node engine that already exists; bundle size is not a constraint for this audience.
- **Keep the Next.js server and wrap it in a tray icon** — by far the least work, but the user still lands in a browser tab at an address, which is exactly what the product direction rules out.
- **Loopback HTTP between renderer and engine** — every other local process could reach it, forcing an authentication scheme to defend a door IPC never opens.
- **SQLite instead of bundled PostgreSQL** — would simplify install, but existing tests and guarantees depend on PostgreSQL behavior and rewriting them would break tested accounting logic.

## 18. Build Phases & Final Checklist

### Build Phases

1. **CHUNK_1_SHELL** — Electron main, preload with a frozen API, single-instance lock, tray icon, window lifecycle, hardened renderer settings. Exit: an empty window opens from an icon on Windows and `window.require` is undefined.
2. **CHUNK_2_DATABASE** — bundle PostgreSQL, probe from 55432, private data directory, supervised child, automatic migrations, `014_local_install`. Exit: `test/db-bootstrap.test.ts` green with 5432 and 55432 both occupied; migrations reach head on a fresh directory.
3. **CHUNK_3_IPC** — replace the 52 `app/api/**` routes with IPC channels calling the same `src/services/**` functions; static-export the React tree into the renderer. Exit: `test/ipc-contract.test.ts` replays the full cross-tenant and RBAC matrices; the renderer makes zero AP-Hub HTTP calls.
4. **CHUNK_4_IDENTITY** — OS-account owner identity, `install.json`, removal of Google SSO as the product entry, cross-account isolation. Exit: a second OS account reaches no data of the first.
5. **CHUNK_5_CONNECT** — provider login in the system browser, ephemeral single-use loopback callback, focus return, tokens into the credential store. Exit: Gmail connects end to end with no embedded webview and no manual code copying.
6. **CHUNK_6_CLEANUP** — remove the broker, `compose.yaml` and user-facing environment variables; default SwarmSync off; exhaustive error mapping with the raw fallback deleted; local-only telemetry. Exit: zero `BROKER_` references; `test/error-mapping.test.ts` proves no raw fallback path exists.
7. **CHUNK_7_BACKUP** — encrypted backup with the key in the OS credential store; verify-after-write; rotation that never prunes the last verified copy; one-click restore; repair mode; exportable backup; optional user-nominated external folder; visible failure warnings. Exit: `test/backup-restore.int.test.ts` proves the destroy-and-restore drill with exact count, audit and posting fidelity.
8. **CHUNK_8_SUPERVISION** — autostart on both platforms, child-kill recovery within 90 seconds, bounded crash loop, sleep and network recovery, log rotation, native notifications. Exit: kill, reboot and crash-ceiling drills pass on Windows.
9. **CHUNK_9_PACKAGE** — signed Windows NSIS installer, non-admin install, uninstall with an explicit data choice, repair. Exit: clean-machine install passes on Windows with the full checklist captured, including the destroy-and-restore drill. (macOS DMG out of V1 scope.)

### Final checklist

- [ ] All acceptance criteria observed on a clean Windows machine, with artifacts
- [ ] ~~clean macOS machine~~ — retired from Version 1
- [ ] `npm run verify` exits 0 with no existing test modified
- [ ] Listener inspection captured on Windows (`Get-NetTCPConnection`)
- [ ] Cross-account isolation demonstrated
- [ ] Child-kill, crash-ceiling and reboot drills captured
- [ ] `grep -rn "BROKER_" src/ app/` returns zero
- [ ] Exactly one provider-send call site confirmed by scan
- [ ] Destroy-and-restore drill captured on Windows with matching counts, audit rows and postings
- [ ] Restore from a user-nominated external folder exercised
- [ ] Corrupted-backup handling shows a visible warning and prunes nothing
- [ ] Uninstall and repair exercised, data choice honored

### AI Agent Execution Contract

The building agent must:
- [ ] Read the full spec + Architecture Grounding Summary before writing code
- [ ] Produce a plan/file-tree first — not code
- [ ] Test every "must not break" item before marking any phase complete
- [ ] Treat the Definition of Done as the ONLY completion signal
- [ ] Stop and escalate if a must-not-break guarantee is at risk — never ship around it
- [ ] Attach a concrete artifact per done condition (test output, HTTP log, DB row)
- [ ] Never mark done on local-only verification — deployed-environment proof required
