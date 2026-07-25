# README.ralph.md — AP-Hub Local Desktop Shell (Phase P1)

Scaffolded by spec-to-ralphprep from `specs/SPEC-local-desktop-shell.md` on 2026-07-25.
Merged into an existing workspace — `IMPLEMENTATION_PLAN.md`, `.ralph/state.md` and
`.ralph/guardrails.md` were already reconciled and were **not** overwritten.

## What ralph will build

A local-first desktop application: the user installs one signed file, double-clicks an icon, and
reaches a working AP-Hub window — with no browser, no URL, no port and no environment variable
ever appearing — and that install can be destroyed and fully restored from its own backup.

Chunks (9 total):

- CHUNK_1_SHELL — Electron main, frozen preload, hardened renderer, tray, single-instance lock
- CHUNK_2_DATABASE — bundled private PostgreSQL on a probed port, automatic migrations
- CHUNK_3_IPC — replace 52 HTTP routes with IPC channels; replay cross-tenant + RBAC matrices
- CHUNK_4_IDENTITY — OS-account owner identity, `install.json`, cross-account isolation
- CHUNK_5_CONNECT — provider login in the system browser, single-use loopback callback
- CHUNK_6_CLEANUP — remove the broker, default SwarmSync off, exhaustive plain-language errors
- CHUNK_7_BACKUP — encrypted backup, verify-by-re-read, rotation, one-click restore, repair
- CHUNK_8_SUPERVISION — autostart, child recovery, bounded crash loop, notifications
- CHUNK_9_PACKAGE — signed Windows NSIS + signed/notarized macOS DMG, clean-machine certification

## Prerequisites

- Node.js 20+
- PostgreSQL 16 reachable at `DATABASE_URL` for development and tests (no Docker)
- Electron 32+ and electron-builder (installed as devDependencies)
- For CHUNK_9 only: an Authenticode signing certificate and an Apple Developer ID + notarization
  credentials, plus a clean Windows VM and a clean macOS machine

## Setup Before First Run

```bash
npm install
npm run migrate:up
```

## Controlling Documents

Read in this order — do not start from memory:

1. `specs/SPEC-local-desktop-shell.md`
2. `architecture-decision-packet-ap-hub-local-desktop-2026-07-25.md`
3. `.ralph/guardrails.md` — **read the email carve-out before any send change**
4. `docs/audits/electron-migration-inventory-2026-07-25.md`
5. `docs/audits/architecture-map-2026-07-25.md`

Everything in `archive/` is historical. Do not build from it.

## Validation

```bash
npm run verify
```

The gate must exit 0 with **no existing test modified**.

## Chunk Completion

Each chunk ends with its promise appended to `.ralph/progress.md`:
`<promise>CHUNK COMPLETE: {CHUNK_ID}</promise>`.
Do not start a chunk before the previous one's promise line is appended.

## Warnings from spec parsing

- The spec fixes **9** chunks (§18), above the skill's 5–8 guidance. Kept at 9 — the chunk
  boundaries are contractual, not derived.
- `IMPLEMENTATION_PLAN.md` already existed and was merged into, not regenerated.
- Three open questions are carried into the build: the PostgreSQL distribution choice (CHUNK_2),
  the tray Pause control (CHUNK_1), and cross-machine backup portability (CHUNK_7).
