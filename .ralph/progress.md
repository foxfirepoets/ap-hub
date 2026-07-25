# Progress Log (append-only)

Project: ap-hub-windows-local-only
Initialized: 2026-07-25
Total chunks: 7

## Log

(no entries yet)

### 2026-07-25 — Planning

Read the frozen Windows local-only specification, all seven generated chunk
specifications, project commands, and Ralph guardrails. Created the dependency-ordered
CBV task plan in `IMPLEMENTATION_PLAN.md`; no application code or tests were written.

<promise>PLANNING COMPLETE</promise>

### 2026-07-25 — Iteration 1 — CBV-LOC001

Implemented migration 013 for non-secret Windows Credential Manager references and
constrained QuickBooks transport metadata. PostgreSQL rejects malformed credential
targets and recursively rejects secret-bearing metadata/configuration. DOWN now
refuses while credential references or configured transport modes remain.

Verification:

- Focused migration UP → DOWN → UP/schema/constraint/rollback test: passed.
- `npm run verify`: exit 0.
- Unit suite, production web build, and 24 Playwright UI contracts: passed.
- Commit: `16db0b8 feat: add local credential schema cbv-loc001`

<promise>TASK_COMPLETE</promise>

### 2026-07-25T09:14:14-07:00 — CBV-LOC001 Task 1 terminal verification

- Commit: `78c5522`
- Independent `npm run verify`: exit 0 in 605.5 seconds.
- Gate evidence: lint, no-leak scan, typecheck, 64 files / 484 tests, production web build, 24/24 Playwright.
- Truth-fix audit: `GREEN_COMPLETE` after 168 actual hostile database operations, seven positive controls, and direct DOWN → UP lifecycle proof.
- Earlier aggregate verification timeout was superseded by the successful exact-SHA rerun.

<promise>TFL GREEN: CBV-LOC001 TASK 1</promise>

### 2026-07-25 — Iteration 5 — CBV-LOC001 final whitespace/case truth-fix

Closed leading/trailing ASCII whitespace, control-character, and mixed-case matching
bypasses in the centralized non-secret text validator. Every anchored credential-shape
check now uses the same trimmed value and case-insensitive matching where appropriate.
Provider account identifiers reject surrounding whitespace/control characters while
retaining common Gmail email/opaque identifiers and numeric QBO realms.

Actual INSERT coverage includes leading/trailing spaces, tabs, newlines, mixed-case
Google/GitHub/sk credential forms, and JWT variants across every credential metadata
string/array channel. Legitimate email, opaque, scope, timestamp, and numeric-realm
controls remain accepted.

Verification:

- Focused migration whitespace/case/value/schema/rollback matrix: passed.
- `npm run verify`: exit 0.
- Production web build and 24 Playwright contracts: passed.
- Amended commit: `78c5522 feat: add local credential schema cbv-loc001`

<promise>TASK_COMPLETE</promise>

### 2026-07-25 — Iteration 4 — CBV-LOC001 value-channel truth-fix

Closed plaintext value channels inside otherwise allowed JSON fields. Migration 013
now centrally rejects authorization headers, JWT-shaped values, common API/private-key
prefixes, PEM material, and suspicious long high-entropy strings. Free-form
`last_refresh_status.message` was removed. Refresh state is a bounded enum, and
endpoint/command identifiers require the documented `registered-*` namespace.

Actual INSERT/UPDATE tests cover every allowed string and scope/tool-array surface
with bearer, JWT, API-key, PEM, and entropy-shaped values. Positive controls retain
Gmail scopes, provider account IDs, numeric QBO realms, registered transport
references, tool names, and company identifiers.

Verification:

- Focused migration value-channel/schema/rollback matrix: passed.
- `npm run verify`: exit 0.
- Production web build and 24 Playwright contracts: passed.
- Amended commit: `40722d1 feat: add local credential schema cbv-loc001`

<promise>TASK_COMPLETE</promise>

### 2026-07-25 — Iteration 3 — CBV-LOC001 strict-schema truth-fix

Replaced denylist-based JSON inspection with strict database schemas. Credential
metadata now accepts only bounded scope, expiry, provider-account, and refresh-status
fields with explicit types. Connection configuration is validated by transport mode
and accepts only bounded non-secret identifiers, allowlisted tools, and timeouts.
Unknown keys are rejected recursively.

Hostile tests cover bearer, authorization, OAuth, client/signing keys, passphrases,
password abbreviations, auth, generic keys, refresh/session/certificate terms, and
randomized punctuation/casing/nesting on both protected JSON columns. Positive
controls cover documented metadata and every current transport mode.

Verification:

- Focused migration schema/rollback/hostile matrix: passed.
- `npm run verify`: exit 0.
- Production web build and 24 Playwright contracts: passed.
- Amended commit: `b394ad3 feat: add local credential schema cbv-loc001`

<promise>TASK_COMPLETE</promise>

### 2026-07-25 — Iteration 2 — CBV-LOC001 truth-fix

Closed the migration 013 JSON-key normalization bypass found by the independent
truth-fix audit. Keys are normalized by removing non-alphanumeric separators before
rejecting token, secret, password, credential, API-key, access-key, and private-key
forms. Hostile nested object/array coverage now includes snake_case, kebab-case,
camelCase, PascalCase, and concatenated variants for both credential metadata and
connection transport configuration. Safe metadata/configuration controls remain valid.

Verification:

- Focused migration hostile matrix and UP → DOWN → UP test: passed.
- `npm run verify`: exit 0.
- Production web build and 24 Playwright contracts: passed.
- Amended commit: `978935e feat: add local credential schema cbv-loc001`

<promise>TASK_COMPLETE</promise>

### 2026-07-25 — CBV task 2 — Windows Credential Manager secret store

Replaced the Windows DPAPI-file secret backend with a current-user Windows Generic
Credential implementation backed by the native Advapi32 Credential Management APIs.
The host contract now validates strict `APHub/...` targets and supports put, get,
idempotent delete, and target listing without placing secret values in command lines,
environment variables, files, browser storage, logs, or surfaced errors.

Verification:

- Host contract: 6/6 passed.
- Windows-only native Credential Manager integration: 1/1 passed with randomized
  target cleanup.
- UI contract: 24/24 passed on an isolated configurable port.
- `APHUB_E2E_PORT=34123 npm run verify`: exit 0.

<promise>CBV_BUILD_COMPLETE: Windows Credential Manager secret store</promise>

### 2026-07-25T10:03:01-07:00 — CBV-LOC001 Task 2 terminal verification

- Commit: `eb150e083b58e8c383d6aafe5fb0328c253bf29a`
- Independent `APHUB_E2E_PORT=35371 npm run verify`: exit 0 in 457.6 seconds.
- Gate evidence: lint, no-leak scan, typecheck, 64 files / 485 tests, production web build, 24/24 Playwright.
- Real Windows Credential Manager integration proved exact UTF-8 limits, current-user storage, target isolation, overwrite/delete behavior, redacted failures, and cleanup.
- Truth-fix audit: `GREEN_COMPLETE`.

<promise>TFL GREEN: CBV-LOC001 TASK 2</promise>
