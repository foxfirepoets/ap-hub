# AGENTS.md — Build, Test, and Validation Commands
# Project: ap-hub — local-first Windows desktop application (Version 1)
# Scope: WINDOWS ONLY — docs/decisions/windows-only-v1-2026-07-25.md
# Spec: specs/SPEC-local-desktop-shell.md

## Environment

No user-facing environment variables ship in this phase. Runtime facts live in `install.json`
under the install root; secrets live only in the OS credential store. Tests read `DATABASE_URL`
(default `postgres://aphub:aphub@127.0.0.1:5432/aphub`, see `test/setup.ts`).

```bash
cp .env.example .env
```

## Install

```bash
npm install
```

## Database

There is no Docker. Point `DATABASE_URL` at any PostgreSQL 16 instance for development and tests.
The shipped product starts its own bundled PostgreSQL on a probed port at or above 55432.

```bash
npm run migrate:up
npm run migrate:down
npm run db:reset
```

## Development Server

```bash
npm run dev
npm run web:dev
```

## Desktop (Electron)

```bash
npm run desktop:dev
npm run dist:win        # Version 1 target
# npm run dist:mac      -- OUT OF VERSION 1 SCOPE
```

## Test

```bash
npm test
npm run test:int
npm run test:ui-contract
```

## Lint / Type Check

```bash
npm run lint && npm run lint:noleak && npm run typecheck
```

## Validation Commands

```bash
npm run verify
```

## Dependencies added in this phase

- `electron`, `electron-builder` (devDependencies) — desktop shell and packaging.
