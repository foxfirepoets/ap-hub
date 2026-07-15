# Ralph State

**Current Iteration:** 0

Current chunk: CHUNK_1_ERRORHELPERS
Current task: 0 of TBD (set by planning)
Last completed: (none — not started)
Status: NOT_STARTED

## Instructions for ralph

Update this file after every task. Never delete history — append below.
Keep the `**Current Iteration:**` line intact and in that exact format — loop scripts update it via sed.

## Build environment note

Code is written into the ap-hub repo root (C:\Users\Administrator\Desktop\ap-hub); this
ralph-guided-installer/.ralph state lives separately. The build subagent runs with cwd = the
ap-hub repo root. DATABASE_URL=postgres://aphub:aphub@127.0.0.1:5432/aphub must be reachable
before any iteration (npm test is DB-backed).
