# Guardrails — Known Risks and Scope Exclusions

ralph: before taking any action, scan this file. If your action matches a SIGN, stop and report.

## Pre-Loaded Risks (from spec)

### SIGN: Broker fails open on proof checks (HIGHEST)
A proxy in front of a proof service is exactly where a "helpful" default, cached response, or swallowed error turns a HOLD into a silent pass. Nothing else can cause financial harm this quietly.
Mitigation: pass-through rule is absolute; broker never emits 2xx on upstream error; `test/broker-fail-safe.test.ts` covers 500 / refused / empty-200 / malformed-200; existing `proof_fail_safe`/`gatekeeper_hold`/`proof_gate_posting` pass UNMODIFIED.

### SIGN: Install token leaks from a tester's disk
Mitigation: per-install tokens, `revoke --all` kill switch, weekly spend cap enforced BEFORE any upstream call. Bounded + revocable.

### SIGN: Business data leaks into telemetry
Mitigation: closed `event` enum (CHECK), `detail` ≤200 chars, content-assertion test that vendor names/amounts/emails never land in `heartbeats`.

### SIGN: Portable Postgres won't initdb on a real machine (AV / Controlled Folder Access)
Mitigation: explicit `pg_isready` check + plain-English Defender-exclusion message; fail loudly, never silently. (The pilot exists partly to discover this.)

### SIGN: Local-Postgres long-tail corruption / QBD .QBW risk (UNRESOLVED — carried)
Not solvable by this pilot; stays on the risk register. QBD (Phase 1C) reaches the company file only via supported qbXML/Web Connector — NEVER touches .QBW directly. Escalation: cloud-relay pivot if it materializes.

### SIGN: The narrow pilot rots into a Windows/QBO monolith
Mitigation: `lint:noleak` must stay green; `AccountingConnector`/`HostAdapter` contract suites; provider code only in `src/connectors/**`, OS code only in `src/host/**`.

### SIGN: Silent capability loss across providers
Mitigation: `Unsupported` responses + capability matrix + a contract test asserting no silent drop.

### SIGN: Agent "fixes" a failing test instead of the code
The must-not-break list is guarantee-bearing. A failing existing test means YOUR code is wrong. STOP and escalate — never edit the test.

## Scope Exclusions — Do Not Build (Phase 1A)

- DO NOT BUILD: Electron shell (Phase 2 — a user-perception test settles tray-vs-Electron, not a build).
- DO NOT BUILD: code signing / certificate purchase (Phase 2).
- DO NOT BUILD: auto-update / electron-updater / release feed (Phase 2).
- DO NOT BUILD: Windows Service / elevation / admin-rights install (non-elevated Task Scheduler only).
- DO NOT BUILD: production accounting write for ANY provider (sandbox/test/disposable only, all of 1A–1C).
- DO NOT BUILD: macOS EXECUTION (adapter compiled + type-checked only; exercised Phase 1B).
- DO NOT BUILD: QBD / Xero / Sage Intacct adapter LOGIC (capability-declaring stubs that throw NotImplementedInPhase).
- DO NOT BUILD: filesystem / folder / cloud-storage scanning (designed only; Phase 1B+).
- DO NOT BUILD: any `.QBW` file access of any kind.
- DO NOT BUILD: broker-side storage of email/attachment/invoice/extraction data (key + telemetry proxy only).
- DO NOT BUILD: a canonical-model migration that DROPS or rewrites existing columns (additive + back-compat VIEW only).
- DO NOT BUILD: multi-tenant broker / billing / signup / user accounts.
- DO NOT BUILD: installed-app/PKCE Gmail OAuth migration (Phase 2).

## Standing Guardrails (always active)

- DO NOT edit an existing test to make the gate pass (212 floor, zero edits).
- DO NOT modify `src/qbo/write.ts` logic (guarantees 1 & 3 live there; the connector WRAPS it).
- DO NOT let the broker return 2xx when upstream failed.
- DO NOT add npm dependencies without updating AGENTS.md.
- DO NOT skip the validation gate, even for trivial changes.
- DO NOT commit with --no-verify.
- DO NOT generate code for a future chunk's domain.
- DO NOT modify files outside the current task's scope.
- DO NOT hard-code secrets, API keys, or credentials; keys live in Render env vars only.

## Accumulation Instructions

When ralph encounters a new failure pattern, append below:

### Learned: (none yet)
