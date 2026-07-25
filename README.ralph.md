# README.ralph.md — Windows Local-Only AP Hub

Generated from `specs/SPEC-windows-local-only-runtime.md` on 2026-07-25.

## Chunks

- CHUNK_1_SECRETS: Windows Credential Manager and credential references
- CHUNK_2_AUTH: SID-bound loopback product access
- CHUNK_3_GMAIL: Desktop OAuth with PKCE
- CHUNK_4_TRANSPORTS: Direct/API/MCP QBO transports
- CHUNK_5_DESKTOP: Durable local QBD
- CHUNK_6_WATCHDOG: Standard-user continuous operation
- CHUNK_7_CERTIFICATION: Installed-environment proof

## Setup

```powershell
npm install
docker compose up -d db
npm run migrate:up
```

Planning creates `IMPLEMENTATION_PLAN.md`; CBV then builds one task at a time and records evidence
in `.claude/cbv/session_state.json`.

## Validation

```powershell
npm run verify
```

Warnings from spec parsing: none.
