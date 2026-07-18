# Ralph State

**Current Iteration:** 5

Current chunk: CHUNK_6_TELEMETRY
Current task: 0 of (not yet started)
Last completed: CHUNK_5_CONNECTOR — provider-neutral seam + canonical AP model + connections/migration 006 + lint:noleak. ap-hub 230/230; broker 27/27; green.
Status: CHUNK_COMPLETE (CHUNK_5) → next CHUNK_6_TELEMETRY

## History
- CHUNK_1_BASELINE: 212/212 baseline verified + .env.example port drift fixed (3000→3001). Commit 1beffd6.
- CHUNK_2_BROKERAUTH: broker skeleton + per-install token auth. broker 18/18. Commit 2beae0e.
- CHUNK_3_BROKERPROXY: /v1/extract→Anthropic + 3 SwarmSync proxy routes; upstream.ts fail-closed invariant (never 2xx on upstream failure); spend.ts weekly cap; ratelimit.ts 60/min. broker 27/27 (9 new). Key design: /v1/extract forwards an Anthropic Messages request (prompt-building stays in ap-hub, one place) — spec §12 to align in CHUNK_4.
- CHUNK_4_BROKERMODE: ap-hub broker-mode rewiring; config broker keys optional; 4 outage cases HOLD. ap-hub 221/221; broker 27/27. Commit f0a13fe.
- CHUNK_5_CONNECTOR: src/canonical/ + src/connectors/ (QBO adapter wraps src/qbo delegation-only; qbd/xero/sage stubs throw NotImplementedInPhase); migration 006 blue-green rename postings->postings_ap w/ updatable back-compat view `postings` + v_postings_qbo + connections table (UP→DOWN→UP clean); Provider enum widened; scripts/lint-noleak.mjs + lint:noleak green. ap-hub 230/230 (221 unmodified +9 contract); broker 27/27; write.ts logic untouched; zero test assertions edited (fixture helpers.ts + posting.ts source only).

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
