# Ralph State

**Current Iteration:** 1

Current chunk: CHUNK_2_BROKERAUTH
Current task: 0 of (planning not yet run for CHUNK_2)
Last completed: CHUNK_1_BASELINE — baseline verified 212/212 + lint + typecheck + web:build all green; .env.example OAuth port drift fixed (3000→3001 on GMAIL_REDIRECT_URI, QBO_SANDBOX_REDIRECT_URI, PORT). Only .env.example changed; zero source/test files touched.
Status: CHUNK_COMPLETE (CHUNK_1) → next CHUNK_2_BROKERAUTH

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
