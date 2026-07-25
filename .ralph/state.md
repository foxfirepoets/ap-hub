# Ralph State

**Current Iteration:** 0

Current chunk: CHUNK_1_SHELL
Current task: 1 of 4
Last completed: none — plan reset 2026-07-25 for the local desktop direction
Status: NOT_STARTED

## Instructions for ralph

Update this file after every task. Never delete history — append below.
Keep the `**Current Iteration:**` line intact and in that exact format.

Controlling documents:
- `specs/SPEC-local-desktop-shell.md`
- `architecture-decision-packet-ap-hub-local-desktop-2026-07-25.md`
- `IMPLEMENTATION_PLAN.md`
- `.ralph/guardrails.md` — **read the email carve-out before any send-related change**

## History

- 2026-07-25: Plan reset. The `cbv-loc001` "Windows local-only runtime" build was stopped at
  CHUNK_1 task 3 and archived to `archive/pre-local-desktop-20260725/`. It targeted a browser UI at
  `127.0.0.1:3000`, which the local desktop direction removes.
- **Retained from that build:** commits `78c5522` (credential schema), `eb150e0` (Windows Credential
  Manager secret store), `fef9d43` (legacy secret migration). All three carry forward unchanged —
  the desktop architecture still stores provider tokens in the OS credential store.
- **Dropped from that build:** the archived CHUNK_2 loopback HTTP session work. Electron IPC removes
  the listening socket it was designed to defend, so the bootstrap-nonce session is not built.
- Prior forensics: `docs/audits/architecture-map-2026-07-25.md`.
- Migration evidence: `docs/audits/electron-migration-inventory-2026-07-25.md` — 14 of 14 pages are
  `'use client'`, 52 route files total 528 lines, and only 2 renderer files perform network I/O.

### Pre-reset history (cbv-loc001, archived)

- Iteration 1: committed CBV-LOC001; full `npm run verify` passed.
- Iteration 2: closed the camelCase/concatenated secret-key constraint bypass; verify passed.
- Iteration 3: replaced the secret-key denylist with strict metadata and transport-mode schemas.
- Iteration 4: closed allowed-field value channels, removed free-form refresh messages.
- Iteration 5: closed whitespace/case value-validation bypasses; amended as `78c5522`.
