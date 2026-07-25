# RALPH PLANNING MODE

You are ralph-wiggum-loop operating in PLANNING mode.

## Your Only Job This Iteration

Read the specs and produce IMPLEMENTATION_PLAN.md.
Do NOT write any application code. Do NOT write any tests.
Do NOT create any files other than IMPLEMENTATION_PLAN.md.

## Project Context

Project: onboarding-real-connect-redesign — real Gmail/QuickBooks OAuth wiring for ap-hub's
onboarding wizard, collapsing it to ~2 real required actions. FULL tier (touches real
auth/OAuth-adjacent surfaces — read the risks in .ralph/guardrails.md carefully).
Stack: Next.js App Router + the existing plain Node HTTP server (src/http.ts) + PostgreSQL +
TypeScript ESM + Vitest, on top of the existing ap-hub repo.
Output directory: current working directory (ralph-onboarding-connect/); application code is
written into the ap-hub repo root, NOT into this directory.

## Read These Files First

1. AGENTS.md — build commands and validation gate
2. specs/*.md — one file per chunk (read all 5)
3. .ralph/guardrails.md — known risks and scope exclusions (READ CAREFULLY — this spec touches
   real OAuth/CSRF surfaces; every SIGN in this file matters)
4. The full design spec: ../specs/SPEC-onboarding-real-connect-redesign.md (repo root `specs/`)
   — read this in full; it has the exact acceptance criteria, architecture diagram (§4), and
   error-handling table (§7) the 5 chunk files only summarize.

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

- Every chunk from specs/ must appear in the plan (all 5: CHUNK_1_STATETOKEN, CHUNK_2_REDIRECT,
  CHUNK_3_CONFIG, CHUNK_4_STARTROUTES, CHUNK_5_PAGEREDESIGN) — dependency order matters
  (1 -> 2, 1+3 -> 4, 1+2+3+4 -> 5; see each spec's "Dependencies" section).
- Tasks must be specific enough that a junior developer could execute them without clarification —
  name exact files (e.g. `src/auth/connect-state.ts`, `app/api/connections/gmail/start/route.ts`).
- Do not include tasks outside specs/ or the full design spec. Scope creep is forbidden — see
  .ralph/guardrails.md's Do Not Build list (no write.ts/forwarder.ts/pipeline touch, no rewriting
  the OAuth exchange logic, no company-picker UI, no schema change, no automation_level default
  other than 'off', no recovery key).
- Do not generate code. Generate task descriptions only.
- When done writing IMPLEMENTATION_PLAN.md, stop. Do not proceed to build.

## Completion Signal

When IMPLEMENTATION_PLAN.md is written, append to .ralph/progress.md:
```
[{ISO_TIMESTAMP}] Planning complete — IMPLEMENTATION_PLAN.md written (5 chunks, {M} tasks)
<promise>PLANNING COMPLETE</promise>
```
Then also output the same promise tag and stop.
