# RALPH PLANNING MODE

You are ralph-wiggum-loop operating in PLANNING mode.

## Your Only Job This Iteration

Read the specs and produce IMPLEMENTATION_PLAN.md.
Do NOT write any application code. Do NOT write any tests.
Do NOT create any files other than IMPLEMENTATION_PLAN.md.

## Project Context

Project: northstar-ux-v1
Stack: Node 20 + TypeScript ESM + Next.js (App Router) + React + PostgreSQL
Output directory: current working directory
Brownfield: this is a NEW UX layer over the EXISTING ap-hub backend (CHUNK_1-8 pipeline).
The pipeline, src/qbo/write.ts, and src/gatekeeper/forwarder.ts are stable dependencies — DO NOT modify them.

## Read These Files First

1. AGENTS.md — build commands and validation gate
2. specs/*.md — one file per chunk (read all seven)
3. .ralph/guardrails.md — the six guarantees, risks, and scope exclusions (CRITICAL — these are non-negotiable)

## Produce: IMPLEMENTATION_PLAN.md

Format:
```
# IMPLEMENTATION_PLAN.md

## Chunk Order
{List chunks in order with one-sentence descriptions}

## Chunk {N}: {chunk_id}
### Tasks (in order)
1. {specific file/function to create or modify}
2. {next task}
...
### Validation
- Command: npm run lint && npm run typecheck && npm test
- Expected: exit 0, all tests green (including the existing six-guarantee suite)
### Promise
<promise>CHUNK COMPLETE: {chunk_id}</promise>
```

## Rules

- Every chunk from specs/ must appear in the plan (all 7).
- Tasks must be specific enough that a junior developer could execute them without clarification.
- Do not include tasks outside the specs. Scope creep is forbidden (see Do Not Build in guardrails).
- Every action route (approve/reject/remap/learn/retry/reply) must call src/services/* — never re-implement pipeline logic.
- Every DB query must be tenant-scoped. Every action must append audit_log.
- Do not generate code. Generate task descriptions only.
- When done writing IMPLEMENTATION_PLAN.md, stop. Do not proceed to build.

## Completion Signal

When IMPLEMENTATION_PLAN.md is written, append to .ralph/progress.md:
```
[{ISO_TIMESTAMP}] Planning complete — IMPLEMENTATION_PLAN.md written ({N} chunks, {M} tasks)
<promise>PLANNING COMPLETE</promise>
```
Then also output the same promise tag and stop.
