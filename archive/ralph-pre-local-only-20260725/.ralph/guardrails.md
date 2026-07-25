# Guardrails — Known Risks and Scope Exclusions

ralph: before taking any action, scan this file. If your action matches a SIGN, stop and report.

## Pre-Loaded Risks (from spec)

### SIGN: Ambiguous external write result
Never blindly retry a QBO or QBD create after a timeout or lost response.
Mitigation: stable idempotency, provider duplicate probe, read-back adoption, then hold.

### SIGN: QBD work held only in memory
Process-memory ownership cannot survive restart or prove tenant isolation.
Mitigation: PostgreSQL `provider_jobs` is the authority before QBD writes are enabled.

### SIGN: QuickBooks edition overclaim
Not every product exposes a compatible write API.
Mitigation: executable capability matrix and `UNSUPPORTED_CAPABILITY`; never promise unsupported editions.

### SIGN: Plausible statement extraction
OCR output can look valid while changing financial meaning.
Mitigation: arithmetic/date/duplicate validation and human review before any accounting proposal.

### SIGN: Gmail reply send
The owner requires drafts that a human sends.
Mitigation: draft-only interface and architecture tests; do not add a reply send endpoint.

### SIGN: Tenant boundary
Documents, statement lines, drafts, provider jobs, and connections contain customer financial data.
Mitigation: derive tenant from session and test foreign IDs/leases.

## Scope Exclusions — Do Not Build

- DO NOT BUILD support claims for QuickBooks Mac, Self-Employed, discontinued, or API-incompatible editions.
- DO NOT BUILD automatic Gmail reply sending or a general recipient-addressed send API.
- DO NOT BUILD automatic journal entries from bank-statement lines.
- DO NOT ENABLE production QBO or real-company QBD writes during automated verification.
- DO NOT BUILD bank-login aggregation, payroll, payments, tax filing, Xero, or Sage.
- DO NOT create a parallel posting, auth, audit, attachment, or mapping system.
- DO NOT silently drop unsupported provider fields.

## Standing Guardrails

- DO NOT add dependencies without updating AGENTS.md.
- DO NOT skip `npm run verify`, even for trivial changes.
- DO NOT commit with --no-verify.
- DO NOT modify unrelated user changes.
- DO NOT hard-code secrets, API keys, credentials, or customer data.
- DO NOT use `git add -A`, `git add .`, or destructive Git reset/checkout.
- Existing proof, sandbox, idempotency, tenant-isolation, RBAC, and audit guarantees are load-bearing.

## Accumulation Instructions

When a new failure pattern is found, append:

### Learned: SHORT_TITLE
What failed and the exact prevention rule.
