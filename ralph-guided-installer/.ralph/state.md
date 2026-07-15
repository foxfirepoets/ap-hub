# Ralph State

**Current Iteration:** 5

Current chunk: none — BUILD COMPLETE
Current task: none
Last completed: CHUNK_5_INTEGRATION — all 5 chunks done. Gate GREEN (189/189) + web:build GREEN (25 routes).
Status: BUILD COMPLETE — CHUNK_1_ERRORHELPERS (f9204c1), CHUNK_2_WELCOME (ba49cd8), CHUNK_3_STEPPER
(f8b980a), CHUNK_4_EXPLAINERS (139b5c8), CHUNK_5_INTEGRATION (2821d82). test/onboarding.test.ts
(11 tests, backend/action layer) re-verified unmodified and green after every chunk. Protected
files (src/qbo/write.ts, src/gatekeeper/forwarder.ts, src/pipeline/**, migrations/**,
src/services/onboarding.ts, app/api/onboarding/**) confirmed untouched across the whole feature.
Next: /HKO-truth-audit, fix any issues, push to github (per operator instruction).

## Instructions for ralph

Update this file after every task. Never delete history — append below.
Keep the `**Current Iteration:**` line intact and in that exact format — loop scripts update it via sed.

## Build environment note

Code is written into the ap-hub repo root (C:\Users\Administrator\Desktop\ap-hub); this
ralph-guided-installer/.ralph state lives separately. The build subagent runs with cwd = the
ap-hub repo root. DATABASE_URL=postgres://aphub:aphub@127.0.0.1:5432/aphub must be reachable
before any iteration (npm test is DB-backed).
