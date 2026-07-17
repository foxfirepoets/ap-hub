# ARCHITECTURE (reference) — AP-Hub cross-platform, provider-neutral AP automation platform

**Date:** 2026-07-17 · **Status:** Grounding document for `SPEC-pilot-harness-key-broker.md` · **Type:** durable architecture + planning matrices (NOT a build spec)

> This document holds the **durable product architecture** and the **planning matrices** the owner directed on 2026-07-17: cross-platform (Windows + macOS), provider-neutral accounting connectors (QuickBooks Online, QuickBooks Desktop, Xero, Sage Intacct), the canonical AP model, threat models, and the staged pilot boundaries. The **buildable slice (Phase 1A)** lives in the SPEC and is chunked from there. Nothing here is built until its phase; this file is what keeps the narrow pilot from hard-coding assumptions that block the full product.
>
> Research-dependent matrices (QBD/Xero/Sage) cite `specs/reference/provider-research-2026-07-17.md`, produced by two deep-research passes on 2026-07-17. Where a fact is `[UNCERTAIN]`, its phase must verify it against live provider docs before that connector is enabled.

---

## 0. Grounding evidence (why this is an extraction, not a rewrite)

Verified against the repo on 2026-07-17:

| Claim | Evidence | Consequence |
|---|---|---|
| Core is already OS-neutral | `grep` for `process.platform` / `win32` / `C:\` / registry / DPAPI across `src/` and `app/` → **zero OS-specific lines** (only business-logic regexes) | macOS port is thin host adapters, not a core rewrite |
| Connector signature is already generic | `src/qbo/write.ts:28` — `createEntity(type: string, payload: Record<string,unknown>, requestId: string)` | Provider-neutral contract is an interface rename + capability flags, not new logic |
| Read-back verification already exists | `src/pipeline/posting.ts:147` — `readEntity` → `reconciliation` row `proposal_vs_created` | The QBD "authoritative read-back" requirement reuses this pattern |
| Idempotency already exists | `migrations/001_init.sql:117` — `UNIQUE(tenant_id, idempotency_key)` on `postings`; `requestId` threaded to `createEntity` | Duplicate/replay protection is provider-agnostic already |
| Dimensional accounting already modeled | `migrations/001_init.sql:75` — `mappings.kind` ∈ `vendor|account|class|location|project|item|customer` | Canonical dimensions map to existing rows |
| Schema widens without migration | `migrations/001_init.sql:2` — "JSON blobs are JSONB so new fields never block the schema"; `proposals.proposed_txn` is JSONB | Canonical AP model can grow provider fields with no DB migration |
| Token storage already portable | `src/auth/tokens.ts` — AES-256-GCM (`src/crypto.ts`) into Postgres, keyed by `ENCRYPTION_KEY` | Only the master key needs an OS keystore; per-provider tokens are already app-encrypted |
| Provider enum is small | `src/auth/tokens.ts:10` — `type Provider = 'gmail' | 'qbo'` | Widen to add `xero|sage_intacct|qbd`; trivial |

**Implication:** the platform direction is reachable by *extracting interfaces around tested logic* (the owner's explicit instruction), not by rebuilding. The six guarantees and their tests are untouched by interface extraction.

---

## 1. Layered architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  BROWSER UI (Next.js) — setup + dashboard, OS-neutral, served locally │
└─────────────────────────────────────────────────────────────────────┘
                                  │ local HTTP
┌─────────────────────────────────────────────────────────────────────┐
│  AP-HUB CORE  (cross-platform, shared — the existing src/ pipeline)   │
│  Gmail ingest · folder ingest* · OCR/extract · classify · vendor      │
│  match · duplicate detect · proof validation · approval workflow ·    │
│  audit log · idempotency · fail-closed control · canonical AP model   │
└─────────────────────────────────────────────────────────────────────┘
        │ AccountingConnector          │ HostAdapter        │ BrokerClient
        ▼ (provider-neutral)           ▼ (OS-neutral)       ▼ (host-neutral)
┌──────────────────────┐   ┌────────────────────────┐   ┌──────────────────┐
│ CLOUD CONNECTORS      │   │ HOST ADAPTERS           │   │ KEY BROKER        │
│  QBO  · Xero · Sage   │   │  Windows | macOS        │   │ (Render, portable)│
│  (REST/OAuth adapters)│   │  supervisor · keystore  │   │ holds Claude +    │
│                       │   │  scheduler · packaging  │   │ SwarmSync keys    │
│ LOCAL-DESKTOP CONN.   │   │  fs-permissions         │   └──────────────────┘
│  QBD via Windows      │   └────────────────────────┘
│  bridge (qbXML/QBWC)  │
└──────────────────────┘
```
`*folder ingest` is designed here (threat model §8) but scheduled Phase 1B+, not Phase 1A.

**Three seams, three contracts.** Each is a TypeScript interface with a reference implementation and a contract-test suite that every implementation must pass:
1. `AccountingConnector` — provider-neutral (§4). Reference impl: QBO sandbox (Phase 1A).
2. `HostAdapter` — OS-neutral (§3). Reference impl: Windows (Phase 1A); macOS designed here, built Phase 1B.
3. `BrokerClient` — host-neutral (§7). Reference impl: Render broker (Phase 1A).

The rule that keeps the pilot honest: **no provider-specific or OS-specific symbol may appear in AP-Hub Core.** A connector or host adapter that leaks a QBO field name or a Windows path into core is a contract violation, caught by a lint rule (§9) and by the contract tests.

---

## 2. Cross-platform decision (firm recommendation)

**Recommendation: a shared cross-platform supervisor (Node) with thin OS adapters; validate Windows first, then macOS — NOT a Windows-specific core, NOT two parallel harnesses.**

Rationale, grounded in §0:
- The core is already OS-neutral, so there is no core to "port" — the only OS-specific code is the host adapter (launch/monitor child processes, protect the master key, register autostart, package the app).
- Building the supervisor as one cross-platform Node program behind a `HostAdapter` interface means the Windows pilot **cannot** hard-code an assumption that blocks macOS: everything OS-specific is forced through the adapter seam, which has a macOS implementation stubbed from day one (compile-checked, even before it is exercised).
- Windows-first (not parallel) because the pilot's *measurement* goal (liveness, watchdog recovery, Postgres survival) needs one real OS to produce numbers; doing two at once doubles the harness surface before the first number exists. macOS host adapter is written and type-checked in Phase 1A but **exercised** in Phase 1B.

**Rejected:** parallel Windows+macOS harnesses (doubles pilot surface pre-evidence); Windows-specific core (the thing the owner explicitly forbade, and §0 shows is unnecessary).

### OS-specific component map (every Windows piece has a named macOS equivalent)

| Concern | Windows | macOS | Behind interface |
|---|---|---|---|
| Autostart / supervision trigger | Task Scheduler task (non-elevated, on-logon + 5-min) | LaunchAgent (`~/Library/LaunchAgents`, `RunAtLoad` + `KeepAlive`) | `HostAdapter.registerAutostart()` |
| Master-key protection (`ENCRYPTION_KEY` + broker token) | DPAPI (`CryptProtectData`, per-user) | Keychain (`security` / Keychain Services, per-user) | `HostAdapter.secretStore` |
| Background process model | Non-elevated child processes under supervisor | Same (LaunchAgent-owned processes; **not** a LaunchDaemon — no root) | `HostAdapter.spawnChild()` |
| App data directory | `%LOCALAPPDATA%\APHub` | `~/Library/Application Support/APHub` | `HostAdapter.dataDir()` |
| Log directory | `%LOCALAPPDATA%\APHub\logs` | `~/Library/Logs/APHub` | `HostAdapter.logDir()` |
| Filesystem permission model | ACL on data dir to current user | POSIX 0700 + macos privacy (TCC) prompts for Documents/Downloads/Desktop | `HostAdapter.fsPermissions` |
| Packaging (Phase 2) | Signed installer (EXE/MSI) | Signed **and notarized** `.pkg`/`.dmg` (Apple Developer ID + notarization) | Phase 2 — not built now |
| Code signing (Phase 2) | Authenticode cert | Apple Developer ID Application cert + notarization staple | Phase 2 |
| Update/rollback (Phase 2) | Re-run installer / updater | Re-run installer / updater | Phase 2 |

macOS-specific gotcha to design around now: **TCC privacy prompts** — on macOS 10.15+ an app touching `~/Documents`, `~/Downloads`, `~/Desktop`, or cloud-sync folders triggers a system permission dialog. The folder-discovery design (§8) must treat "permission denied by TCC" as a first-class, user-resolvable state, not an error. This is the macOS analogue of Windows Controlled Folder Access.

---

## 3. HostAdapter contract (OS-neutral)

```ts
export interface HostAdapter {
  os: 'windows' | 'macos';
  dataDir(): string;                 // %LOCALAPPDATA%\APHub | ~/Library/Application Support/APHub
  logDir(): string;
  secretStore: SecretStore;          // DPAPI | Keychain — protects the master key only
  spawnChild(spec: ChildSpec): ChildHandle;   // launch + monitor Postgres/backend/next
  registerAutostart(cmd: string): Promise<void>;   // Task Scheduler | LaunchAgent
  unregisterAutostart(): Promise<void>;
  fsPermissions: FsPermissions;      // ACL | POSIX+TCC — used by folder discovery (§8)
  probePort(port: number): Promise<{ free: boolean; pid?: number; name?: string }>;
}

export interface SecretStore {         // protects ENCRYPTION_KEY + broker install token at rest
  put(name: string, secret: string): Promise<void>;
  get(name: string): Promise<string | null>;
  delete(name: string): Promise<void>;
}
```

**Contract tests** (`test/host-contract.test.ts`) run against whichever adapter is present: `dataDir()` is absolute and user-scoped; `secretStore` round-trips a value and returns `null` after delete; `probePort` reports a known-occupied port with a PID. The Windows adapter passes them in Phase 1A on a real machine; the macOS adapter is compiled in Phase 1A and passes them in Phase 1B on a real Mac.

---

## 4. AccountingConnector contract (provider-neutral)

Extends the existing `QboWriteClient`/`QboReadClient` shape (`src/qbo/`) — same method spirit, generalized names, plus capability discovery and explicit unsupported-feature responses.

```ts
export type ProviderId = 'qbo' | 'qbd' | 'xero' | 'sage_intacct';
export type ConnectionClass = 'cloud' | 'local_desktop';

export interface AccountingConnector {
  readonly provider: ProviderId;
  readonly connectionClass: ConnectionClass;
  capabilities(): CapabilityMatrix;                         // static + discovered
  connect(cfg: ConnectorConfig): Promise<ConnectHandle>;    // OAuth (cloud) | bridge session (qbd)
  verifyCompanyIdentity(expected: CompanyIdentity): Promise<'match' | 'mismatch'>;  // guard before any write
  read(entity: CanonicalEntityKind, where?: CanonicalQuery): Promise<CanonicalRecord[]>;
  create(entity: CanonicalEntityKind, record: CanonicalRecord, idempotencyKey: string): Promise<CreateResult>;
  readBack(entity: CanonicalEntityKind, externalId: string): Promise<CanonicalRecord>;   // authoritative post-write verify
  attach(entity: CanonicalEntityKind, externalId: string, doc: Buffer, filename: string): Promise<AttachResult | Unsupported>;
  close(handle: ConnectHandle): Promise<void>;
}

export interface CapabilityMatrix {
  read: CanonicalEntityKind[];
  write: CanonicalEntityKind[];
  attachments: boolean;
  purchaseOrders: boolean;
  itemReceipts: boolean;
  dimensions: DimensionKind[];      // class|location|department|project|tracking_category|custom
  multiCurrency: boolean;
  multiEntity: boolean;
  changeFeed: 'webhook' | 'polling';
  idempotency: 'native' | 'app_enforced';   // qbd/qbo use RequestID; app enforces where absent
  unsupported: CanonicalFieldPath[];         // explicitly listed — NEVER silently dropped
}

export type Unsupported = { unsupported: true; field: CanonicalFieldPath; reason: string };
```

**Hard rules (mirror the owner's "never silently drop" and "fail closed"):**
- Any canonical field a provider cannot represent is returned as `Unsupported` and surfaced to the user + written to the audit log. A connector **must not** drop, coerce, round, or approximate an unsupported field.
- `create` returns a duplicate outcome (not a second write) when `idempotencyKey` was already used — same guarantee the QBO path enforces today via `UNIQUE(tenant_id, idempotency_key)`.
- Every `create` is followed by `readBack`; a `create` is **not complete** until `readBack` confirms the record and returns its `externalId` + `revision` (QBO `SyncToken` / QBD `EditSequence` / Xero `UpdatedDateUTC` / Sage `RECORDNO`+`WHENMODIFIED`). Unknown/partial/malformed read-back = failure = hold. (This generalizes guarantee-5 fail-closed to every provider.)
- `verifyCompanyIdentity` must return `match` before any `create` is permitted. Prevents writing to the wrong company/realm/org/file.

**Minimum connector contract (all four must implement):** `read` of vendors + accounts, `create` of a bill, `readBack`, `verifyCompanyIdentity`, `capabilities`. Attachments, POs, item receipts, and dimensions are **optional capabilities**, discovered via `capabilities()`, never assumed.

### Provider capability matrix (summary; full detail + sources in `provider-research-2026-07-17.md`)

Full detail + sources: `provider-research-2026-07-17.md`. Summary:

| Capability | QBO | Xero | Sage Intacct | QBD |
|---|---|---|---|---|
| Class | cloud | cloud | cloud | **local_desktop** |
| API / auth | REST / OAuth2 | REST / OAuth2+PKCE (`Xero-tenant-id`) | XML Web Services (session) **+** REST/OAuth2 (partial, GA 2025 R1) | qbXML via SDK/Web Connector (no REST) |
| Bill create | `Bill` | **`Invoice Type=ACCPAY`** | `APBILL`/`APBILLITEM` (`create_bill`) | qbXML `BillAdd` |
| Attachments | `Attachable`+`AttachableRef` | `/Invoices/{id}/Attachments` (~25MB) | supdoc 2-call + `SUPDOCID` (XML) | via SDK |
| Vendor R/W | explicit vendor | **Contact; `IsSupplier` read-only/derived** | explicit `VENDOR` | `VendorQuery`/`VendorAdd` |
| Purchase orders | yes (shallow) | yes (weak API conversion) | **yes (full P2P)** | yes |
| Item receipts / 3-way | no | no | **yes** | limited |
| Dimensions | Class + Location | **≤2 Tracking Categories (line-level)** | **standard + unlimited user-defined (GL-native)** | Class + Customer:Job |
| Multi-entity | no | no | **yes** | no |
| Change feed | webhook + poll | webhook (Invoices/Contacts) + poll | Smart Events / REST webhook + poll | poll (Web Connector pull) |
| Sandbox/test | sandbox company | **free Demo (28-day reset)** | **gated (dev license + partner)** | disposable `.QBW` company |
| Rate limits | throttled | 60/min · 5k/day · 5 concurrent | perf-tier concurrency pairs | pull cadence (no HTTP RL) |
| Idempotency | `RequestId` param | **`Idempotency-Key` header** | **controlid/`uniqueid` (no header)** | qbXML `requestID` |

**Consequences baked into the contract (§4):** dimensions are an extensible list (Intacct breaks any fixed-column assumption); the canonical `Bill` carries a type discriminator (Xero overloads Invoice); vendor provisioning is per-adapter (Xero's supplier flag is derived, not set); idempotency is per-adapter with an app-side dedup ledger everywhere (only Xero has a real header). **Phase 1B sequences Xero before Sage** — Xero's free Demo company vs Sage's licensed/partner-gated sandbox is a large difference in time-to-first-test.

---

## 5. Canonical AP data model

One normalized model all providers map to. Storage: the existing `proposals.proposed_txn` (JSONB) + `mappings` + `postings` tables — **no migration required** for the model itself (JSONB widens freely; see §0). New top-level tables are added only for genuinely new entities (see §5.2).

### 5.1 Canonical entities (each maps to provider-specific objects via the connector)

Organization/Company · Connection(type, provider) · Vendor/Supplier · VendorAddress · VendorContact · **VendorPaymentInfo (heightened protection — §5.3)** · Bill · BillLine · BillAttachment · PurchaseOrder · POLine · ItemReceipt · Account · Item · Class · Location · Department · TrackingCategory · Dimension · Project · Customer · Job · TaxCode · Currency · PaymentTerms · ApprovalState · PostingState · PaymentState · ExternalProviderId · SourceRevision(EditSequence/SyncToken) · SourceModifiedAt · SyncState · IdempotencyKey · ProofReference · AuditReference · ErrorState · RetryState · ReconciliationState · PostWriteVerificationState.

Each canonical record carries: `{ canonical: {...}, providerRaw: {...}, capabilityGaps: Unsupported[], external: { provider, id, revision, modifiedAt } }`. `providerRaw` preserves the untranslated source so nothing is lost; `capabilityGaps` records exactly what a given provider could not represent.

### 5.2 Mapping to existing schema

| Canonical | Existing home | New? |
|---|---|---|
| Bill / BillLine / attachment ref | `proposals.proposed_txn` (JSONB) | No — widen JSONB |
| Vendor/Account/Class/Location/Project/Item/Customer mapping | `mappings(kind, ...)` | No — `kind` already enumerates these |
| PostingState / ExternalProviderId / revision | `postings(qbo_type→entity_type, qbo_id→external_id, sync_token→revision, ...)` | Column **rename** (generalize `qbo_*`), additive; back-compat view retained |
| ProofReference | `proof_refs` | No |
| AuditReference | `audit_log` | No |
| ReconciliationState / PostWriteVerificationState | `reconciliation` | No |
| ErrorState / RetryState | `exceptions` | No |
| Connection(provider, class) | `oauth_tokens` widened; `provider` enum + `xero|sage_intacct|qbd` | Additive enum + new `connections` metadata table for non-OAuth (qbd) |
| VendorPaymentInfo | **new table** `vendor_payment_info` (§5.3) | Yes — new, encrypted |

The only genuinely new storage is `connections` (to describe a QBD bridge connection, which is not OAuth) and `vendor_payment_info`. Both are additive migrations with UP/DOWN; nothing existing is dropped. The `qbo_*` → generic column renames ship with a compatibility `VIEW` so existing queries/tests keep working (the existing `v_proposal_review` view pattern, `migrations/001_init.sql:222`).

### 5.3 VendorPaymentInfo — heightened protection

Vendor banking details are the highest-value fraud target (the product already has vendor-bank-change detection). Rules:
- Stored in `vendor_payment_info`, **encrypted at rest** with the same AES-256-GCM path as OAuth tokens (`src/crypto.ts`), never plaintext.
- **Never** placed in `proposed_txn` JSONB, logs, telemetry, or broker traffic.
- Any change to a vendor's payment info raises a review gate (existing vendor-bank-change detection) — no auto-post across a payment-info change.
- Redaction list (`src/logger.ts`) extended to bank/routing/IBAN patterns.

---

## 6. Connector classes

### 6.1 Cloud connectors (QBO, Xero, Sage Intacct)
Officially supported REST/HTTP APIs, provider OAuth/session auth, sandbox/test targets, documented rate limits, webhook-or-polling change feed. All provider-specific behavior stays inside the adapter. Details + rate limits + sandbox mechanics: `provider-research-2026-07-17.md`.

### 6.2 Local-desktop connector (QuickBooks Desktop) — Windows bridge
QBD is **not** a REST API and must not be treated like one. It is reached only through officially supported Intuit mechanisms (qbXML via the SDK / Web Connector), which are Windows/COM-based — hence a **Windows-only local bridge** process behind the same `AccountingConnector` contract. Full mechanism, version matrix, environment matrix, and file-safety threat model: §10 + `provider-research-2026-07-17.md`.

**Topology that keeps macOS users first-class:** the QBD bridge runs on the Windows machine (or server/RDS/hosted env) where QuickBooks + the company file live. AP-Hub Core + dashboard can run anywhere (Windows or macOS); a Mac user drives QBO/Xero/Sage directly and, if their business also runs QBD, reaches it through a bridge deployed on the Windows/QBD host. **Native QBD-from-macOS is not offered** because no official Intuit mechanism supports it safely — stated plainly as a limitation, not worked around.

---

## 7. Broker portability (Render is the host, not the architecture)

`BrokerClient` is host-neutral; Render is one deployment. Requirements that keep it portable:
- **Interface, not URL:** installed clients hold `BROKER_BASE_URL` (config), never a Render-specific assumption. Moving hosts = change one env value pushed to installs via a config update, not a reinstall.
- **Reproducible from config:** `broker/render.yaml` is the Render binding; the broker itself is a plain Node service deployable to any Node host (Fly, Railway, a VPS) with the same env contract (§ SPEC-11). No Render-proprietary runtime API in broker code.
- **Portable data:** broker Postgres schema is standard SQL with UP/DOWN migrations; rollback never requires manual DB reconstruction (§ SPEC-13). A host move is a `pg_dump`/restore, not a rebuild.
- **Env separation:** dev / pilot / (future) production use separate broker deployments, separate DBs, separate credentials. A pilot token can never reach production data.
- **Identity + credential lifecycle:** every install gets a unique identity and a unique, **revocable and rotatable** token; per-install rate + request limits; global kill switch; a compromised install token exposes only that install (per-install scoping). The broker is a **narrow, allowlisted proxy** to Claude + SwarmSync only — never an open proxy, never a passthrough to accounting providers.

---

## 8. Filesystem discovery threat model (designed now, built Phase 1B+)

Not in Phase 1A (Phase 1A ingests from Gmail only). Designed here so the pilot's host adapter and permission model don't foreclose it.

**Principle:** bounded, permission-based, metadata-first, approval-gated. Never unrestricted scanning; never modify source files.

Flow: user picks locations → AP-Hub recommends common ones → shows every selected location → user can remove → **metadata-first pass** (names/sizes/types, no content read) → preview likely-AP folders/files → explicit approval → only then content import → monitor only approved folders. Source files are never altered, renamed, moved, or deleted without explicit per-action authorization.

| Control | Rule |
|---|---|
| Allowlist locations | Downloads, Documents, Desktop, selected company/accounting folders, user-selected network / OneDrive / Dropbox / Google Drive for Desktop / SharePoint-synced folders |
| Denylist (default, never scanned) | OS folders, app install dirs, browser profiles, password/credential stores, photo/music/video libraries, hidden/system dirs, temp, Recycle Bin/Trash, other user profiles, unapproved network/removable drives |
| File-type allowlist | PDF, common image types, and defined accounting document types only — exact list defined at build time |
| Size / archive | Max file size cap; archive (ZIP) handling with **ZIP-bomb protection** (ratio + depth + total-size limits); reject beyond limits |
| Malware | Scan-on-import hook; quarantine on hit |
| Loops | Symlink / junction loop detection with visited-inode set and depth cap |
| Cloud placeholders | Detect OneDrive/Drive "online-only" placeholders; do not force-hydrate without consent; handle hydration failure |
| Network drives | Timeout + graceful-degrade on unavailable network location; never block the pipeline |
| macOS TCC | Treat privacy-prompt denial as a resolvable user state (§2) |
| Transparency | User-visible access log of what was inspected; folder removal + rescan supported; local-vs-cloud processing controls; defined retention |

---

## 9. Guardrails that enforce the boundaries (build-time)

- **No-leak lint:** an ESLint rule forbids provider-specific identifiers (`qbo`, `Bill`, `SyncToken`, `Realm`, `Xero`, `Intacct`, `.QBW`, etc.) inside AP-Hub Core modules (everything except `src/connectors/**` and host adapters). Catches the exact way a "narrow" pilot rots into a QBO/Windows monolith.
- **Contract-test suites:** `AccountingConnector`, `HostAdapter`, `BrokerClient` each have a suite every implementation must pass. A provider that can't pass the minimum contract is not "supported."
- **Safety-test immutability:** the six-guarantee tests (`proof_fail_safe`, `gatekeeper_hold`, `proof_gate_posting`, `send_lockdown`, `no_prod_write`, `white_label_install`) are **never edited** to accommodate any connector, broker, or OS adapter. A conflict is a stop-and-escalate, not a test edit.

---

## 10. QuickBooks Desktop — mechanism, matrices, file-safety threat model

**Mechanism (CONFIRMED, `provider-research-2026-07-17.md#A`):** the only official platform is the **QuickBooks Desktop SDK** — **qbXML** messages processed by the Windows COM Request Processor (QBXMLRP2), reached either in-process (local Windows SDK app) or remotely via the **QuickBooks Web Connector (QBWC)**. No REST API, no macOS path. Writes = qbXML `BillAdd`; reads = `VendorQuery`/`BillQuery`/`TransactionQuery`.

**Bridge transport recommendation: Web Connector (QBWC).** QBWC is a SOAP **pull** model — QuickBooks periodically calls *our* endpoint (`authenticate`/`sendRequestXML`/`receiveResponseXML`/`getLastError`/`closeConnection`) over HTTPS. Chosen over a local SDK agent because it works on hosted QBD (Rightworks) and RDP without installing custom software on the QuickBooks box, which is the common real-world QBD deployment. Cost: scheduled/pull cadence (not real-time) and session-availability caveats. The bridge exposes the QBWC SOAP endpoint on the Windows/QBD host and speaks the `AccountingConnector` contract inward to AP-Hub Core.

**Authorization:** a `.QWC` file imported into QBWC; the QuickBooks **Admin** approves an Application Certificate and access level (incl. "even if QuickBooks is not running" for unattended, which requires an Admin password and single-user configuration).

**"QB running / file open?"** Interactive: QuickBooks running + company file open. Unattended: "Allow this application to login automatically" (Admin password, configured single-user).

**Version matrix (SDK 17.0 supported targets):** QBD **2002+** including **2023 (R16+), 2024 (R18+)**, and **Enterprise** (still sold). Pro Plus/Premier Plus = existing subscribers only (post-2024 stop-sell). Mac Plus = no SDK (not a QBD-integration target). Verify current-year add-on service-discontinuation dates at build time.

**Environment matrix:** local Windows (SDK or QBWC) · Windows Server / RDP (QBWC preferred) · hosted (Rightworks etc.) — QBWC supported, but background programs stop on disconnect, so scheduled runs need a kept-alive session or auto-login. Native macOS — **not supported by any official mechanism; stated as a limitation, not worked around.**

**Read-back + idempotency:** `BillAdd` returns server-generated **`TxnID`** + **`EditSequence`** → re-query by `TxnID` for authoritative read-back; `EditSequence` is the optimistic-concurrency token. Idempotency via qbXML **`requestID`** **plus** AP-Hub's own dedup ledger (the `requestID` suppression window is unverified — never rely on it alone; this satisfies the no-double-post guarantee by two layers, matching the existing QBO posting path).

**Test target:** no cloud sandbox — a **disposable/sample `.QBW` company file** is the write-test target; production writes stay disabled for the whole pilot.

**File-safety threat model (holds regardless of mechanism):** the bridge accesses QBD **only** through the running QuickBooks app via supported qbXML/SDK/Web Connector calls. It **never** opens, reads, writes, copies, renames, compacts, repairs, or otherwise touches the `.QBW` file directly, and never manipulates the underlying DB. Threats + mitigations: wrong-company write → `verifyCompanyIdentity` before every session; stale session after file switch → re-verify company identity per request, fail closed on mismatch; concurrent access / file lock → serialize bridge operations, respect single/multi-user mode; QB closed / file unavailable / Web Connector stopped / session expired → fail closed, raise exception, never report success; partial/unknown write result → treat as failure, hold, do not mark posted; duplicate/replay → RequestID idempotency + existing `UNIQUE(tenant_id, idempotency_key)`; every requested/attempted/completed/rejected/failed/retried/verified op → audit row; QB admin creds/certs/tokens → never logged, never in telemetry. Production write capability requires a **recent verified backup** and is **disabled for the entire pilot**; write testing uses only disposable/approved test company files. A QBD-connector **kill switch** disables the bridge immediately.

---

## 11. Staged phases — boundaries + objective entry/exit criteria

| Phase | Builds | Entry criteria | Exit criteria (objective) |
|---|---|---|---|
| **1A — Pilot foundation** *(buildable now; chunked in SPEC)* | Cross-platform core boundaries (3 contracts) · Windows host adapter · macOS host adapter **compiled/stubbed** · provider-neutral `AccountingConnector` + **QBO-sandbox reference impl (wraps existing code)** · canonical AP model (typed + JSONB) · Gmail ingest (existing) · broker (Render, portable) · install credentials · portable Postgres · supervisor + Windows watchdog · liveness telemetry · fail-closed everywhere · **all existing safety tests preserved** | Spec consistency PASS; test baseline recorded | All existing tests pass **unmodified**; broker fail-closed (4 outage cases hold); QBO-sandbox connector passes the `AccountingConnector` contract suite; Windows install non-admin, watchdog recovers backend+supervisor kills, reboot→3 processes alive; keys absent from disk/logs/telemetry; `pilot-report` emits the 3 numbers; no-leak lint green |
| **1B — Cross-platform + cloud expansion** | macOS host adapter **exercised** on real Mac · Xero test-org connector · Sage Intacct sandbox connector · shared provider-contract tests green for 3 cloud providers · capability matrix populated · folder-discovery (§8) impl · cross-platform restart/recovery | 1A exit met; Mac test machine available; Xero + Sage test targets provisioned | macOS install non-admin + LaunchAgent recovery; Xero + Sage pass the same `AccountingConnector` contract suite as QBO; unsupported-feature responses verified (never silent-drop); folder discovery honors allow/deny + metadata-first + approval gate |
| **1C — QBD bridge** | Windows QBD local bridge (supported Intuit mechanism) · disposable test company · read-only discovery · company-identity verify · controlled test-bill create · authoritative read-back (TxnID+EditSequence) · dup/replay protection · concurrency/closed/unavailable/session-expiry/WC-failure/restart tests · hosted-env assessment · wrong-file prevention · kill switch | 1B exit met; QBD + supported connector (Web Connector/SDK) installed on a Windows test host; disposable company file created; **verified backup taken** | Bridge passes `AccountingConnector` contract against a disposable company; **zero direct `.QBW` access** (verified); every write read-back-verified; all failure-mode tests pass fail-closed; kill switch works; production writes remain disabled |
| **2 — Final one-click installer** *(spec written only after pilot evidence)* | Desktop-shell decision (Electron / tray+browser / local-service+browser) · signed Windows installer · signed+notarized macOS package · auto-update + signing + rollback · production onboarding · **production accounting writes** · multi-user/multi-workstation/enterprise/MSI/policy/remote-support/DR | Pilot reports measured evidence (online-hours, watchdog recovery, Postgres survival, install compatibility, SmartScreen/TCC friction); owner go decision | Out of scope for this document — its own spec |

**Do-not-cross lines during the whole pilot (1A–1C):** production accounting writes disabled for every provider; QBO in sandbox, Xero in test org, Sage in sandbox, QBD in disposable company only; no unrestricted filesystem scanning; no existing test weakened; every provider/broker/proof/read-back path fails closed; no provider secret to any installed client; no sensitive accounting data in telemetry; environments + credentials separated; deployment reproducible; rollback safe; bundled Postgres isolated from any existing local Postgres.

---

## 12. Database strategy (pilot)

Keep PostgreSQL (existing tests + guarantees use PG-specific behavior; SQLite is rejected — rewriting to it to simplify install would break tested logic). Bundle a **private PostgreSQL** invisible to the user:
- **Model:** child process under the supervisor (not a Windows service / not a LaunchDaemon) — matches the brainstorm's non-elevated decision.
- **Port:** probe from a private base (e.g. 55432) upward; on conflict pick the next free port and record it; never collide with a system Postgres on 5432.
- **Conflict prevention:** private port + private data dir under the OS app-data dir; never touch an existing cluster.
- **Data location:** `dataDir()/pg` (§2 per-OS).
- **Credentials:** generated per install (random), stored in the local `.env` (ACL/0700), master `ENCRYPTION_KEY` protected by the OS keystore (§3).
- **Migrations:** existing runner (`src/db/migrate.ts`), idempotent, UP/DOWN; failed migration rolls back and the install fails loudly (no half-migrated state).
- **Backup/restore:** `pg_dump`/`pg_restore` of the private cluster; verified restore is part of the pilot acceptance.
- **Corruption detection:** startup `pg_isready` + a lightweight integrity check; a failed check emits a `pg_health` telemetry event (the corruption-incidence metric).
- **Interrupted install:** install is transactional-ish — a partial install is detected on next run and resumed or cleanly rolled back; no orphaned half-state.
- **Upgrades:** app upgrade runs pending migrations; DB binary upgrade (rare) documented; data preserved.
- **Uninstall:** **preserves accounting data by default.** Deleting all local AP-Hub data requires a **separate explicit confirmation** (typed acknowledgement), never the default path.

---

## 13. Cross-cutting risk register (additions from the platform direction)

Carried forward from the SPEC plus the direction's new risks:

1. **[HIGHEST] Broker fail-open on proof** — unchanged from SPEC; §9 immutability + 4 outage tests.
2. **[UNRESOLVED — carried] Local Postgres long-tail corruption (QBD-precedent)** — Archaeologist's dissent; now *more* relevant because QBD is explicitly in the product. Mitigation is isolation, not removal: QBD behind the narrow Windows bridge that cannot touch `.QBW`; local Postgres corruption stays a monitored post-launch risk with the pilot's `pg_health` metric as the early signal. Escalation path unchanged: cloud-relay pivot if it materializes.
3. **QBD wrong-company / stale-session write** — `verifyCompanyIdentity` per session + per request; fail closed on mismatch (§10).
4. **Silent capability loss across providers** — a connector dropping an unsupported field quietly corrupts books. Mitigation: `Unsupported` responses + capability matrix + contract test asserting no silent drop.
5. **Provider-specific leakage into core** — the "narrow pilot rots into a monolith" risk. Mitigation: no-leak lint (§9) + contract tests.
6. **macOS TCC / Windows Controlled-Folder-Access blocking discovery** — treated as first-class user-resolvable state (§8), surfaced by the pilot.
7. **Install-token leak** — per-install scope, revoke/rotate, kill switch, spend cap (§7 + SPEC).
8. **Business data in telemetry** — closed schema + content-assertion test (SPEC §10).
9. **Scope creep into Electron / production writes / 4 providers at once** — phase gates (§11) + Do Not Build; production writes disabled pilot-wide.
