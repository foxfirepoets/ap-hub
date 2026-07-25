# AGENTS.md — ap-hub-pilot-foundation (Phase 1A). From SPEC-pilot-harness-key-broker.md.
# Code is written into the ap-hub REPO ROOT; build agents run with cwd = repo root.
# This ralph-pilot-foundation/ dir holds only state, specs, and prompts.

## Environment

# Tests are DB-backed; vitest does NOT load .env — ALWAYS set DATABASE_URL (see gate below).
# ap-hub broker mode: BROKER_BASE_URL (https), BROKER_INSTALL_TOKEN. Direct mode (dev/tests):
# ANTHROPIC_API_KEY, SWARMSYNC_API_KEY (optional). Broker svc: those two keys + SWARMSYNC_API_BASE/
# WEB_BASE + DATABASE_URL + LOG_LEVEL + PORT (set in Render dashboard, never git).

## Install

```bash
npm install            # from repo root
```

## Database

```bash
DATABASE_URL=postgres://aphub:aphub@127.0.0.1:5432/aphub npm run migrate:up
# broker migrations (added CHUNK_2): applied by broker/src/db migrate runner
```

## Development Server

```bash
npm run dev            # backend :3001    |    npm run web:dev  # Next UI :3000
```

## Test

```bash
# Unit + DB-backed (the suite; baseline = 212)
DATABASE_URL=postgres://aphub:aphub@127.0.0.1:5432/aphub npm test
# Broker tests (added CHUNK_2)
npm --prefix broker test
```

## Lint / Type Check

```bash
npm run lint
npm run lint:noleak    # added CHUNK_5 — provider/OS leakage into core
npm run typecheck
```

## Build (production)

```bash
npm run build && npm run web:build
```

## Validation Commands

```bash
npm run lint && npm run typecheck && DATABASE_URL=postgres://aphub:aphub@127.0.0.1:5432/aphub npm test && npm run web:build
```

# STANDING gate protects the 212 baseline every iteration. Chunk gates ADD (never replace):
# CHUNK_2+ also `npm --prefix broker test`; CHUNK_5+ also `npm run lint:noleak`. NEVER edit a test.
