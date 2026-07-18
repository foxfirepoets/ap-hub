# Ralph State

**Current Iteration:** 2

Current chunk: CHUNK_3_BROKERPROXY
Current task: 0 of (not yet started)
Last completed: CHUNK_2_BROKERAUTH — broker/ package built (node:http server, Zod config, Pino w/ aph_ redaction, pg + migration runner, installs/heartbeats/spend_ledger migration UP/DOWN verify=3, token issue/revoke/list CLI, bearer auth 401/401/403/200, /health DB probe). broker tests 18/18 green; broker typecheck green; ap-hub suite still 212/212; only broker/ added. Uses separate db aphub_broker on 5432.
Status: CHUNK_COMPLETE (CHUNK_2) → next CHUNK_3_BROKERPROXY

## History
- CHUNK_1_BASELINE: 212/212 baseline verified + .env.example port drift fixed (3000→3001). Commit 1beffd6.

## Baseline (immutable floor)

Test baseline recorded 2026-07-17: **212 passed / 28 files** against
`DATABASE_URL=postgres://aphub:aphub@127.0.0.1:5432/aphub`. Every chunk must keep the
count ≥ 212 with ZERO existing tests modified. A count below 212 = build failure.

## Instructions for ralph

Update this file after every task. Never delete history — append below.
Keep the `**Current Iteration:**` line intact and in that exact format — loop scripts update it via sed.

## Build environment note

Application code is written into the ap-hub repo root (C:\Users\Administrator\Desktop\ap-hub);
build subagents run with cwd = repo root. This ralph-pilot-foundation/.ralph state lives separately.
Postgres must be reachable at 127.0.0.1:5432 (db `aphub`, user `aphub`) and DATABASE_URL must be
set in the environment for `npm test` (vitest does not load .env).
