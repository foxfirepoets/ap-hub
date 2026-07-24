# Architecture Decision Packet
## System: AP Hub Multi-Edition Accounting Intake
## Date: 2026-07-24
## Verdict: READY_FOR_SPEC
## Confidence: HIGH — the repository, schema, connector contract, active routes, and tests are inspectable; live third-party behavior remains a later certification gate.

## 1. System Summary

AP Hub is a brownfield accounting-intake application for small-to-medium-sized business owners. It already ingests Gmail invoices, extracts and classifies them, provides a review UI, and can post proof-gated bills to QuickBooks Online sandbox. This extension adds a durable provider-neutral document workflow, supported QuickBooks Desktop posting through Web Connector/qbXML, bank-statement ingestion and filing, and Gmail draft creation with human-only sending. “Any QuickBooks edition” means every edition with an available supported integration surface: QBO products through the Accounting API and supported Windows QuickBooks Desktop Pro/Premier/Enterprise releases through Web Connector; editions without a compatible write API are reported as unsupported rather than silently approximated.

## 2. Current-System Map

| Component | Type | Status | Evidence / Notes |
|---|---|---|---|
| Gmail poll/ingest | service/job | partial | Active read and attachment path in `src/gmail`, `src/ingest`, and pipeline jobs; external OAuth not certified in this run. |
| Document extraction/classification | service/job | partial | Active deterministic and LLM-backed paths with tests; external model behavior not certified here. |
| Review web application | UI/API | built locally | Next.js App Router pages and action/read APIs under `app/`; production build and contract tests exist. |
| Human auth/RBAC | auth | built locally | `users`, `sessions`, Google SSO routes, tenant-scoped services and tests. |
| QBO connector | integration | partial | Provider-neutral adapter wraps QBO read/write; writes are sandbox-only. |
| QBD Web Connector | integration | partial | SOAP endpoint, QWC generation, read queries, in-memory work queue; write controls intentionally absent. |
| Bank-statement workflow | domain | missing | No canonical statement/line model, import state machine, matching workflow, or filing service. |
| Gmail drafts | integration | missing | Gmail interface exposes read and locked forward only; no draft create/update contract. |
| Proof/audit | service/data | built locally | `proof_refs`, `audit_log`, posting reconciliation, and tests. |
| Installer/runtime | operations | partial | Local Windows installer and Compose DB; external integration certification and restore drill remain unproven. |

## 3. Target Architecture

| Concern | Current | Target |
|---|---|---|
| Intake object | Invoice-oriented message/attachment pipeline | Canonical `accounting_documents` record covering invoice and bank-statement documents |
| Accounting providers | QBO live adapter; QBD read-only seam | Capability-driven connector registry with QBO and QBD bill posting implementations |
| QBD work | Process-memory queue | Durable tenant/connection-scoped `provider_jobs` queue with request/response audit and replay safety |
| Bank statements | No domain model | Statement + immutable line records, extraction validation, review/match/file lifecycle |
| Email assistance | Locked forward/send action | Gmail draft-only adapter and draft records; no application send method |
| Posting | QBO-specific proposal language in legacy storage | Provider-neutral posting orchestration with provider capability and identity gates |
| Unsupported editions/features | Implicit gaps | Explicit capability response and `UNSUPPORTED_CAPABILITY` hold |

Target data flow:

`Gmail → message/attachment → accounting_document → invoice OR bank_statement → extraction/review → provider-neutral proposal → QBO REST or durable QBD QBWC job → read-back/reconciliation`

`exception/question → reply_draft → Gmail Drafts → human opens Gmail and sends`

## 4. Domain Entities

### Existing schema inventory

| Entity | Key ownership and lifecycle |
|---|---|
| `tenants` | Tenant identity/configuration; owner/admin controlled. |
| `oauth_tokens` | Encrypted external OAuth credentials; auth integration controlled. |
| `messages` | Gmail message processing state; ingest/pipeline controlled. |
| `attachments` | Message attachment metadata/hash; ingest controlled. |
| `attachment_blobs` | Attachment bytes; ingest controlled. |
| `extractions` | Extracted document fields/confidence; extraction controlled. |
| `mappings` | Learned vendor/account mappings; review/mapping controlled. |
| `proposals` | Proposed accounting transactions; pipeline/review controlled. |
| physical posting table + `postings` view | Provider posting projection; posting service controlled. |
| `reconciliation` | Local-to-provider match results; reconciliation controlled. |
| `exceptions` | Recoverable/manual-work items; pipeline and human action services controlled. |
| `audit_log` | Append-only action evidence; every mutation service writes. |
| `corrections` | Human field corrections and learning decisions. |
| `llm_calls` | Model-call metadata and cost/latency evidence. |
| `proof_refs` | External proof references and chain hashes. |
| `forwards` | Locked gatekeeper forwarding state. |
| `users` | Tenant-scoped human identities and roles. |
| `sessions` | Hashed login-session lifecycle. |
| `onboarding_state` | Tenant onboarding/dry-run/automation state. |
| `notifications` | Tenant/user notification lifecycle. |
| `connections` | Provider-neutral external company connection. |
| `tax_mappings` | Provider/connection-scoped tax resolution. |
| `tax_mapping_audit` | Tax mapping mutation evidence. |
| `dimension_mappings` | Provider dimension resolution/review state. |
| `dimension_mapping_rules` | Reusable dimension learning rules. |
| `v_proposal_review`, `v_postings_qbo` | Compatibility/read projections; no independent writer. |

### New entities

| Entity | Key fields | Relationships | Status values | Owner |
|---|---|---|---|---|
| `accounting_documents` | id, tenant_id, message_id, attachment_id, kind, sha256, status | message/attachment; optional statement | received, extracted, review, ready, filed, posted, held, rejected | intake service |
| `bank_statements` | id, document_id, account_hint, period_start/end, opening/closing_balance, currency, status | one document; many lines | extracted, unbalanced, review, ready, filed, held | statement service |
| `bank_statement_lines` | id, statement_id, line_no, posted_on, description, amount, balance, fingerprint, match_status | one statement; optional provider ref | unmatched, suggested, matched, excluded | statement service/reviewer |
| `provider_jobs` | id, tenant_id, connection_id, operation, request_xml, status, attempts, idempotency_key, response_xml | one connection; optional proposal/document | queued, leased, sent, succeeded, failed, held | connector job service |
| `reply_drafts` | id, tenant_id, message_id, gmail_draft_id, subject, body_text, status, reason | message/thread | proposed, created, updated, discarded, sent_external | draft service |

## 5. Source-of-Truth Matrix

| Entity | SoT Location | Writers | Readers | Conflict Resolution | Risk |
|---|---|---|---|---|---|
| Source email and Gmail draft | Gmail | Gmail/user; AP Hub draft API only | intake/UI | Gmail wins; local IDs/status are projections | MED |
| Attachment bytes/hash | Postgres attachment records/blob | ingest only | extraction/evidence | SHA-256 identity; first accepted blob wins | LOW |
| Document workflow state | `accounting_documents` | intake/domain services | UI/jobs | DB state machine is authoritative | LOW |
| Statement/lines | `bank_statements*` | statement import + explicit reviewer actions | UI/matcher | Immutable imported line facts; review adds match/exclusion only | MED |
| Accounting transaction | Connected QuickBooks company | connector only | read-back/reconciliation | Provider wins after successful create; mismatch holds locally | HIGH |
| Posting intent/status | `proposals`, posting table, `provider_jobs` | posting orchestration | UI/reconciliation | Idempotency key joins intent/job/provider result | HIGH |
| Connection identity/capability | `connections` plus live provider verification | connection service | onboarding/posting | Live identity mismatch blocks writes; declared capability blocks unsupported operations | HIGH |
| Reply-draft projection | `reply_drafts` | draft service | UI/audit | Gmail draft ID is external authority; local status records intent/evidence | MED |
| Human identity/session | `users`, `sessions` | auth services | all APIs | Database wins; role changes invalidate authorization immediately | HIGH |
| Audit evidence | `audit_log`, proof tables | append-only mutation hooks | UI/audit | Never updated or deleted by product flows | HIGH |

## 6. State Machines

| Entity | State | Transitions To | Trigger | Irreversible? |
|---|---|---|---|---|
| accounting document | received | extracted, held | successful extraction / error | no |
| accounting document | extracted | review, ready, held | classification and validation | no |
| accounting document | review | ready, rejected, held | human decision | no |
| accounting document | ready | posted, filed, held | provider post or statement filing | provider post is externally durable |
| bank statement | extracted | unbalanced, review | balance/line validation | no |
| bank statement | unbalanced | review, held | human accepts exception or re-extracts | no |
| bank statement | review | ready, held | line review complete | no |
| bank statement | ready | filed, held | file/export succeeds/fails | filing may create provider records only when explicitly supported |
| statement line | unmatched | suggested, matched, excluded | matcher/reviewer | no |
| provider job | queued | leased, held | QBWC worker claims / capability failure | no |
| provider job | leased | sent, queued, failed | request delivery / lease expiry | no |
| provider job | sent | succeeded, failed, queued | parsed response / retryable error | provider create may be durable |
| reply draft | proposed | created, discarded | reviewer creates/rejects | no |
| reply draft | created | updated, discarded, sent_external | app update/delete or observed Gmail state | human send occurs outside app |
| session | valid | expired, revoked | time/logout/admin | no |
| proposal | review | ready, rejected, exception | human/system gates | no |
| proposal | ready | posted, exception | provider orchestration | provider post durable |
| exception | open | resolved | verified recovery action | no |

## 7. Critical Workflows

1. **Invoice intake and posting:** Gmail poll → attachment download/hash → invoice classification/extraction → mappings/proofs → owner review → connector capability + company identity check → idempotent QBO or QBD create → read-back → posting/reconciliation/audit. Any uncertainty holds.
2. **Bank-statement intake:** Gmail attachment → statement classification → statement metadata/line extraction → arithmetic and period validation → human review of unmatched/ambiguous lines → file as evidence and, only where a connector capability exists, create explicitly approved accounting records.
3. **Gmail draft assistance:** an exception or missing field triggers suggested copy → authorized user reviews → AP Hub creates/updates a Gmail draft in the original thread → user sends in Gmail. The application has no general send endpoint.
4. **QBD asynchronous posting:** approved bill creates a durable provider job → QBWC authenticates and leases one tenant/connection job → receives qbXML → returns response → parser records external ID or structured failure → read-back query/reconciliation completes the proposal.
5. **Unsupported capability:** onboarding records edition/capabilities → attempted unsupported document type is held with exact guidance; no payload is dropped or approximated.
6. **Retry/recovery:** timed-out QBO/QBD operations run provider duplicate detection/read-back before any retry; an uncertain external result remains held.

## 8. Integration Boundaries

| Integration | Direction | Auth Method | Send | Receive | Failure Mode | Limit |
|---|---|---|---|---|---|---|
| Gmail | bidirectional read/draft | OAuth, least scopes | draft create/update; no send | messages, attachments, draft IDs | token/quota error holds intake/draft | Gmail quotas |
| QBO | bidirectional | OAuth | approved bills/attachments | company, vendors, accounts, read-back | identity/capability/API uncertainty holds | Intuit limits |
| QBD QBWC | bidirectional asynchronous | QBWC username/password + local company grant | leased qbXML requests | qbXML responses | connector offline leaves durable queued job | QBWC polling |
| LLM extractor | outbound | configured provider secret/broker | document content | structured extraction | invalid/unavailable output holds | cost/latency |
| SwarmSync | outbound | API key/broker token | verification inputs | proof verdicts | unavailable proof holds posting | cost/latency |
| PostgreSQL/pg-boss | internal | DB credentials | durable state/jobs | transactional results | DB failure stops mutations | local capacity |

## 9. Money/Auth/Proof Boundaries

### MONEY / accounting integrity

| Location | Action | Trigger | Guard | Idempotent? | Audit? |
|---|---|---|---|---|---|
| provider-neutral posting service | create bill | owner approval or allowed automation | RBAC, dry-run, proof, ceiling, capability, identity | yes | yes |
| QBO connector | REST create | durable posting intent | sandbox during build; duplicate probe/read-back | app + provider | yes |
| QBD connector/job processor | qbXML BillAdd | approved durable job leased by QBWC | write-enabled connection, company match, idempotency, single lease | app-enforced | yes |
| statement filing | evidence/file or supported transaction proposal | reviewed balanced statement | no implicit journal entry; per-line approval for accounting writes | yes | yes |

GL integrity check: every provider create must read back amount, document number, dimensions where supported, and external revision; reconciliation runs immediately after completion and on retry.

### AUTH

| Check Point | Token | Validates | Failure | Rate Limited? |
|---|---|---|---|---|
| Web UI/API | signed HTTP-only session | active user, tenant, role | 401/403, no mutation | login/provider limits |
| Gmail/QBO OAuth state | signed short-lived state bound to tenant/provider | callback origin and intended connection | 400, no token write | provider limits |
| QBD SOAP | QBWC credential + connection assignment | configured desktop connection | SOAP auth failure, no job lease | polling bound |
| QBD control/admin | session owner role; no shared password browser control | tenant connection management | 403 | yes |
| Provider posting | resolved connection and current user/system authority | correct tenant/company/capability | hold | n/a |

Session expiry and role changes are checked per request. OAuth tokens rotate through provider flows and are encrypted at rest. Users cannot change their own role.

### PROOF

| Proof | Generated At | Storage | Visible? | Tamper-resistant? |
|---|---|---|---|---|
| Source hash | attachment ingest | attachments/document | yes | SHA-256 |
| Extraction/proof verdict | extraction/verification | extractions/proof_refs | yes | chain reference |
| Human approval | action API | audit_log | yes | append-only + anchor |
| Provider request/response | connector/job | posting/provider_jobs | redacted summary | DB evidence + hashes |
| Read-back/reconciliation | connector | posting/reconciliation | yes | external revision + hash |
| Gmail draft | draft API | reply_drafts + Gmail | yes | Gmail draft ID + audit |

## 10. Data Flow

1. Gmail poll reads a tenant label and stores `messages`, `attachments`, and `attachment_blobs`; failures leave the prior history cursor intact.
2. Intake creates one `accounting_documents` row per unique supported attachment and classifies invoice versus bank statement.
3. Invoice extraction reuses `extractions`, mapping, proof, proposal, and exception services.
4. Statement extraction writes header and immutable line facts transactionally, verifies totals/balances, and routes uncertain documents to review.
5. The owner reviews evidence through tenant-scoped APIs; approved invoices enter the existing posting orchestration.
6. Connector resolution reads `connections`, verifies live company identity and capability, and chooses QBO synchronous REST or QBD durable `provider_jobs`.
7. QBO create/read-back completes immediately; QBD waits for QBWC lease/response and performs a follow-up read-back job.
8. Success writes provider posting/reconciliation/audit state; any ambiguous outcome holds without a blind retry.
9. When communication is needed, the draft service creates a Gmail draft and records `reply_drafts`; sending remains exclusively a human action in Gmail.

## 11. Failure Modes

| Scenario | Trigger | State After | Detectable | Recoverable | Mitigation |
|---|---|---|---|---|---|
| Duplicate provider create | retry after timeout | uncertain/possibly posted | duplicate probe/read-back | yes | stable idempotency key; never blind retry |
| Wrong QBD company open | QBWC connects to different file | job held | company query mismatch | yes | identity query before write batch |
| QBWC offline | desktop closed | queued | lease age/health | yes | durable queue and UI status |
| Malformed qbXML response | provider/transport error | failed/held | parser error | yes | store redacted response; structured remediation |
| Statement totals do not reconcile | OCR/parser error | unbalanced | arithmetic validation | yes | human correction/re-extraction; no posting |
| Duplicate statement/email | repeated message/file | existing document | hash/fingerprint | yes | unique tenant hash + line fingerprint |
| Gmail draft scope denied | OAuth lacks compose scope | draft proposed/held | API error | yes | reconnect with exact least privilege |
| Draft accidentally sent by app | send method introduced | customer email sent | audit/API tests | not fully | interface contains draft operations only; architecture test bans send |
| Provider unsupported field | edition capability gap | proposal held | capability matrix | yes | visible gap, never silent drop |
| Cross-tenant job/draft access | missing scope | disclosure/write | isolation tests | harmful | connection/document queries require tenant from session |
| Database failure mid-import | transaction abort | no partial statement | DB error | yes | atomic header+line import |
| External success/local failure | provider create succeeds before DB commit | uncertain | provider query | yes | adopt by idempotency/read-back |

## 12. Duplicate/Sprawl Analysis

| Redundancy | Type | Risk | Recommendation |
|---|---|---|---|
| Legacy QBO-named columns/views beside provider-neutral connections | data/code | MED | Keep compatibility views; new code uses neutral connector/job references. |
| QBD in-memory queue beside pg-boss/Postgres durability | code/data | HIGH | Replace runtime queue ownership with `provider_jobs`; keep SOAP formatting/session protocol thin. |
| Locked forward “reply send” versus requested Gmail drafts | integration | HIGH | Keep gatekeeper forwarding for its distinct capture use; add separate draft-only service and relabel UI action. |
| Connector generic `create` plus posting-specific `postBill` | code | MED | Specify `postBill` as posting contract for this phase; do not add a third path. |
| Stubs for Xero/Sage | scope | LOW | Leave capability-declaring stubs untouched; not QuickBooks editions. |

## 13. Build / Reuse / Delete Decisions

| Component | Decision | Rationale | Priority | Dependencies |
|---|---|---|---|---|
| AccountingConnector/QBO adapter | REUSE WITH CHANGES | Correct neutral boundary; needs edition/capability and production-enablement policy | 1 | schema |
| QBD SOAP/QWC/qbXML code | REUSE WITH CHANGES | Protocol work exists; durability/write/read-back missing | 1 | provider jobs |
| QBD in-memory pending queue | DELETE after migration | Cannot survive restart or support tenant isolation reliably | 1 | durable queue tests |
| Gmail ingest/OAuth | REUSE WITH CHANGES | Read path exists; add compose scope and draft adapter | 2 | draft schema |
| Pipeline extraction/proposals/audit | REUSE AS-IS where possible | Mature guarded workflow | 2 | document router |
| Bank statement domain | BUILD NEW | No current model/workflow | 2 | document schema |
| Draft UI/API | BUILD NEW | Human-in-loop requirement | 3 | Gmail draft service |
| Locked gatekeeper forwarder | LEAVE ALONE | Separate security function; not general replies | 3 | none |
| Xero/Sage stubs | LEAVE ALONE | Explicitly outside QuickBooks scope | 4 | none |

## 14. Non-Scope

- We are not supporting QuickBooks Mac or discontinued/self-employed products without a supported programmatic write surface because fabricating compatibility would risk accounting data.
- We are not auto-sending Gmail messages because the owner requires human sending.
- We are not auto-importing bank-statement lines as journal entries because classification uncertainty can corrupt books.
- We are not enabling production QBO or real-company QBD writes during build verification because external accounting writes require owner-approved certification.
- We are not adding Xero, Sage, payroll, payments, tax filing, or banking credential aggregation because they are independent systems.
- We are not replacing existing proof, audit, authentication, tenant isolation, or installer architecture unless a chunk explicitly requires a compatible extension.

## 15. Risk Register

| Risk | Likelihood | Impact | Mitigation | Owner |
|---|---|---|---|---|
| A provider write succeeds but AP Hub cannot determine it, causing a duplicate retry | MED | HIGH | Durable idempotency, provider duplicate probe, read-back adoption, held uncertainty | application owner |
| “Any edition” is interpreted beyond supported Intuit APIs | HIGH | HIGH | Publish capability matrix and fail visibly on unsupported editions/features | application owner |
| QBD asynchronous jobs are lost or cross tenant boundaries | MED | HIGH | Durable scoped leases, unique idempotency, expiry/recovery tests | application owner |
| Statement extraction produces plausible but wrong lines | MED | HIGH | arithmetic validation, immutable source evidence, mandatory review before accounting writes | application owner |
| Gmail draft permission expands into sending | LOW | HIGH | draft-only interface, least OAuth scope, architecture/no-send tests | application owner |
| Live integration behavior differs from mocks | HIGH | MED | disposable QBO/QBD/Gmail certification suite before production enablement | application owner |
| Migration rollback damages existing records | LOW | HIGH | additive migrations, reversible DOWN only for empty new tables, backup/restore drill | application owner |

Top architecture failure: ambiguous external-write outcomes followed by blind retries would destroy trust through duplicate accounting records. The mitigation is load-bearing and test-mandatory.

## 16. Definition of Done

1. A capability matrix identifies supported QBO and QBD editions/operations and rejects unsupported operations with `UNSUPPORTED_CAPABILITY`.
2. QBO sandbox and simulated QBD QBWC both satisfy the same bill-posting connector contract, including identity, duplicate, read-back, and audit behavior.
3. QBD work survives process restart in Postgres and a job cannot be leased by another tenant/connection.
4. Invoice attachments continue to produce proof-gated proposals with no regression in existing tests.
5. Bank-statement fixtures produce statement/line records, detect duplicates and imbalance, and never create accounting records without explicit approval.
6. Gmail draft fixtures create or update a draft in the original thread, and static/runtime tests prove no general send method is reachable.
7. Every new read/action API is session-authenticated, role-checked, and cross-tenant isolated.
8. Every external mutation has a stable idempotency key, append-only audit record, and recoverable uncertain state.
9. Lint, boundary scan, typecheck, all application/broker tests, web production build, and UI contract tests pass.
10. Live Gmail, QBO sandbox, and QBD test-company certification is reported separately and is never inferred from mocks.

## 17. Handoff to Spec-Superstar

1. Write one FULL brownfield spec for supported QuickBooks integration, statement intake, and Gmail drafts.
2. Use `accounting_documents`, statements/lines, provider jobs, and reply drafts as new entities.
3. Preserve existing auth, proof gates, tenant isolation, dry-run behavior, QBO sandbox protection, idempotency, and audit trail.
4. Require capability-driven behavior; never promise unsupported Intuit editions.
5. Treat Gmail sending, production accounting writes, and automatic statement journal entries as explicit non-scope.
6. Define 5–8 phases: schema/contracts, QBD durability/write adapter, statement domain, Gmail drafts, UI/API, hardening/certification.

## 18. Handoff to O2O

1. Build additive schema and canonical contracts first.
2. Build QBD durable queue before enabling its write request generation.
3. Bank-statement and Gmail-draft services can proceed independently after schema.
4. UI/API follows service contracts.
5. Cross-provider verification and hostile safety audit run last.
6. No task may perform live accounting writes or send email.

## 19. Handoff to QA / Audit

1. Verify provider contract parity across QBO mock/sandbox adapter and QBD SOAP simulation.
2. Force timeout-after-create and prove adoption rather than duplication.
3. Restart between QBD enqueue and lease/response.
4. Attempt cross-tenant leases, statement reads, draft mutations, and provider posts.
5. Feed duplicate, malformed, encrypted, multi-page, and unbalanced statement fixtures.
6. Search active source for Gmail `send`, proof bypasses, direct provider imports, and write modes outside connector boundaries.
7. Verify all user-visible capability claims match executable behavior.
8. Keep live external certification NOT VERIFIED until disposable-account evidence exists.

## 20. Final Architecture Verdict

**READY_FOR_SPEC.** All eight intake gates are known: the primary user is an SMB owner; the core workflow and entities are mapped; Postgres, Gmail, QBO, QBD, LLM, proof, and queue boundaries are explicit; QuickBooks remains the external system of record; irreversible accounting writes and human email sends have guards; and auth/proof risks have concrete mitigations. No unresolved source-of-truth conflict remains.

[G7 CHECK: 0 unresolved CRITICAL risks found — verdict remains READY_FOR_SPEC.]
