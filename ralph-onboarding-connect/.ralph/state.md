# Ralph State

**Current Iteration:** 5

Current chunk: none — BUILD COMPLETE
Current task: none
Last completed: CHUNK_5_PAGEREDESIGN — all 5 chunks done. Gate GREEN (212/212) + web:build GREEN (27 routes).
Status: BUILD COMPLETE — CHUNK_1_STATETOKEN (9aa7902), CHUNK_2_REDIRECT (43a8938),
CHUNK_3_CONFIG (658d1b8), CHUNK_4_STARTROUTES (a1e7074), CHUNK_5_PAGEREDESIGN (4009c50).
test/onboarding.test.ts (11 tests, backend/action layer) re-verified unmodified and green after
every chunk. Protected files (src/qbo/write.ts, src/gatekeeper/forwarder.ts, src/pipeline/**,
migrations/**) confirmed byte-for-byte untouched across the whole feature. No live Google/Intuit
OAuth round-trip executed (no real provider credentials in this sandbox) — code-level gates only,
disclosed per the spec's own honesty requirement. Next: /HKO-truth-audit, fix any issues, push to
github (per operator instruction).

## Instructions for ralph

Update this file after every task. Never delete history — append below.
Keep the `**Current Iteration:**` line intact and in that exact format — loop scripts update it via sed.

## Build environment note

Code is written into the ap-hub repo root (C:\Users\Administrator\Desktop\ap-hub); this
ralph-onboarding-connect/.ralph state lives separately. The build subagent runs with cwd = the
ap-hub repo root. DATABASE_URL=postgres://aphub:aphub@127.0.0.1:5432/aphub must be reachable
before any iteration. This is a FULL-tier spec (real OAuth/auth-adjacent surfaces) — read
.ralph/guardrails.md carefully before every chunk, not just the first.
