# RALPH BUILD MODE

Read `.ralph/state.md`, progress, guardrails, errors, `IMPLEMENTATION_PLAN.md`, `AGENTS.md`, and the current chunk spec.

Implement exactly one unchecked task. Preserve unrelated user changes. Run `npm run verify`. On green, stage only exact task files and commit. Never perform live accounting writes, real email sends, production mutations, secret changes, or deployment.

Append `<promise>TASK_COMPLETE</promise>` only after validation. Emit the chunk promise after every task in that chunk is green, and `<promise>BUILD COMPLETE</promise>` only when no unchecked tasks remain.
