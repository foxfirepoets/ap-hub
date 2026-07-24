# CHUNK_6_RELEASE_PROOF — Fresh-Context Spec-vs-Build Audit

Date: 2026-07-24  
Auditor context: fresh; frozen spec and repository only; builder chat not read  
Confidence: 90% for local/code behavior, 0% for unsupplied deployed/external behavior  
Local task verdict: **GREEN**  
Gate-4 launch verdict: **CANNOT CERTIFY (code-only)**

## Final verdict

The repository satisfies the local release-proof gate: every frozen-spec acceptance criterion has code and executable local evidence, the complete repository gate passed, critical hostile simulations passed, and no new code defect was found. It is not launch-certified. No safe deployed URL, two deployed test identities, disposable Gmail mailbox, QBO sandbox company, QBD test company, or deployed HTTP/DB/log evidence was supplied. The spec explicitly says local-only proof is not DONE, so all external end-to-end claims remain UNVERIFIABLE and an owner must execute the disposable certification runbook before launch.

No deployment, live email, live QBO/QBD call, production mutation, or real-company write occurred during this audit.

## Evidence summary

- `npm run verify` (clean rerun): exit 0. ESLint PASS; `lint:noleak` PASS; TypeScript PASS; 58 Vitest files / 426 tests PASS; Next.js production build PASS; Playwright 18/18 PASS.
- Critical hostile rerun: `npx vitest run` over migration, durable jobs, QBD posting, statements, statement review, Gmail drafts, reply-draft API, capabilities, auth, posting, and broker suites: 11 files / 92 tests PASS.
- First full-gate attempt: all 426 test bodies passed, but `test/accounting-intake-migration.test.ts` teardown exceeded the 30-second hook limit, so the command exited 1. The isolated/critical rerun and clean full rerun passed. This is retained as an operational flake risk, not erased.
- Static hostile scan: no TODO/FIXME/placeholder on the new active accounting-intake paths; capability-declaring Xero/Sage and historical connector stubs are outside this spec. The only Gmail `messages.send` runtime path is the pre-existing locked gatekeeper forwarder. Reply-draft runtime/routes expose create, update, status, and discard only.
- Build route inventory contains every specified provider, statement, and reply-draft API/UI route. Playwright exercised every new user-facing control and form with stubbed APIs; this is contract evidence, not deployed proof.

## Requirement reconciliation

The frozen spec has eleven checkbox acceptance criteria; IDs below are auditor-assigned in order.

| ID | Status | Local evidence | Business impact / external gap |
|---|---|---|---|
| R1 provider capability truth | PARTIAL | `provider-capabilities.test.ts` 8/8; settings UI contract PASS; unsupported Self-Employed reason asserted | Deployed provider identity and edition matrix not observed |
| R2 shared QBO/QBD posting contract | PARTIAL | `qbd-posting-contract.test.ts` 5/5; `posting.test.ts` 18/18; connector boundary scan PASS | No disposable QBO sandbox or QBD test-company transaction/read-back |
| R3 durable QBD restart/lease isolation | PARTIAL | `provider-durable-jobs.test.ts` 5/5 against PostgreSQL: restart persistence, tenant/connection isolation, lease recovery | No deployed worker restart or real QBWC lease trace |
| R4 lost-response duplicate adoption | PARTIAL | QBD lost-response simulation and QBO timeout replay pass; provider create asserted exactly once | No real provider timeout/adoption trace |
| R5 existing invoice proof-gated workflow | PARTIAL | complete suite includes extraction, mapping, posting, proof, invoice routing, audit regressions | No deployed Gmail-to-provider invoice journey |
| R6 statement ingest/validation | PARTIAL | `bank-statements.test.ts` 11/11: ordering, immutable facts, duplicate file/line, arithmetic hold, encrypted input | No deployed supported-document sample set or measured 95% target |
| R7 statement review and zero-write filing | PARTIAL | `bank-statement-api.test.ts` 7/7; DB counts unchanged for proposals/jobs/postings/reconciliation; structural import/SQL guard | No deployed HTTP/DB artifact |
| R8 Gmail draft, never application send | PARTIAL | Gmail/draft suites 12/12; reply-draft architecture no-send assertion; UI has no transmit control | No disposable Gmail draft/thread observation |
| R9 role separation | PARTIAL | auth/session, action, statement, draft, and UI role tests pass: bookkeeper cannot post; CPA read-only; owner approval | No two-account deployed role probe |
| R10 cross-tenant non-disclosure | PARTIAL | auth, durable-job, statement, draft, read, mapping, and UI foreign-resource tests return 403/404 without mutation | No attacker/victim deployed probe |
| R11 repository and broker gates | PARTIAL | clean `npm run verify` exit 0; broker suite 9/9; 426 unit/integration tests and 18 UI contracts pass | Spec requires deployed artifacts for DONE |

All eleven requirements are accounted for. None is marked DONE because the spec defines DONE in the deployed disposable environment.

## Must-not-break and adversarial results

| Probe | Expected | Observed locally |
|---|---|---|
| Production QBO write | Never during verification | No live provider call; injected clients only |
| Application Gmail reply send | Reply-draft surface has no send operation | Runtime/source/DOM tests pass; only separately locked legacy gatekeeper forwarding remains |
| Proofless posting | Hold; zero create | Posting and SwarmSync-disabled hostile tests pass |
| Replay/lost response | Adopt; exactly one create | QBO and QBD simulations pass |
| Concurrent approve | Exactly one posting | `action.test.ts` passes |
| Cross-tenant resources | 403/404, no existence leak/mutation | Provider job, statement, line, draft, auth, read and mapping tests pass |
| Wrong role | Bookkeeper cannot post; CPA cannot mutate | Service/API/UI tests pass |
| Statement filing | Zero provider/accounting writes | Transaction-count and hostile structural assertions pass |
| Oversized attachment | Reject visibly; do not store | `infra-ingest.test.ts` PASS |
| Empty/malformed input | Validation failure; no unsafe write | Statement, draft, auth, mapping, extraction and provider parsers fail closed |
| Lease replay/expiry | One active lease; uncertain sent result held | Durable PostgreSQL tests pass |
| Unsupported edition/field | `supported:false` or visible hold | Capability/QBO/QBD tests pass |
| Existing auth/audit/invoice behavior | No regression | Complete 426-test suite PASS |

## Fake-completion sweep

- No dead new route was found in the production build route map.
- No disconnected new UI action was found in the 18 Playwright contracts.
- Statement and draft forms trace through their API/service/database behavior in tests.
- No active reply-draft send method or route exists.
- `src/connectors/stubs.ts` still contains Xero/Sage capability stubs and a historical QBD factory used by older contract tests. The active QBD implementation is `src/connectors/qbd.ts`; the legacy stub is not evidence of a missing in-scope QBD path.
- The existing `/api/replies/[id]/send` route invokes the separately locked, fixed-recipient gatekeeper forward workflow retained by the frozen spec. It is not connected to reply drafts and is covered by lockdown/idempotency tests.

## Random 10% honesty re-audit

R4 was selected as the approximately 10% re-audit item. The critical rerun re-executed both `qbd-posting-contract.test.ts` and `posting.test.ts`; all 23 tests passed, including lost-response adoption and idempotent retry assertions.

## Defect and owner-gated task cards

### RP-1 — Deployed disposable certification missing (launch blocker)

- Requirements: R1–R10 and the spec DONE definition.
- Evidence: no deployed URL, disposable provider credentials, or deployed artifacts were supplied.
- Done-check: execute `docs/LIVE-VALIDATION-SETUP.md` against a safe deployed environment with two roles, disposable Gmail, QBO sandbox, and QBD test company; attach redacted HTTP responses, DB rows, screenshots, and provider read-backs.
- Owner: release owner / environment operator.

### RP-2 — Backup restoration before production writes not externally demonstrated (launch blocker)

- Requirement: spec DONE condition 2.
- Evidence: local disposable restoration was previously rehearsed; no target deployment restoration artifact exists.
- Done-check: restore the target environment backup into a disposable database, validate marker/schema/counts, and retain the transcript before any production accounting write flag is enabled.
- Owner: database/release operator.

### RP-3 — Capability UI not reconciled to live provider matrix (launch blocker)

- Requirement: spec DONE condition 3 and R1.
- Evidence: code/UI fixtures pass only.
- Done-check: connect each supported disposable edition, capture capability API and UI, and compare operation-by-operation; capture unsupported-edition response.
- Owner: QuickBooks integration owner.

### RP-4 — Full-gate teardown timing flake (non-blocking local risk)

- Requirement: R11 reproducibility.
- Evidence: first full run had 426 passed tests but one 30-second migration-suite teardown timeout; isolated and clean full reruns passed.
- Done-check: obtain three consecutive clean CI runs or increase/diagnose teardown resilience without hiding database leaks.
- Owner: test infrastructure owner.

## Residual risk register

| Risk | Owner | Accepted/signed? |
|---|---|---|
| No deployed wrong-user, replay, concurrency, oversize, route, button, or form probe | Release owner | No |
| No live Gmail draft observation and no live no-send mailbox audit | Gmail integration owner | No |
| No QBO sandbox/QBD test-company create/read-back/reconciliation evidence | QuickBooks integration owner | No |
| No workload measurements for 5,000-line import or 50,000-line read targets | Performance owner | No |
| No deployed backup restoration evidence | Database operator | No |
| One transient migration teardown timeout before clean reruns | Test infrastructure owner | No |

## Gate conclusion

`CHUNK_6_RELEASE_PROOF` is complete and GREEN within the explicitly local, non-mutating boundary. Product launch remains **CANNOT CERTIFY (code-only)** until RP-1 through RP-3 are executed and their residual risks are accepted or closed. No live proof is claimed.
