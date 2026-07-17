# Provider integration research (2026-07-17)

Sourced briefs backing the capability matrices in `ARCHITECTURE-ap-hub-platform.md`. Two deep-research passes. CONFIRMED = Intuit/Xero/Sage source URL; UNCERTAIN = inferred or third-party only. Items marked "verify at build time" must be re-checked against live docs before that connector is enabled in its phase.

---

## A. QuickBooks Desktop (QBD)

**Bottom line:** one official platform, unchanged in 2025–2026 — the **QuickBooks Desktop SDK** (qbXML messages via the **Windows COM Request Processor QBXMLRP2**, optionally wrapped by **QBFC**), reached **in-process** on the same Windows box **or remotely via the QuickBooks Web Connector (QBWC)**. **No official REST API. No macOS-native path.** QBD forces a Windows component.

1. **Mechanisms (all current, none deprecated):** SDK 17.0 (bundles QBFC17/16 + QBXMLRP2); qbXML (the read+write dialect — `BillAdd`, `VendorQuery`, `BillQuery`, `TransactionQuery`); Web Connector (official remote bridge). REST "QBD APIs" (Conductor/Apideck/Unified.to) are third-party wrappers over the SDK, not Intuit endpoints.
2. **Windows-only:** QBXMLRP2/QBFC are Windows COM; Web Connector is a Windows program. No official path integrates with a `.QBW` from macOS. QBD-for-Mac exposes no SDK. → **Windows bridge mandatory.**
3. **qbXML:** synchronous XML request→response, batchable, version-tagged and backward compatible ("each QuickBooks release supports all earlier SDK versions"). Exact top qbXML version in SDK 17.0 — UNCERTAIN (~16.0); verify against SDK 17.0 OSR.
4. **Web Connector:** SOAP web service, **pull model, scheduled** — QuickBooks/QBWC calls *your* endpoint (`authenticate`/`sendRequestXML`/`receiveResponseXML`/`getLastError`/`closeConnection`) over HTTPS. Interactive runs need QuickBooks running + file open; **unattended** runs need "Allow this application to login automatically" (requires Admin password) and must be configured in **single-user** mode. Precise per-request multi-user write constraints — UNCERTAIN, verify per request type.
5. **Authorization:** a `.QWC` XML file (app name, SOAP AppURL, identifier) is imported into QBWC; on first import the **Admin user** approves an Application Certificate dialog and sets access level (incl. "even if QuickBooks is not running"). Local SDK apps get the same admin-approval prompt on first session.
6. **Post-2024 sunset:** **stop-sell, not shutdown** — new Pro Plus/Premier Plus/Mac Plus sales stopped after 2024-09-30 (US); existing subscribers keep renewing + updates; **Enterprise still sold.** SDK 17.0 supports QBD 2002+ (incl. 2023 R16+, 2024 R18+) + Enterprise. Developer platform fully supported. Separate annual service-discontinuation policy retires add-on live services (payroll/payments) on ~3-yr-old versions — not the local SDK. Verify current-year discontinuation dates at build time.
7. **Hosted (Rightworks) / RDP:** Web Connector supported and recommended (no custom install needed on the QB box); caveat — Rightworks stops background programs on disconnect, so scheduled runs need a kept-alive session or auto-login. Local SDK works on RDP/hosted only if you can install your app there (often disallowed) → Web Connector is the safer choice.
8. **`.QBW` safety (CONFIRMED):** supported integration **never** opens the `.QBW` directly — proprietary format, all access mediated by the running QuickBooks app via COM/Web Connector. No supported path parses/edits `.QBW` bytes → safe by construction. Session opened single/multi/don't-care mode; single-user (incl. auto-login) locks other users out for the run; some ops require single-user even in multi-user files.
9. **Read-back + idempotency:** `BillAdd` response returns server-generated **`TxnID`** + **`EditSequence`**; re-query by `TxnID` to confirm. `EditSequence` is an optimistic-concurrency token (stale modifies rejected). Each request carries a **`requestID`**; QuickBooks suppresses double-apply on retry — but durability window is UNCERTAIN, so **keep our own dedup ledger too** (matches existing no-double-post guarantee).
10. **Test target:** **no cloud sandbox** — test against a local **disposable/sample company file** (File→New Company, or a built-in QuickBooks sample company). Exact SDK sample `.qbw` filename UNCERTAIN, but scratch company files are standard and fully supported.

**Verify before locking:** (a) top qbXML version in SDK 17.0; (b) per-request multi-user write constraints for `BillAdd`; (c) `requestID` duplicate-suppression window; (d) current-year service-discontinuation dates for customers' QBD year-versions.

**Sources:** developer.intuit.com QBD SDK develop/get-started/api-reference; QBWC Programmer's Guide v2.0 PDF (static.developer.intuit.com); connections-sessions-and-authorizations; query + modify/delete/void docs (TxnID/EditSequence); stop-sell announcement (quickbooks.intuit.com/r/whats-new/quickbooks-desktop-stop-sell); Rightworks Web Connector help. Secondary corroboration: Conductor, Apideck.

---

## B. Xero

- **API:** Xero Accounting API, RESTful JSON, base `https://api.xero.com/api.xro/2.0`, versioned 2.0. No GraphQL; SOAP/OAuth1 removed. (CONFIRMED)
- **Auth:** OAuth 2.0 only; Auth-Code + **PKCE** (or client-credentials "Custom Connections"). Bearer + `Xero-tenant-id` header per call. Granular scopes; become default for new apps after **2026-03-02**. (CONFIRMED)
- **Bills/AP:** Bills = **Invoices with `Type="ACCPAY"`**. Create `POST /Invoices` with Contact + LineItems. DRAFT→SUBMITTED→AUTHORISED→PAID/VOIDED. (CONFIRMED)
- **Attachments:** `POST/PUT /Invoices/{id}/Attachments/{FileName}` (PDF/JPG/PNG); separate Files API. Per-file ~25MB (UNCERTAIN vs 3/10MB older refs); max count per object undocumented. (CONFIRMED mechanism)
- **Vendor:** **Contacts**; `IsSupplier`/`IsCustomer` are **READ-ONLY** — create a plain contact, Xero flips `IsSupplier=true` after an ACCPAY doc posts. (CONFIRMED)
- **Dimensions:** **Tracking Categories, max 2 active per org**, applied at line level (`LineItem.Tracking[]`). Flat 2-axis. (CONFIRMED)
- **Sandbox:** free **Demo Company** (auto-resets every **28 days**) + trial orgs via dev account. No permanent dedicated sandbox. (CONFIRMED)
- **Rate limits:** 60/min, 5,000/day per tenant; 5 concurrent; app-wide 10,000/min. 429 + `Retry-After`. (CONFIRMED)
- **Webhooks:** supported but narrow (Invoices + Contacts create/update; thin payload → GET full; HMAC-SHA256, ~5s ACK). Polling via `If-Modified-Since` + `UpdatedDateUTC`. (CONFIRMED; broader resource list UNCERTAIN)
- **Idempotency:** **`Idempotency-Key` header supported** (UUID ≤128 chars; replay returns original). Expiry window UNCERTAIN. (CONFIRMED)
- **Capabilities:** POs supported (API PO→Bill conversion weakly documented); multi-currency (paid); one app → many orgs, **PKCE apps cap at 25 tenant connections**.

## C. Sage Intacct

- **API:** **Two.** (a) **XML Web Services** (legacy SOAP-style; `readByQuery`/`create`/`create_bill`) — still supported, needed for objects REST doesn't yet cover (project accounting, some AP/attachment ops). (b) **REST (JSON, OAuth2)** — GA in **2025 R1 (Feb 2025)**, partial object coverage. (CONFIRMED)
- **Auth:** XML = **sender credentials** (`senderid`+pwd, from a Web Services developer license) **plus** company/user login or a **session ID** (`getAPISession`, tied to a returned endpoint). REST = OAuth 2.0 Bearer. (CONFIRMED)
- **Bills/AP:** **`APBILL`** header + **`APBILLITEM`** lines; `create_bill`. Fields: `VENDORID`, `WHENCREATED/POSTED/DUE`, `DOCNUMBER`, `TERMNAME`, `CURRENCY`, `SUPDOCID`. (CONFIRMED)
- **Attachments:** **supporting documents (supdoc)** — `create_supdoc` (base64), link via `SUPDOCID` on APBILL → **2-call flow**. REST attachment coverage lags → assume XML. (CONFIRMED)
- **Vendor:** **`VENDOR`** object, full read + create. (CONFIRMED)
- **Dimensions:** **dimension-native, richest of the four.** Standard (Location, Department, Class, Project, Employee, Item, Customer, Vendor) + module dims + **user-defined dimensions**. `LOCATIONID` **required when multi-entity enabled**; `TASKID`/`COSTTYPEID` require `PROJECTID`. (CONFIRMED)
- **Sandbox:** **no free self-serve trial** — needs Web Services developer license + portal registration + a **Sandbox company** (paid/entitled), realistically via partner/ISV program. Highest onboarding friction of the four. (CONFIRMED; exact entitlement mechanics UNCERTAIN)
- **Rate limits:** Performance-Tier concurrency pairs (app/company); Tier 1 ~100k txns/mo, 1 concurrent offline process; 429 on limit. Exact tier numbers not public. (CONFIRMED structure)
- **Webhooks:** legacy **Smart Events** + REST outbound webhooks; reads commonly poll `readByQuery` on `WHENMODIFIED`. (CONFIRMED; per-object REST parity UNCERTAIN)
- **Idempotency:** **no header.** XML `<function controlid=…>` + control-block **`uniqueid`** (default true) makes a request non-repeatable on resubmit; use GUIDs; `DOCNUMBER` uniqueness as a second guard. (CONFIRMED; DOCNUMBER default UNCERTAIN)
- **Capabilities:** native **multi-entity/multi-book** + consolidation; full procure-to-pay (POs, **3-way match**, item receipts); native multi-currency; multi-dimensional GL.

## D. Canonical-model deltas vs QuickBooks Online

- **AP object shape:** QBO distinct `Bill`; Xero **overloads Invoices via `Type=ACCPAY`** (model needs a type discriminator); Intacct dedicated `APBILL`/`APBILLITEM`. → canonical `Bill` abstraction.
- **Dimensions:** QBO Class+Location (limited); Xero ≤2 Tracking Categories (line-level); Intacct many standard + unlimited user-defined, GL-native. → **model dimensions as an extensible list, not fixed columns.**
- **Vendor:** QBO/Intacct explicit vendor entities set directly; **Xero has no separate supplier record** (`IsSupplier` read-only, derived from posting). → provisioning differs per adapter.
- **Multi-entity:** only Intacct is truly multi-entity; Xero/QBO per-org (route by tenant/realm).
- **Procure-to-pay depth:** Intacct (PO+item receipt+3-way) > QBO (PO, no receipt/match) > Xero (PO, weak API conversion).
- **Attachments linkage:** Xero per-invoice sub-resource; Intacct 2-step supdoc+`SUPDOCID`; QBO `Attachable`+`AttachableRef`.
- **Idempotency:** Xero header; QBO `RequestId` param; **Intacct controlid/uniqueid (no header)**; QBD `requestID`. → per-adapter strategy, app-side dedup ledger everywhere.
- **Sandbox friction:** Xero free (28-day reset) « QBO sandbox « **Intacct gated (license+partner)**. → sequence Xero before Sage in Phase 1B.

**Verify at build time:** Xero attachment size/count + idempotency retention + full webhook list; Intacct exact tier concurrency + REST attachment GA + DOCNUMBER default enforcement.

**Sources:** developer.xero.com (Accounting API overview, Invoices, Contacts, TrackingCategories, Attachments, Files, PurchaseOrders, OAuth2, Rate Limits, Idempotent requests, Webhooks, Development accounts); developer.intacct.com + developer.sage.com (XML Web Services, requests/controlid, APBILL, Vendors, create_supdoc, Dimensions, Smart Events, REST GA 2025 R1, REST get-started, OAuth2, concurrency tiers, XML↔REST object map, sandbox datasheet).
