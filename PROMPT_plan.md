# RALPH PLANNING MODE

You are ralph-wiggum-loop operating in PLANNING mode.

## Your Only Job This Iteration

Read the specs and reconcile IMPLEMENTATION_PLAN.md.
Do NOT write application code or tests.

## Project Context

Project: ap-hub — local-first desktop application (Phase P1)
Stack: Electron 32+ · Node.js 20+ TypeScript ESM · React 18 + Next.js 14 static export ·
bundled PostgreSQL 16 · pg-boss · Vitest · Playwright
Output directory: current project root

## Read These Files First

1. `specs/SPEC-local-desktop-shell.md` — the contract
2. `architecture-decision-packet-ap-hub-local-desktop-2026-07-25.md` — why, and the boundaries
3. `.ralph/guardrails.md` — **read the email carve-out before any send-related change**
4. `docs/audits/electron-migration-inventory-2026-07-25.md` — all 52 routes, already inventoried
5. `docs/audits/architecture-map-2026-07-25.md` — what exists and what must not be touched
6. `specs/01_CHUNK_1_SHELL.md` through `specs/09_CHUNK_9_PACKAGE.md`
7. `AGENTS.md` — build commands and the validation gate

Everything in `archive/` is historical. Do not build from it, do not restore it, and do not treat
any spec inside it as a plan.

## Produce: IMPLEMENTATION_PLAN.md

`IMPLEMENTATION_PLAN.md` already exists and is reconciled to this direction. **Merge into it — do
not overwrite it.** Use one `- [ ]` checkbox per independently committable task. Preserve chunk and
dependency order. Name exact files, interfaces and tests. Each chunk must carry its validation step
and the completion promise from its chunk spec.

## Rules

- All nine chunk specs must appear, in dependency order.
- Do not include tasks from archived or historical specs.
- Do not add work outside `specs/SPEC-local-desktop-shell.md`.
- Do not generate code.
- CHUNK_3's cross-tenant and RBAC replay lands inside CHUNK_3 — never deferred to a later chunk.
- **Version 1 is WINDOWS ONLY** (`docs/decisions/windows-only-v1-2026-07-25.md`). Do not plan macOS packaging, signing, notarization or acceptance criteria. Preserve the macOS abstractions; they must keep compiling.
- Append the planning completion entry and promise to `.ralph/progress.md`.

## Completion Signal

Append to `.ralph/progress.md`, then output the same tag:

<promise>PLANNING_COMPLETE</promise>
