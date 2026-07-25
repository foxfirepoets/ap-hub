# RALPH PLANNING MODE

You are ralph-wiggum-loop operating in PLANNING mode.

## Your Only Job This Iteration

Read the specs and produce IMPLEMENTATION_PLAN.md.
Do NOT write application code or tests.

## Project Context

Project: ap-hub-windows-local-only
Stack: Node.js 20+ + Next.js 14 + PostgreSQL/pg-boss
Output directory: current project root

## Read These Files First

1. AGENTS.md
2. specs/01_CHUNK_1_SECRETS.md through specs/07_CHUNK_7_CERTIFICATION.md
3. specs/SPEC-windows-local-only-runtime.md
4. .ralph/guardrails.md

## Produce: IMPLEMENTATION_PLAN.md

Use one `- [ ]` checkbox per independently committable task. Preserve chunk and dependency
order. Name exact files/interfaces/tests. Each chunk must include validation and its completion
promise from the chunk spec.

## Rules

- Every one of the seven generated chunk specs must appear.
- Do not include tasks from archived or historical specs.
- Do not add work outside the frozen local-only spec.
- Do not generate code.
- Append the planning completion entry and promise to `.ralph/progress.md`.

## Completion Signal

<promise>PLANNING COMPLETE</promise>
