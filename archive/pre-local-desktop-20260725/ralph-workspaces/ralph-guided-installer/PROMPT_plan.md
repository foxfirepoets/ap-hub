# RALPH PLANNING MODE

You are ralph-wiggum-loop operating in PLANNING mode.

## Your Only Job This Iteration

Read the specs and produce IMPLEMENTATION_PLAN.md.
Do NOT write any application code. Do NOT write any tests.
Do NOT create any files other than IMPLEMENTATION_PLAN.md.

## Project Context

Project: guided-onboarding-installer (a graphical wrapper for ap-hub's existing CHUNK_6_ONBOARDING)
Stack: Next.js App Router + React + TypeScript ESM + Vitest, on top of the existing ap-hub repo
Output directory: current working directory (ralph-guided-installer/); application code is written
into the ap-hub repo root, NOT into this directory.

## Read These Files First

1. AGENTS.md — build commands and validation gate
2. specs/*.md — one file per chunk (read all 5)
3. .ralph/guardrails.md — known risks and scope exclusions
4. The full design spec: ../specs/SPEC-guided-onboarding-installer.md (repo root `specs/`) — read
   this in full; it has the exact acceptance criteria, error-code table, and UI copy requirements
   the 5 chunk files only summarize.

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
- Command: {validation gate from AGENTS.md}
- Expected: exit 0, all tests green
### Promise
<promise>CHUNK COMPLETE: {chunk_id}</promise>
```

## Rules

- Every chunk from specs/ must appear in the plan (all 5: CHUNK_1_ERRORHELPERS, CHUNK_2_WELCOME,
  CHUNK_3_STEPPER, CHUNK_4_EXPLAINERS, CHUNK_5_INTEGRATION).
- Tasks must be specific enough that a junior developer could execute them without clarification —
  name exact files (e.g. `app/lib/onboardingErrors.ts`, `app/(app)/onboarding/page.tsx`).
- Do not include tasks outside specs/ or the full design spec. Scope creep is forbidden — see
  .ralph/guardrails.md's Do Not Build list (no backend/schema/auth changes, no recovery key,
  no new onboarding step, no DRY_RUN_LOCKED changes, no Playwright rewrite).
- Do not generate code. Generate task descriptions only.
- When done writing IMPLEMENTATION_PLAN.md, stop. Do not proceed to build.

## Completion Signal

When IMPLEMENTATION_PLAN.md is written, append to .ralph/progress.md:
```
[{ISO_TIMESTAMP}] Planning complete — IMPLEMENTATION_PLAN.md written (5 chunks, {M} tasks)
<promise>PLANNING COMPLETE</promise>
```
Then also output the same promise tag and stop.
