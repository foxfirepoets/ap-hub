# README.ralph.md — Multi-Edition Accounting Intake

Generated from `specs/SPEC-multi-edition-accounting-intake.md` on 2026-07-24.

Chunks:

- CHUNK_1_CONTRACTS — durable document and integration contracts
- CHUNK_2_QBD — supported QuickBooks Desktop bill posting
- CHUNK_3_STATEMENTS — reviewed bank-statement workflow
- CHUNK_4_DRAFTS — human-sent Gmail drafts
- CHUNK_5_PRODUCT — SMB-owner product surface
- CHUNK_6_HARDENING — adversarial verification and operations

Setup: `npm install`, `docker compose up -d db`, `npm run migrate:up`, then `npm run verify`.

Planning produces `IMPLEMENTATION_PLAN.md`. Build mode completes one task at a time. External Gmail/QBO/QBD certification uses disposable accounts and is owner-gated; local mocks never count as launch proof.

No spec-parsing warnings.
