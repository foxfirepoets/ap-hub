# CHUNK_3_IPC: Replace all 52 HTTP route handlers with IPC channels that call the same services.

## Summary

Moves every product operation from `app/api/**` HTTP routes onto Electron IPC, so the renderer holds
no network transport and AP-Hub opens no product listening socket. It comes third because it needs
both a window (CHUNK_1) and a database (CHUNK_2), and everything after it assumes IPC is the
transport. It hands the next chunks a service seam where tenant and RBAC checks are proven to still
fire.

**This is the highest-risk chunk in the phase.** Moving 52 routes is exactly where an authorization
check gets silently dropped. The cross-tenant and RBAC replay lands *inside this chunk*, before
CHUNK_7 begins — it is not deferred to the end.

## Acceptance Criteria

- [ ] One IPC dispatcher maps `aphub:<domain>:<action>` channels to the same `src/services/**` entry points the routes called, reusing `runRead` / `runAction` / `runApprove` with a synthesized context.
- [ ] Every handler validates its payload with the existing zod schemas and re-checks tenant and role on every call — the check **moves**, it is not removed.
- [ ] Transport is swapped in exactly the two renderer files that perform network I/O: `app/lib/api.ts` and `app/lib/session.tsx`.
- [ ] All 52 `app/api/**/route.ts` files are deleted, or the specific route is **reported** as taking the per-route embedded-Next fallback. Silent scope widening is a failure.
- [ ] `test/ipc-contract.test.ts` replays the full cross-tenant and role matrices from `test/f5-cross-tenant-isolation.test.ts` against **every** channel.
- [ ] A Playwright network trace shows zero renderer requests to an AP-Hub origin.
- [ ] Zero page components are changed (14 of 14 remain untouched).
- [ ] Every response is `{ ok: true, data }` or `{ ok: false, code, message }` with `message` already plain language — no raw provider text crosses the bridge.
- [ ] All tests pass with zero failures (`npm run verify` exits 0).

## Endpoints / Interfaces

All 52 HTTP routes become IPC channels. Representative contracts:

| Channel | Auth | Request | Response |
|---|---|---|---|
| `aphub:today:list` | any signed-in role | `{}` | `{ ok: true, data: TodayItem[] }` |
| `aphub:proposals:approve` | owner only | `{ proposalId: number }` | `{ ok: true, data: { status: 'approved' } }` |
| `aphub:connections:start` | owner | `{ provider: 'gmail' \| 'qbo' \| 'qbd' }` | `{ ok: true, state: 'browser_opened' }` |
| `aphub:exceptions:list` | any signed-in role | `{}` | `{ ok: true, data: Exception[] }` |

Errors are typed codes only: `FORBIDDEN`, `NOT_FOUND`, `DB_STARTING`, `DB_FAILED`,
`PROVIDER_OFFLINE`, `PROVIDER_REAUTH`, `CONNECT_TIMEOUT`, `SECURE_STORE`.

Two loopback HTTP endpoints remain, **neither reachable by the renderer**: the single-use OAuth
callback on an ephemeral port (CHUNK_5) and the QuickBooks Web Connector SOAP endpoint on Windows.

## Database Changes

No schema changes in this chunk.

## Test Scenarios

- **Happy path**: the renderer calls `aphub:today:list` through the preload bridge and renders the same data the HTTP route returned, with no `fetch` issued.
- **Edge case**: a channel invoked with a payload that fails its zod schema rejects with a typed code and never reaches the service.
- **Failure case**: a caller in tenant A requesting a tenant B resource receives `NOT_FOUND` (never foreign rows), and a bookkeeper invoking an owner-only channel receives `FORBIDDEN` — replayed for every channel, not a sample.
- **Integration**: CHUNK_5 registers its connect channels on this dispatcher; CHUNK_7 registers `aphub:backup:list` and `aphub:backup:restore` on it.

## Dependencies

- **Requires**: CHUNK_1_SHELL (preload bridge), CHUNK_2_DATABASE (a database to serve).
- **Blocks**: CHUNK_4_IDENTITY, CHUNK_5_CONNECT, CHUNK_7_BACKUP.

## Completion Promise

<promise>CHUNK COMPLETE: CHUNK_3_IPC</promise>
