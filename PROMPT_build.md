# RALPH BUILD MODE

Read `.ralph/state.md`, `.ralph/progress.md`, `.ralph/guardrails.md`,
`.ralph/errors.log`, `IMPLEMENTATION_PLAN.md`, and `AGENTS.md` before each task.

Implement exactly the current unchecked task. Run `npm run verify`. A task is complete only when
the command exits 0 and output contains no ERROR/FAIL line. Stage exact file names, run the secret
check, commit the task, update state/progress, and append `<promise>TASK_COMPLETE</promise>`.

Never run a future task, skip validation, add public hosting, send email, expose non-loopback
listeners, bypass provider gates, or store plaintext credentials.

When every task in a chunk is complete, append its exact chunk promise. When no unchecked tasks
remain, append `<promise>BUILD COMPLETE</promise>`.

After two failed validation attempts, record the failure and a learned guardrail, mark the task
BLOCKED, and stop rather than grinding.
