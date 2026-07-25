# Ralph State

**Current Iteration:** 1

Current chunk: CHUNK_2_DATABASE
Current task: 1 of 5
Last completed: CHUNK_1_SHELL (Windows-evidenced; macOS not verified — no machine available)
Status: IN_PROGRESS

## Instructions for ralph

Update this file after every task. Never delete history — append below.
Keep the `**Current Iteration:**` line intact and in that exact format.

Controlling documents:
- `specs/SPEC-local-desktop-shell.md`
- `architecture-decision-packet-ap-hub-local-desktop-2026-07-25.md`
- `IMPLEMENTATION_PLAN.md`
- `.ralph/guardrails.md` — **read the email carve-out before any send-related change**
- `specs/01_CHUNK_1_SHELL.md` … `specs/09_CHUNK_9_PACKAGE.md`

## Standing environment blockers (recorded 2026-07-25)

These are properties of the build environment, not of the code. They cap what any chunk in
this workspace can evidence, and must be restated — never quietly dropped — in any completion
claim that depends on them.

1. **No macOS machine.** macOS host adapters and packaging config are written and typechecked,
   but nothing can be built, signed, notarized or launched on macOS here. Every "on both
   platforms" exit criterion is Windows-only evidenced.
2. **No signing identities.** No Authenticode certificate and no Apple Developer ID /
   notarization credentials. CHUNK_9 can produce an unsigned Windows build only.
3. **No clean VMs.** The clean-machine test plan (packet §18) cannot be executed here.

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

### 2026-07-25 — Workspace re-scaffolded (spec-to-ralphprep, merge mode)

Nine chunk specs written. `AGENTS.md`, `PROMPT_plan.md`, `PROMPT_build.md` and `README.ralph.md`
reconciled off the archived 7-chunk Docker build. `.ralph/guardrails.md`, `IMPLEMENTATION_PLAN.md`
and this file's prior history preserved verbatim. `PROMPT_build.md` had carried a blanket
"never … send email" instruction — replaced with the locked-forwarder carve-out, which requires
**exactly one** send site and treats zero as a defect.

### 2026-07-25 — Iteration 1 — CHUNK_1_SHELL complete

`npm run verify` exit 0. 65 test files, 31 Playwright. No existing test modified. Locked
forwarder intact (exactly one send site). Static export deferred to CHUNK_3 — see DEVIATIONS.md
#4; `next build --output export` cannot run while `app/api/**` exists.

### Pre-reset history (cbv-loc001, archived)

- Iteration 1: committed CBV-LOC001; full `npm run verify` passed.
- Iteration 2: closed the camelCase/concatenated secret-key constraint bypass; verify passed.
- Iteration 3: replaced the secret-key denylist with strict metadata and transport-mode schemas.
- Iteration 4: closed allowed-field value channels, removed free-form refresh messages.
- Iteration 5: closed whitespace/case value-validation bypasses; amended as `78c5522`.
