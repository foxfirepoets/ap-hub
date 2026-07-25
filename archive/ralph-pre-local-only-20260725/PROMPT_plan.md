# RALPH PLANNING MODE

Read `AGENTS.md`, the full multi-edition spec, all six chunk specs, archaeology, and guardrails.
Produce only `IMPLEMENTATION_PLAN.md`; do not write application code or tests.

Use one independently verifiable checkbox per task:

```markdown
- [ ] CHUNK_N_DOMAIN — specific task naming files/services and its observable result
```

Include all chunks in dependency order. Each task must name validation evidence. Do not combine schema, QBD, statements, drafts, UI, and hardening.

Append `<promise>PLANNING COMPLETE</promise>` to `.ralph/progress.md`, output it, and stop.
