# Truth Before Launch Audit — AP Hub

**Target:** AP Hub  
**Audit mode:** Full  
**Audited implementation:** `main` at `77922c6`  
**Repository:** `https://github.com/foxfirepoets/ap-hub.git`  
**Live URL:** UNVERIFIED — no authoritative application deployment is configured or documented  
**Audit date:** 2026-07-24 (America/Phoenix)  
**Overall verdict:** **RED — not production-certified**

The repository is locally verified and all discovered high, medium, and low repository
issues were corrected. This is not a production launch certification: no live application
URL, deployment record, deployed SHA, live credentials, or target-environment traces were
available. Under the Truth Before Launch evidence rules, local tests cannot substitute for
live proof.

## Synthesis

| Audit | Verdict | Evidence | Launch blocker |
|---|---|---|---|
| Source of truth | RED | GitHub repository and `main` are authoritative for source; no open PRs or CI runs; no application deployment manifest or live URL | Live target and deployed revision are undefined |
| Canonical routes and product surface | YELLOW | Static inventory and Next production build cover 14 product pages and the API surface without a duplicate local product shell | Routes were not exercised on an authoritative live host |
| Auth, billing, entitlement | RED | Signed server session, hashed stored tokens, invited-user SSO, tenant scoping, and RBAC have local tests | Login/session/role behavior has no live two-user proof; billing and entitlements are structurally absent |
| Integration reality | RED | Gmail intake/drafts, QBO, QBD, model, SwarmSync, and Telegram have concrete implementations and local contract tests; Xero and Sage Intacct are explicit unsupported stubs | No target-environment Gmail, QBO/QBD, model, proof-service, or alert trace was supplied |
| Production parity | RED | Lint, secret/boundary scan, TypeScript, unit/integration-style local tests, production web build, and browser contracts pass | No live deploy, logs, runtime env, browser run, callback trace, or provider mutation trace |
| Deploy custody and GitHub reconciliation | RED | Local source history is auditable and intended for `origin/main`; ignored tracked-file scan found no custody leak | No production platform/deploy ID/deployed SHA exists to reconcile |
| Claims, copy, and demo truth | YELLOW | Current README and product copy now distinguish draft from send, sandbox from production, and configured installs from deployment | Customer-visible copy cannot be compared with a live surface |
| End-to-end money path | N/A | No pricing, checkout, payment processor, subscription, invoice collection, webhook, or entitlement path exists in this product | N/A unless commercial billing is added |
| Environment ambiguity | RED | Repository, branch, and local SHA are known | Live URL, platform, deploy project, runtime identity, and deployed SHA are unknown |

## Source of Truth Map

| Surface | Authority | Result |
|---|---|---|
| Source repository | `foxfirepoets/ap-hub` | VERIFIED |
| Canonical branch | `main` | VERIFIED |
| Audited implementation | `77922c6` | VERIFIED locally |
| Open pull requests | None returned by GitHub CLI | VERIFIED at audit time |
| GitHub Actions | No workflow runs returned | NO CI EVIDENCE |
| Application hosting platform | Not configured in repository or GitHub metadata | UNVERIFIED |
| Canonical live URL | None found | UNVERIFIED |
| Deployed revision | No provider deployment record | UNVERIFIED |

## Canonical Product Surface

The local canonical pages are `/`, `/login`, `/today`, `/exceptions`,
`/exceptions/dimensions`, `/exceptions/tax`, `/onboarding`, `/settings`,
`/settings/tax-mapping`, `/settings/tax-mapping/[id]`, `/statements`,
`/statements/[id]`, `/transactions`, `/transactions/[id]`, and `/audit`.
The production build enumerated these routes and the associated authenticated APIs.
No competing local dashboard or duplicate product shell was found. Live route reachability,
redirect behavior, metadata, and navigation remain UNVERIFIED.

## Auth and Access Trace

| Check | Local evidence | Live evidence |
|---|---|---|
| Unauthenticated rejection | Unit and browser contract tests | UNVERIFIED |
| Invited owner login | SSO/session tests | UNVERIFIED |
| Stranger self-provision refusal | Auth guard tests | UNVERIFIED |
| Owner/bookkeeper/CPA permissions | RBAC and browser contract tests | UNVERIFIED |
| Cross-tenant isolation | Database/service tests | UNVERIFIED |
| Session expiry/revocation | Session tests | UNVERIFIED |

No billing, plan, subscription, or entitlement mechanism exists, so billing-specific checks
are structurally N/A. Authentication remains launch-blocking because it is not proven in a
real target environment.

## Integration Reality Matrix

| Integration | Classification | Evidence | Missing proof |
|---|---|---|---|
| Gmail intake and attachments | Real, local-only | OAuth, polling, deduplication, attachment and body intake code/tests | Real mailbox trace |
| Gmail drafts | Real, local-only | Compose-scope handling, create/update/discard/reconcile, explicit no-send contract | Real Gmail draft ID and human verification |
| QuickBooks Online | Real, environment-gated | OAuth, refresh, company binding, sandbox/production clients, idempotent posting/read-back tests | Real sandbox and explicitly gated production traces |
| QuickBooks Desktop | Real, Windows-bound | QBWC SOAP, exact-company guard, durable queue, read-back and ambiguity tests | Real supported Windows/QB company trace |
| Invoice/statement model | Real, configurable | Provider adapters, PDF rendering, schema/fail-closed tests | Real configured-provider trace |
| SwarmSync proof service | Real but optional/missing env | Concrete client and fail-closed/optional tests | Target service trace |
| Telegram alerts | Real but optional/missing env | Concrete alert path and failure tests | Target alert trace |
| Xero / Sage Intacct | Stubbed and explicitly unsupported | Stub connector boundary | Not part of supported launch surface |

## Production Parity Gate

| Check | Result |
|---|---|
| 1. Static and type gates | PASS |
| 2. Local production build and browser contracts | PASS |
| 3. Authoritative deployment exists | FAIL — no live target |
| 4. Deployed SHA matches audited source | FAIL — no deployed SHA |
| 5. Live runtime environment is identified | FAIL — no provider/runtime record |
| 6. Live authentication and protected routes work | FAIL — no live URL/users |
| 7. Live integrations complete real operations | FAIL — no target traces |
| 8. Live logs and persistence confirm outcomes | FAIL — no deployment/log authority |

## Claims Corrected During This Audit

- Replaced the claim that tenant setup is configuration-only with the actual per-business
  install, credential, company, backup, write-gate, and validation requirements.
- Distinguished Gmail draft creation from transmission; sending a draft stays human-only.
- Distinguished the separate fixed-destination, owner-released invoice forwarder.
- Corrected sandbox-only QuickBooks language now that production QBO is implemented behind
  fail-closed master, company, backup, and owner gates.
- Removed the claim that proof-service outage exceptions clear automatically.
- Corrected pause/resume language for provider work whose result may be unknown.
- Corrected active QuickBooks Desktop implementation comments and retained Xero/Sage as
  explicit unsupported stubs.
- Fixed production QBO postings generating sandbox deep links in transaction and evidence
  read models; added regression tests for both hosts.

## Verification Evidence

- Root ESLint: PASS
- Provider/OS boundary and secret leak scan: PASS
- Root TypeScript: PASS
- Root tests: **62 files, 478 tests passed**
- Next.js production build: PASS, 39 static pages generated and route table collected
- Playwright browser contracts: **24 passed**
- Broker TypeScript: PASS
- Broker tests: **8 files, 39 tests passed**
- `git diff --check`: PASS before implementation commit

## Launch Blockers

1. Establish and document the authoritative live application URL, hosting project, runtime,
   and deployment procedure.
2. Deploy a reviewed `main` revision and capture an immutable provider deployment ID and SHA.
3. Run live authentication with at least two roles and prove tenant isolation.
4. Run disposable Gmail plus QBO sandbox validation, including invoice download,
   classification, draft creation, owner-approved posting, provider read-back, and logs.
5. Run supported Windows QuickBooks Desktop validation where that edition is offered.
6. Re-run this audit against the live URL and deployed SHA. Until then, the launch verdict
   remains RED regardless of local gate results.
