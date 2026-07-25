# Guardrails — Known Risks and Scope Exclusions

ralph: before taking any action, scan this file. If your action matches a SIGN, stop and report.

## Ap-hub-wide guarantees (from repo CLAUDE.md — always in force, even though this feature is UI-only)

### SIGN: any edit to src/qbo/write.ts, src/gatekeeper/forwarder.ts, or src/pipeline/**
This feature is presentational-only and should never need to touch these files. If a task seems
to require it, STOP — that means scope has crept past what this spec authorized.
Mitigation: git diff on those paths must stay empty for the whole feature.

## Pre-Loaded Risks (from SPEC-guided-onboarding-installer.md ## Risks)

### SIGN: adding a persisted welcome-seen flag or a new onboarding step
A builder "helpfully" persisting welcome-dismissed state or adding a step to ONBOARDING_STEPS
would require a migration/service change, breaking this spec's core promise (zero guardrail risk).
Mitigation: welcome-dismissed state is ephemeral React state only; see Do Not Build below.

### SIGN: welcome overlay rendering before the non-owner role check
The welcome overlay must render strictly AFTER the existing `me.role === 'owner_controller'` gate,
never before it — a bookkeeper/CPA must never see setup prerequisites they can't act on.
Mitigation: keep the existing early-return non-owner branch first in the component.

### SIGN: test/onboarding.test.ts needs a change to keep passing
That suite exercises the service/action layer this feature must not touch. Any change needed there
means scope crept into the backend.
Mitigation: run it unmodified as a Definition-of-Done gate every chunk.

### SIGN: building a full modal-per-step wizard instead of an overlay + enhanced inline flow
The spec's Open Question #1 disclosed a specific, smaller interpretation of "guided pop-up pages."
Building the larger interpretation without checking first is scope creep beyond a LEAN spec.
Mitigation: welcome screen + failure panel get pop-up/overlay treatment; the 9-step body stays
an enhanced inline flow (existing structure), not one dialog per step.

## Scope Exclusions — Do Not Build

- DO NOT BUILD: any new backend endpoint, service function, or database column — the entire feature is presentational; the existing 3 endpoints already return everything needed.
- DO NOT BUILD: any "recovery key" or account-recovery step of any kind — explicitly out of scope per owner decision (2026-07-15); AP Hub has no local-password/wallet-key concept.
- DO NOT BUILD: a new onboarding step added to `ONBOARDING_STEPS` — the welcome screen is a client-side-only overlay, not a ninth backend-tracked step.
- DO NOT BUILD: any change to `DRY_RUN_LOCKED` enforcement, `automation_level` semantics, or the dry-run's propose-only guarantee — those are guarantee-bearing backend behaviors, already audited (see ap-hub `.claude/audits/HKO/`).
- DO NOT BUILD: a Playwright/E2E rewrite — out of scope; this feature's tests are unit-level (CHUNK_1) plus the existing web:build compile gate.

## Standing Guardrails (always active)

- DO NOT add npm dependencies without updating AGENTS.md.
- DO NOT skip the validation gate, even for trivial changes.
- DO NOT commit with --no-verify.
- DO NOT generate code for a future chunk's domain.
- DO NOT modify files outside the current task's scope.
- DO NOT hard-code secrets, API keys, or credentials.

## Accumulation Instructions

When ralph encounters a new failure pattern, append below:
