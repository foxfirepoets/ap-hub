# Guardrails — Known Risks and Scope Exclusions

ralph: before taking any action, scan this file. If your action matches a SIGN, stop and report.

## Ap-hub-wide guarantees (from repo CLAUDE.md — always in force)

### SIGN: any edit to src/qbo/write.ts, src/gatekeeper/forwarder.ts, or src/pipeline/**
This feature never needs to touch these files. If a task seems to require it, STOP — scope has
crept past what this spec authorized.
Mitigation: git diff on those paths must stay empty for the whole feature, checked every chunk.

### SIGN: QBO_ENV allowed to be anything but 'sandbox'
Unrelated to this feature — do not touch src/config.ts's QBO_ENV hard-refusal logic.

## Pre-Loaded Risks (from SPEC-onboarding-real-connect-redesign.md ## Risks)

### SIGN: reusing the login SSO's cookie-based CSRF pattern for this cross-process flow
The "start" route (Next.js) and the callback (plain HTTP server, different port) cannot share an
HttpOnly cookie reliably. Do NOT copy the sso_state cookie pattern here — use the signed,
stateless HMAC token (CHUNK_1) instead.
Mitigation: CHUNK_1's signConnectState/verifyConnectState is the ONLY state-CSRF mechanism for
this flow.

### SIGN: trusting an unverified state before calling exchangeGmailCode/exchangeQboCode
The callback must call verifyConnectState FIRST and refuse (no exchange call, no token save) on
any failure — never exchange-then-check.
Mitigation: explicit test asserting the exchange function is never invoked on a bad state.

### SIGN: building a redirect target from any user-supplied input
The post-callback redirect must always be `${WEB_BASE_URL}/onboarding` + a fixed, code-controlled
query shape — never anything derived from a query param, header, or body the caller supplied.
Mitigation: explicit open-redirect test.

### SIGN: silently defaulting automation_level to anything but 'off' in the automatic flow
This is a repo-wide safety guarantee (DRY_RUN_LOCKED), not just this feature's convention.
Mitigation: the automatic step-walk must never call POST /api/onboarding/step with an
automationLevel other than 'off' (or omitted, matching the current default) for the 'complete'
step; asking the user to actively change it is out of scope for this wizard entirely.

### SIGN: rewriting exchangeGmailCode / exchangeQboCode / assertExpectedCompany / saveToken
These are correct, tested, and out of scope. This feature only changes what HTTP response follows
a call to them, never their internal logic.
Mitigation: diff review — these four functions' bodies should show zero behavioral change, only
call-site/response-path changes around them.

## Scope Exclusions — Do Not Build

- DO NOT BUILD: any change to `src/qbo/write.ts`, `src/gatekeeper/forwarder.ts`, or `src/pipeline/**`.
- DO NOT BUILD: any change to the OAuth token-exchange logic itself (`exchangeGmailCode`, `exchangeQboCode`, `assertExpectedCompany`, `saveToken`) — reused exactly as-is.
- DO NOT BUILD: a new "select company" picker UI — confirmed unnecessary; company selection is already fully automatic via the confirm-realm check.
- DO NOT BUILD: any schema/migration change.
- DO NOT BUILD: any automatic `automation_level` default other than `'off'`.
- DO NOT BUILD: a "recovery key" step of any kind.
- DO NOT BUILD: removal of the CLI `connect` command — it stays, now sharing URL-building logic with the new routes instead of duplicating it.
- DO NOT BUILD: any change to `test/onboarding.test.ts`'s existing API-contract assertions (the ONE allowed test change in this whole feature is the `PORT`/redirect-URI DEFAULT-value assertions in `test/config.test.ts`, scoped to exactly that — see CHUNK_3's spec).

## Integration note (from CHUNK_5's spec — read before touching page.tsx)

The earlier "guided-onboarding-installer" feature (already shipped, see specs/SPEC-guided-onboarding-installer.md)
added a 9-step OnboardingStepper component to this same page. This redesign shrinks the
user-facing flow to ~2 real actions + a summary screen. CHUNK_5 must reconcile this: either adapt
the stepper to the new, shorter step list, or remove it in favor of the simpler two-block connect
screen if it no longer makes sense. Favor removing/simplifying over keeping a stepper that
misrepresents reality (e.g. still implying 9 steps when only ~3 screens exist now).

## Standing Guardrails (always active)

- DO NOT add npm dependencies without updating AGENTS.md.
- DO NOT skip the validation gate, even for trivial changes.
- DO NOT commit with --no-verify.
- DO NOT generate code for a future chunk's domain.
- DO NOT modify files outside the current task's scope.
- DO NOT hard-code secrets, API keys, or credentials.

## Accumulation Instructions

When ralph encounters a new failure pattern, append below:
