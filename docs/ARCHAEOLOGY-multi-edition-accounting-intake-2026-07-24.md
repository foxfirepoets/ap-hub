# Existing Project Archaeology: Multi-Edition Accounting Intake

Confidence: 90% for repository structure and local behavior. A local instance answered read-only probes, but its deployed revision could not be matched to Git commit `a311fd54e8c4010712a48df12680f70c3c297020`; live observations are therefore not proof of this worktree.

## Executive summary

AP Hub is a substantial brownfield TypeScript/Postgres application, not a greenfield scaffold. Invoice Gmail intake, extraction, review, tenant-scoped auth, proof-gated QBO sandbox posting, and the Next.js review surface are PARTIAL: code and automated evidence exist, but live external Gmail/QBO/LLM behavior is not certified. QuickBooks Desktop has a real QBWC protocol seam but only a read-only, process-memory work queue. Bank-statement handling and Gmail draft creation are absent. The largest unresolved uncertainty is live provider behavior across supported QBO/QBD editions.

## Project map

| Area | Classification | Evidence |
|---|---|---|
| Web routes and RBAC | PARTIAL — code-read and local probe | `app/api/**/route.ts`; `/login` returned 200 and `/api/me` returned 401, but deploy revision is unconfirmed. |
| Backend health | PARTIAL — local probe | `http://127.0.0.1:3001/health` returned 200; deploy revision unconfirmed. |
| Gmail read/download | PARTIAL | `src/gmail/client.ts`, `src/gmail/adapter.ts`, `src/pipeline/poll.ts`, ingest tests. External OAuth not verified. |
| Invoice classification/extraction | PARTIAL | `src/pipeline/classify.ts`, `src/pipeline/extract.ts`, extraction tests. Live LLM not verified. |
| QBO posting | PARTIAL | `src/connectors/qbo.ts`, `src/pipeline/posting.ts`, sandbox-only writer tests. Live sandbox not verified in this archaeology pass. |
| QBD read | PARTIAL | `src/qbdesktop/{soap,qwc,qbxml,session,index}.ts` and tests. |
| QBD write | STUB/DISCONNECTED | qbXML write primitives exist, but active config/control/CLI are read-only and work is process-memory. |
| Bank statements | CLAIMED-ONLY/MISSING | No statement schema, service, route, or tests found. |
| Gmail drafts | MISSING | Gmail interface has read plus locked forwarding; no draft API contract. |
| Existing “reply send” | PARTIAL but wrong product fit | `app/api/replies/[id]/send` routes to locked forwarding, not Gmail drafts. |
| Audit/proof | PARTIAL | `audit_log`, `proof_refs`, reconciliation, and extensive tests; deployed evidence not matched to source. |

## Source-of-truth map

| Record | Authority | Conflicting writers |
|---|---|---|
| Email/message/draft | Gmail; local DB is a projection | None for drafts yet; locked forward is a distinct action. |
| Source document bytes | `attachments` + `attachment_blobs` keyed by hash | No independent writer found. |
| Pipeline state | Postgres messages/extractions/proposals/exceptions | Stage-specific services; human actions use service layer. |
| Accounting transaction after posting | Connected QuickBooks company | Only connector-mediated posting path is authorized. |
| Posting intent/evidence | Postgres proposal/posting/reconciliation/audit records | Legacy QBO-named compatibility views exist but do not independently write. |
| QBD work | Current process-memory queue | This is the critical durability defect; replace with a DB authority. |
| Human identity | `users` and `sessions` | No second auth system on the active path. |

## Reconstructed intended specification and drift

The implemented product intends to ingest accounting email, extract invoices, surface evidence and exceptions, learn mappings, and post guarded bills to an accounting provider. The provider-neutral connector contract anticipates QBD, but only QBO is operationally implemented. Product drift:

- Specced/claimed provider neutrality exceeds live connector coverage.
- “Reply” currently means a locked forward; the owner now requires Gmail drafts.
- No statement domain exists despite the broader accounting-assistant goal.
- QBD write builders exist below an intentionally read-only active surface.
- Mocked UI contracts prove role presentation, not live provider integrations.

## Risks

| Severity | Finding |
|---|---|
| CRITICAL | A QBD write queue held in process memory cannot provide restart safety, tenant isolation, or reliable idempotency. |
| HIGH | A write may succeed externally while the local response is lost; blind retries would duplicate accounting records. |
| HIGH | “Any QuickBooks edition” is false unless capabilities and unsupported editions are explicit. |
| HIGH | Statement extraction without arithmetic and review gates can create plausible but wrong accounting data. |
| HIGH | Reusing the existing forward action as “draft” could send or route mail contrary to user intent. |

## Continue / Cut / Redo

| Component | Verdict | Next action |
|---|---|---|
| QBO connector and guarded posting | CONTINUE | Generalize capability/edition reporting without bypassing its writer. |
| QBD SOAP/QWC/qbXML protocol | CONTINUE | Attach it to durable provider jobs and simulated contract tests. |
| QBD process-memory queue | REDO | Make Postgres the work authority before enabling writes. |
| Bank-statement handling | REDO/BUILD | Add canonical document, statement, line, validation, review, and filing flow. |
| Gmail read/OAuth | CONTINUE | Add least-privilege draft operations. |
| Existing reply-send UX for user correspondence | CUT from that flow | Preserve locked gatekeeper forwarding separately; introduce draft-only UI/API. |
| Proof, RBAC, tenant scoping, audit | CONTINUE | Treat as must-not-break gates. |

Build mode: HIGH-ASSURANCE. Order: durable external-write boundary → statement correctness → Gmail no-send drafts → UI/API → live certification.

Quality gate:

- [x] Findings label code-read/live uncertainty.
- [x] Live probes include status codes and revision mismatch caveat.
- [x] Critical claimed-only paths are flagged.
- [x] Source of truth is named for core/multiply-written records.
- [x] No deletion recommendation is made without separating the still-used gatekeeper forward path.
- [x] The largest unresolved uncertainty—live cross-edition provider behavior—is explicit.
