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
| B1 — IPC interfaces | *(integration lead, main checkout)* | `Desktop/ap-hub` | `docs/build/interfaces/**` | — | **frozen — see below** |
| B2 — IPC foundation | `agent/ipc-foundation` | `ap-hub-worktrees/ipc-foundation` | `desktop/ipc/dispatcher.ts`, `desktop/ipc/envelope.ts`, `desktop/ipc/registry.ts`, `desktop/ipc/errors.ts`, `desktop/ipc/context.ts`, `test/ipc-foundation.test.ts` | `desktop/channels.ts`, `desktop/main.ts` | active |
| B3 — IPC read domains | `agent/ipc-read-domains` | `ap-hub-worktrees/ipc-read` | `desktop/ipc/read/**`, `test/ipc-read-*.test.ts` | `desktop/channels.ts` (append via patch request) | queued behind B2 |
| B4 — IPC action domains | `agent/ipc-action-domains` | `ap-hub-worktrees/ipc-action` | `desktop/ipc/action/**`, `test/ipc-action-*.test.ts` | `desktop/channels.ts` (append via patch request) | queued behind B2 |
| B5 — Renderer transport | `agent/ipc-renderer` | `ap-hub-worktrees/ipc-renderer` | `app/lib/api.ts`, `app/lib/session.tsx` **only** | — | queued behind B3+B4 |
| B6 — IPC contract tests | `agent/ipc-contract-tests` | `ap-hub-worktrees/ipc-qa` | `test/ipc-contract.test.ts` | — | queued behind B3+B4 |
| B7 — IPC security verifier | *(read-only, no branch)* | `Desktop/ap-hub` | nothing — reports only | — | queued behind B5+B6 |
| C — Discovery | `agent/discovery-wizard` | `ap-hub-worktrees/discovery` | `src/discovery/**` (new), wizard components, inference evidence model | migration number | not started |
| D — Providers | `agent/providers-xero-sage` | `ap-hub-worktrees/providers` | `src/connectors/xero.ts`, `src/connectors/sage.ts`, provider auth adapters | `src/connectors/types.ts` (contract change needs approval) | not started |
| E — QA/packaging | `agent/qa-packaging` | `ap-hub-worktrees/qa-package` | clean-user harness, installer smoke tests, artifact manifest | `electron-builder.yml` | not started |

### Standing constraint — how CHUNK_3 appends to the channel allowlist

`desktop/channels.ts` is a shared file AND it is **bundled into the sandboxed preload**
(`scripts/build-desktop.mjs`), because a sandboxed preload cannot resolve modules at runtime.
Three agents (B2/B3/B4) each need to register channels. They do NOT edit `channels.ts`.

Instead each owns a **pure channel-list module** that `channels.ts` imports and spreads:

```ts
// desktop/ipc/read/channels.ts   (owned by B3)
export const READ_CHANNELS = ['aphub:today:list', ...] as const;
// desktop/ipc/action/channels.ts (owned by B4)
export const ACTION_CHANNELS = ['aphub:proposals:approve', ...] as const;
```

The integration lead applies the single import+spread edit to `channels.ts` once.

**Hard constraint on those two modules: ZERO imports.** A bare `as const` array of string
literals and nothing else — no Electron, no Node builtins, no `src/**` import, no type import
that pulls in a runtime module. They are dragged into the preload bundle, so anything they
import lands in a sandboxed context that cannot support it. A service import here reproduces
the CHUNK_2 `Dynamic require of "events"` class of failure at the preload layer instead of the
main layer. `test/desktop-packaging.test.ts` guards the main bundle; this constraint is the
preload-side equivalent and B2 must add an assertion for it.

## Rules

1. Rebase on the integration checkpoint before starting.
2. One independently reviewable task per commit.
3. Run focused tests, then `npm run verify` before handoff where feasible.
4. Push the worker branch; never merge your own branch.
5. Report: commit SHA, changed files, tests run, shared files touched, known limitations.
6. **Never edit a safety test to accommodate a connector, shell or OS adapter.** A conflict is a
   stop-and-escalate.
