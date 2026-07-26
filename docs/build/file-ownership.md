# File ownership registry

**Purpose:** no two agents edit the same file at the same time. An agent may only edit files it
owns. Shared files are applied by the integration lead from a submitted patch or interface note.

**Integration lead:** owns the integration branch `feat/local-desktop-p1`, all merges, the full
verification gate, and every shared file below.

## Shared files — serially owned, integration lead only

| File | Why it is shared |
|---|---|
| `package.json`, `package-lock.json` | dependency graph; a concurrent edit corrupts the lockfile |
| `tsconfig.json`, `tsconfig.build.json` | affects every compile unit |
| `electron-builder.yml` | packaging surface; CHUNK_2 and CHUNK_9 both need it |
| `scripts/build-desktop.mjs` | ESM/CJS boundary — see the packaging note below |
| `desktop/main.ts` | every chunk wants to add wiring here |
| `desktop/channels.ts` | the IPC allowlist IS the security boundary |
| `playwright.config.ts` | one worker only (single-instance lock) |
| `migrations/` ordering + `docs/build/migration-reservations.md` | number collisions are silent |
| `.ralph/state.md`, `.ralph/progress.md`, `.ralph/guardrails.md` | build state of record |
| `IMPLEMENTATION_PLAN.md`, `CLAUDE.md`, `AGENTS.md` | controlling documents |

### Standing packaging constraint (do not re-litigate)

`scripts/build-desktop.mjs` builds the Electron main process as **ESM with
`packages: 'external'`**. Bundling a CommonJS dependency (`pg`) into ESM output produces
`Dynamic require of "events" is not supported` at runtime — the app launches, shows a window,
and dies on its first database call. The preload is the opposite case and stays **bundled**,
because a sandboxed preload cannot resolve modules at all. `test/desktop-packaging.test.ts`
and a build-time assertion both enforce this.

## Active assignments

| Agent | Branch | Worktree | Owns | Needs (shared) | Status |
|---|---|---|---|---|---|
| Integration lead | `feat/local-desktop-p1` | `Desktop/ap-hub` | all shared files; merges; gate | — | active |
| A — Database | `agent/database-chunk2` | `ap-hub-worktrees/database` | `src/db/**`, `src/install/**`, `scripts/bundle-postgres.mjs`, `vendor/postgres.lock.json`, `test/local-database*.test.ts` | `desktop/main.ts`, `electron-builder.yml` | **CHUNK_2 complete — merged** |
| B — IPC | `agent/ipc-chunk3` | `ap-hub-worktrees/ipc` | `desktop/ipc/**` (new), per-domain handler modules, IPC schemas, `test/ipc-contract.test.ts` | `desktop/channels.ts`, `desktop/main.ts` | not started |
| C — Discovery | `agent/discovery-wizard` | `ap-hub-worktrees/discovery` | `src/discovery/**` (new), wizard components, inference evidence model | migration number | not started |
| D — Providers | `agent/providers-xero-sage` | `ap-hub-worktrees/providers` | `src/connectors/xero.ts`, `src/connectors/sage.ts`, provider auth adapters | `src/connectors/types.ts` (contract change needs approval) | not started |
| E — QA/packaging | `agent/qa-packaging` | `ap-hub-worktrees/qa-package` | clean-user harness, installer smoke tests, artifact manifest | `electron-builder.yml` | not started |

## Rules

1. Rebase on the integration checkpoint before starting.
2. One independently reviewable task per commit.
3. Run focused tests, then `npm run verify` before handoff where feasible.
4. Push the worker branch; never merge your own branch.
5. Report: commit SHA, changed files, tests run, shared files touched, known limitations.
6. **Never edit a safety test to accommodate a connector, shell or OS adapter.** A conflict is a
   stop-and-escalate.
