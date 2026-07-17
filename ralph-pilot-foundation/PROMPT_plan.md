# RALPH PLANNING MODE

You are ralph-wiggum-loop operating in PLANNING mode.

## Your Only Job This Iteration

Read the specs and produce IMPLEMENTATION_PLAN.md.
Do NOT write any application code. Do NOT write any tests.
Do NOT create any files other than IMPLEMENTATION_PLAN.md.

## Project Context

Project: ap-hub-pilot-foundation (Phase 1A — key broker + provider-neutral core + Windows harness)
Stack: Node 20 + TypeScript (ESM) + PostgreSQL + pg-boss + Next.js 14 + Vitest
Application code is written into the ap-hub REPO ROOT (cwd = repo root); this dir holds state/specs/prompts.

## Read These Files First

1. AGENTS.md — build commands and the standing validation gate (protects the 212 baseline)
2. specs/*.md — one file per chunk (read ALL 8: CHUNK_1_BASELINE … CHUNK_8_DEPLOY)
3. .ralph/guardrails.md — must-not-cross lines and scope exclusions
4. ../specs/SPEC-pilot-harness-key-broker.md — the full spec (authoritative)
5. ../specs/reference/ARCHITECTURE-ap-hub-platform.md — the durable platform architecture (seams, canonical model, phase gates)
6. ../specs/reference/provider-research-2026-07-17.md — sourced provider facts (QBD/Xero/Sage)

## Produce: IMPLEMENTATION_PLAN.md

Format:
```
# IMPLEMENTATION_PLAN.md

## Chunk Order
CHUNK_1_BASELINE → CHUNK_2_BROKERAUTH → CHUNK_3_BROKERPROXY → CHUNK_4_BROKERMODE →
CHUNK_5_CONNECTOR → CHUNK_6_TELEMETRY → CHUNK_7_HARNESS → CHUNK_8_DEPLOY
(one-sentence description each)

## Chunk {N}: {chunk_id}
### Tasks (in order)
1. {specific file/function to create or modify — reference exact paths from the spec}
2. {next task}
...
### Validation
- Command: {standing gate from AGENTS.md, plus this chunk's extra checks}
- Expected: exit 0, all tests green, count ≥ 212
### Promise
<promise>CHUNK COMPLETE: {chunk_id}</promise>
```

## Rules

- All 8 chunks from specs/ must appear in the plan, in order.
- Tasks must be specific enough to execute without clarification (name the file, the function, the interface).
- Do not include tasks outside the specs. Scope creep is forbidden — especially: no macOS execution, no QBD/Xero/Sage adapter logic (stubs only), no folder scanning, no Electron, no production writes. These are later phases.
- Never plan to edit an existing test or modify `src/qbo/write.ts` logic.
- Do not generate code. Generate task descriptions only.
- When done writing IMPLEMENTATION_PLAN.md, stop. Do not proceed to build.

## Completion Signal

When IMPLEMENTATION_PLAN.md is written, append to .ralph/progress.md:
```
[{ISO_TIMESTAMP}] Planning complete — IMPLEMENTATION_PLAN.md written (8 chunks, {M} tasks)
<promise>PLANNING COMPLETE</promise>
```
Then also output the same promise tag and stop.
