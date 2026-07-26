# Guardrails — Known Risks and Scope Exclusions

ralph: before taking any action, scan this file. If your action matches a SIGN, stop and report.

## The one email carve-out (READ THIS BEFORE ANY SEND-RELATED CHANGE)

AP-Hub has **no general email-sending capability**. Exactly **one** call site may invoke a provider
send API:

- `sendForward` in `src/gmail/adapter.ts`, reachable only through `createLockedForwarder` in
  `src/gatekeeper/forwarder.ts`.

It binds a single configured recipient at construction and takes **no recipient parameter**. Its
purpose is documented in plain English in
`architecture-decision-packet-ap-hub-local-desktop-2026-07-25.md` §10: it is the fraud-screening
relay in front of QuickBooks Online's own email-capture address, not an email feature.

### SIGN: a no-send scan expecting zero occurrences
Automated scans must assert **exactly one** allowed occurrence at that named location.
**Zero is a defect — it means the control was deleted.** Any other `messages.send` / `drafts.send`
call, or any path accepting a caller-supplied recipient, is also a defect.

- DO NOT delete the locked forwarder. The owner has explicitly preserved it.
- DO NOT surface it in the basic installation wizard — Advanced → Security only.
- DO NOT enable it by default. `GATEKEEPER_ENABLED` stays false.
- DO NOT let a caller or user-entered payload change the recipient.
- DO NOT conflate it with "Create Gmail draft", which is the ordinary reply workflow and stays on.

## Pre-Loaded Risks (from the local-desktop packet)

### SIGN: Local-only storage with no proven restore
A drive or database failure would destroy the user's entire AP history.
Mitigation: encrypted backup, verify-by-re-reading before counting, rotation that never prunes the
last verified copy, one-click restore, repair mode, and a destroy-and-restore drill in certification.
An unverified backup is a failed backup.

### SIGN: Setup dead-ends without an AI or an API key
Most business owners have neither and must never be asked for one.
Mitigation: deterministic tier-1 extraction works with no AI, no key and no network. Local AI is used
silently when detected. Cloud processing requires explicit plain-language consent. Low confidence
routes to review — never a guess. **The wizard must never display the words API, key, token or model.**

### SIGN: Unrestricted or hidden filesystem scanning
Discovery is broad by nature and could read private data.
Mitigation: absolute denylist (OS dirs, browser profiles, credential stores, media libraries, other
user profiles); metadata-first; explicit per-location consent; visible access log; separate worker
process; never modify a source file without separate permission.

### SIGN: Malicious document reaching the engine
Discovery ingests arbitrary local files.
Mitigation: separate child process; file-type allowlist; size caps; ZIP ratio/depth/total limits;
symlink and junction loop detection with a visited-inode set and depth cap; scan-on-import with
quarantine.

### SIGN: Electron renderer given too much power
Mitigation: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, a frozen enumerated
preload API, a CSP with no remote origins, and `shell.openExternal` restricted to the four provider
domains.

### SIGN: Authorization lost while moving routes to IPC
The 52 route handlers are thin; auth and RBAC live in `src/services/**` behind
`runRead`/`runAction`/`runApprove`.
Mitigation: every IPC channel replays the cross-tenant and role matrices before the chunk closes.

### SIGN: Bundled PostgreSQL colliding with a system instance
Mitigation: probe from 55432 upward, private data directory, never connect to or modify 5432.

### SIGN: SwarmSync disabled treated as verified
Mitigation: optional-for-this-company → continue on AP-Hub's own controls (`noop`);
required-by-policy → send to review; and **never** label an unscanned item "independently verified".

### SIGN: Blind replay after restart
A watchdog restart during an uncertain write could create a duplicate.
Mitigation: durable leases and an authoritative provider query before any retry.

### SIGN: macOS work consuming Windows Version 1 build time
**Superseded by an explicit owner decision (2026-07-25): Version 1 is WINDOWS ONLY.**
See `docs/decisions/windows-only-v1-2026-07-25.md`.
macOS is no longer "quietly deferred" — it is deliberately out of scope. The risk has inverted:
the defect is now spending Version 1 time on macOS packaging, signing, notarization or testing.
Mitigation: `src/host/types.ts` and `src/host/macos.ts` are PRESERVED and must keep compiling so
a later macOS version stays a thin addition — but macOS must never appear in a Version 1
acceptance criterion, gate, or completion claim.

### SIGN: a Windows-only decision used to justify leaking OS specifics into core
Windows-only is a scope reduction, not a licence to hard-code `process.platform` through `src/**`.
Mitigation: `npm run lint:noleak` keeps OS identifiers confined to `src/host/**`. It stays green.

## Scope Exclusions — Do Not Build

- DO NOT BUILD: a hosted AP-Hub application, public AP-Hub URL, tunnel, or inbound relay.
- DO NOT BUILD: browser-based product use, or any address the user must type or bookmark.
- DO NOT BUILD: Google SSO as the product entry point.
- DO NOT BUILD: a Docker or user-installed PostgreSQL requirement.
- DO NOT BUILD: user-facing environment variables, ports, or file paths.
- DO NOT BUILD: raw provider errors, stack traces, or error codes in the UI.
- DO NOT BUILD: mandatory telemetry, or any telemetry without explicit opt-in.
- DO NOT BUILD: a general or arbitrary-recipient email send path (see the carve-out above).
- DO NOT BUILD: LAN or public listener bindings; loopback only.
- DO NOT BUILD: an embedded webview for provider login — system browser only.
- DO NOT BUILD: plaintext secret storage in the database, env, files, logs, commands, or renderer storage.
- DO NOT BUILD: automatically enabled production accounting writes.
- DO NOT BUILD: shared or remote multi-user access — v1 is one computer, one OS account, many companies.
- DO NOT BUILD: QuickBooks web scraping or credential automation.
- DO NOT BUILD: removal of tenant or role isolation.
- DO NOT BUILD: Linux packaging.
- DO NOT BUILD: macOS packaging, signing, notarization, or macOS acceptance criteria — OUT OF VERSION 1 SCOPE (2026-07-25). Do not delete the macOS abstractions; do not spend V1 time on them.

## Standing Guardrails (always active)

- DO NOT add npm dependencies without updating AGENTS.md and lockfiles.
- DO NOT skip the validation gate, even for trivial changes.
- DO NOT commit with --no-verify.
- DO NOT generate code for a future chunk's domain.
- DO NOT edit a safety test to accommodate a connector, shell, or OS adapter. A conflict is a
  stop-and-escalate, not a test edit.
