# AGENTS.md — Build, Test, and Validation Commands
# Project: ap-hub multi-edition accounting intake

## Environment

```bash
cp .env.example .env
```

Required variables are in `.env.example`. Core groups:
# DATABASE_URL, ENCRYPTION_KEY, SESSION_COOKIE_SECRET
# GOOGLE_SSO_CLIENT_ID/SECRET, GMAIL_CLIENT_ID/SECRET, WATCHED_LABEL, GMAIL_DRAFTS_ENABLED
# QBO_ENV=sandbox, QBO_SANDBOX_CLIENT_ID/SECRET/REALM_ID/COMPANY_NAME
# QB_DESKTOP_ENABLED, QBWC_USERNAME/PASSWORD, QB_DESKTOP_COMPANY_ID
# QB_DESKTOP_WRITE_ENABLED=false, PROVIDER_JOB_LEASE_SECONDS
# LLM/BROKER and SWARMSYNC variables; optional gatekeeper/Telegram variables

## Install

```bash
npm install
```

## Database

```bash
docker compose up -d db
npm run migrate:up
npm run seed
npm run db:reset
```

## Development

```bash
npm run dev
npm run web:dev
npm run cli -- <command>
```

## Test and Build

```bash
npm test
npm run test:int
npm run lint
npm run lint:noleak
npm run typecheck
npm run build
npm run web:build
npm run test:ui-contract
```

`test:int`/`verify:live` use disposable accounts only; Playwright is a stubbed UI contract suite.

## Validation Commands

```bash
npm run verify
```
