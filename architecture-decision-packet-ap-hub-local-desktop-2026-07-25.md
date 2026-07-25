# Architecture Decision Packet — AP-Hub Local Desktop Application

**Date:** 2026-07-25 · **Verdict:** `READY_FOR_SPEC`
**Supersedes:** `architecture-decision-packet-ap-hub-multi-edition-accounting-intake-2026-07-24.md`, `architecture-decision-packet-ap-hub-northstar-ux-2026-07-14.md`
**Grounding evidence:** `docs/audits/architecture-map-2026-07-25.md` (full repo forensics, this date) · `specs/reference/ARCHITECTURE-ap-hub-platform.md` §2, §3, §4, §8, §10, §11, §12 · `specs/reference/provider-research-2026-07-17.md`

> This is a **resequencing and packaging** decision, not a rewrite. Approximately 85% of the
> existing engine is retained unchanged. Nothing in this packet authorises discarding working code.

---

## 1. Revised master architecture

AP-Hub is a **local-first desktop application** for small and medium businesses and their
bookkeepers. The entire application and its database live on the user's own computer. There is no
hosted AP-Hub application, no public AP-Hub URL, and no mandatory cloud service. The product
reaches the internet only for services the user knowingly connects.

```
┌──────────────────────────── User's computer ────────────────────────────┐
│                                                                          │
│  ┌──────────────────── AP-Hub Desktop (Electron) ────────────────────┐  │
│  │  Main process        │  Renderer (existing React tree)             │  │
│  │  · window + tray     │  · Today · Exceptions · Transactions        │  │
│  │  · lifecycle         │  · Statements · Settings · Audit            │  │
│  │  · supervisor        │  · Setup wizard (new)                       │  │
│  │  · IPC bridge ───────┼──► preload (contextIsolation, no Node)      │  │
│  └──────────┬───────────┴─────────────────────────────────────────────┘  │
│             │ spawns + supervises (child processes, never OS services)    │
│   ┌─────────┴──────────┬───────────────────────┐                         │
│   ▼                    ▼                       ▼                         │
│ AP-Hub engine     Bundled PostgreSQL     Discovery worker (new)          │
│ (existing src/)   (private, port 55432+)  · metadata-first scan          │
│ · 8-stage pipeline · invisible to user    · allow/deny enforcement       │
│ · pg-boss workers  · own data dir         · company-file + app detection │
│ · connectors                                                             │
│                                                                          │
│ Credential store: Windows Credential Manager / macOS Keychain            │
│ Logs: local rotating JSON. Telemetry: none by default.                   │
└──────────────────────────────────────────────────────────────────────────┘
        │ outbound only, user-authorised                    │ Windows only
        ▼                                                    ▼
  Gmail · QBO · Xero · Sage Intacct                  QuickBooks Desktop
  (provider login in system browser,                 via qbXML / Web Connector
   returns to the desktop app)                       on the QuickBooks machine
```

**Governing rule:** *Find first. Infer second. Ask only when AP-Hub cannot find or safely
determine the answer.*

---

## 2. Current state versus target state

| Component | Current state | Target state | Disposition |
|---|---|---|---|
| 8-stage AP pipeline | `src/pipeline/` — built, tested | Unchanged | **Retain** |
| Gmail intake | `src/gmail/`, `src/ingest/` — built | Unchanged | **Retain** |
| Document extraction | `src/extract/` + `mupdf` rasterization | Unchanged | **Retain** |
| Local-model detection | `src/llm/detect.ts` — probes Ollama/LM Studio/OpenAI-compatible | Surfaced in the wizard as "we found a local AI you can use" | **Retain + surface** |
| Canonical AP model | `src/canonical/`, `src/accounting/` | Unchanged | **Retain** |
| Connector contract | `src/connectors/types.ts` | Unchanged; two new implementations | **Retain** |
| QBO connector | `src/qbo/`, `src/connectors/qbo.ts` | Unchanged | **Retain** |
| QuickBooks Desktop | `src/qbdesktop/` ~1,800 lines qbXML/QBWC | Unchanged logic; new detection layer in front | **Retain** |
| Bank statements | `src/statements/` 866 lines | Unchanged | **Retain** |
| Gmail drafts | `src/gmail/drafts.ts` | Unchanged — the ordinary reply workflow | **Retain** |
| Tax / dimension handling | `src/mapping/` | Unchanged | **Retain** |
| Proof + approval controls | `src/swarmsync/`, posting gates | Retained; SwarmSync default OFF | **Retain, re-default** |
| Duplicate / wrong-company / read-back | posting contract, `src/qbdesktop/production.ts` | Unchanged | **Retain** |
| Audit trail | `src/audit.ts` | Unchanged | **Retain** |
| Owner / bookkeeper / CPA roles | `src/auth/`, services | Retained; owner = OS account holder | **Retain, re-anchor** |
| PostgreSQL migrations | `migrations/` 001–013 | Unchanged; runs against bundled PG | **Retain** |
| Credential storage | `src/host/windows.ts:176` Credential Manager | Plus macOS Keychain | **Retain + extend** |
| React screens | `app/(app)/**`, `app/components/`, `app/lib/` | Move into the Electron renderer | **Modify** |
| Next.js server shell | `next start -p 3000 -H 127.0.0.1` | Removed as the product surface | **Remove** |
| Google SSO product login | `app/login/page.tsx`, `src/auth/google-sso.ts` | Replaced by OS-account identity | **Remove** |
| Hosted key broker | `broker/` + `broker/render.yaml` | Removed; local credentials + user's own key or local model | **Remove** |
| Docker PostgreSQL | `compose.yaml` | Replaced by bundled private PG | **Remove** |
| 59 user-facing env vars | `.env.example` | Installer-managed local config; none user-facing | **Remove from UX** |
| Raw provider errors | `app/lib/onboardingErrors.ts:34` | Exhaustive plain-language mapping | **Modify** |
| Mandatory telemetry | `src/telemetry.ts` broker path | Local logs; opt-in redacted support export | **Modify** |
| Filesystem discovery | **Does not exist** (only `node:fs` uses in `src/` are the migration loader and two `mkdirSync`) | New subsystem | **Build** |
| Accounting-app / company-file detection | **Does not exist** | New subsystem | **Build** |
| Electron shell | **Does not exist** | New | **Build** |
| Bundled PostgreSQL | **Does not exist** | New | **Build** |
| macOS host adapter | `src/host/macos.ts` — stub | Real implementation | **Build** |
| Xero connector | `src/connectors/stubs.ts` — throws | Real implementation | **Build** |
| Sage Intacct connector | `src/connectors/stubs.ts` — throws | Real implementation | **Build** |
| Inference-first onboarding | **Does not exist** | New | **Build** |
| Signed installers + updates | `deploy/*.ps1` only | Windows signed installer, macOS signed + notarized | **Build** |

---

## 3. Electron shell design

**Decision: Electron.** Chosen over Tauri because the main process is Node — the same runtime the
engine already targets, so process supervision needs no new language toolchain. Cost accepted:
~120 MB installer.

### Migration size — measured, not assumed

The claim that the React tree moves without a rewrite was challenged and has now been verified
route by route. Full inventory: `docs/audits/electron-migration-inventory-2026-07-25.md`.

| Measurement | Value |
|---|---|
| Pages that are `'use client'` | **14 of 14** |
| Server components | **0** |
| Pages doing server-side data fetching | **0** |
| API route files | 52 |
| **Total lines across all 52 route files** | **528** (mean ~10 per file) |
| Renderer files performing network I/O | **2** — `app/lib/api.ts`, `app/lib/session.tsx:31` |

Every route file is the same thin delegation — `runRead(request, ctx => service(...))` — with
authentication, tenant scoping and RBAC living inside `runRead` / `runAction` / `runApprove` in
`src/services/**`, never in the route file. The routes contribute no business logic.

So the migration is: swap the transport in **2 files**, add **one** IPC dispatcher mapping channels
to the same `src/services/**` entry points, **delete** 528 lines of route files, and change
**0 of 14** page components. The 85% retained claim survives this check.

### Two approaches, and the per-route fallback

| Approach | What it does | Verdict |
|---|---|---|
| **A — Embedded Next** | Electron silently starts the existing Next.js server on a loopback port and loads it in the window. User never sees a browser or URL. | **Fallback.** Lowest risk, but keeps a listening socket and the HTTP auth surface it forces. |
| **B — IPC** | Replace route handlers with IPC channels calling the same services; static-export the renderer. | **Selected**, on the evidence above. |

The fallback is **per-route, not all-or-nothing**. If any route proves to hold logic outside
`src/services/**`, or any page proves to need server rendering, that specific screen loads via
approach A while the rest use B. A surprise cannot stall the phase, and the build must report any
route that takes the fallback rather than quietly widening scope.

| Layer | Responsibility | Security posture |
|---|---|---|
| Main process | Window + tray lifecycle; supervises engine, PostgreSQL and discovery worker; owns credential-store access; owns provider-login orchestration; auto-update | Node enabled. Never renders untrusted content. |
| Preload | The **only** bridge. Exposes a frozen, explicitly enumerated API via `contextBridge`. | `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` |
| Renderer | The existing React tree + the new setup wizard | No Node, no direct filesystem, no direct database, no arbitrary network. CSP forbids remote origins. |

**Window model:** one main window; the setup wizard is the first-run route inside it, not a separate
app. A tray icon shows engine status and provides Pause / Resume / Open / Quit. Closing the window
leaves the engine running in the tray; Quit stops all children.

**Provider login:** opened in the user's **system browser**, never in an embedded webview (embedded
provider login is both an Intuit/Google policy problem and a credential-phishing pattern). A
loopback listener on an ephemeral port receives the callback, then the browser tab shows a
"You can close this and return to AP-Hub" page while the desktop window is focused programmatically.

---

## 4. Internal transport: loopback versus IPC

**Decision: Electron IPC for the renderer; loopback HTTP retained only for provider OAuth callbacks
and the QuickBooks Web Connector.**

| Path | Transport | Why |
|---|---|---|
| Renderer → engine (all product operations) | **Electron IPC** via preload `contextBridge` | No listening socket, therefore no port to guess, no CSRF surface, no "is this request really from our UI" problem, and nothing another local process can reach. Removes the entire class of local-network attack that a loopback API invites. |
| Provider OAuth callback | **Loopback HTTP**, ephemeral port, single-use, 10-minute expiry | Google and Intuit desktop OAuth require a redirect URI. Unavoidable; already implemented in `specs/03_CHUNK_3_GMAIL.md`. Bound to `127.0.0.1`, exact-URI match, closed immediately after the exchange. |
| QuickBooks Web Connector | **Loopback HTTPS** on the QuickBooks machine | QBWC is a SOAP *pull* client; it must call an endpoint. Windows-only, local-only, never relayed. |
| Engine → PostgreSQL | Loopback TCP on a probed private port (55432+) | PostgreSQL has no other transport. Bound to loopback, password-protected, own data directory. |

**Justification for not using loopback HTTP as the main app transport:** a loopback API is reachable
by every other process running as that user, which forces an authentication scheme (the SID-bound
nonce session in `specs/02_CHUNK_2_AUTH.md`) to defend a door that IPC does not open at all. IPC is
strictly the smaller attack surface and removes a whole chunk of planned work.

**Consequence for in-flight work:** `specs/02_CHUNK_2_AUTH.md` (loopback session, bootstrap nonce,
CSRF, Origin validation) is **superseded**. Its SID-ownership and install-identity primitives are
retained; its HTTP session machinery is not built.

---

## 5. SwarmSync optional-consent design

SwarmSync proof verification is an **optional, independent second opinion** — not a product
dependency.

- Default: **OFF**. `src/config.ts:71` changes from `boolish(true)` to `boolish(false)`.
- A default install makes **zero** outbound calls to SwarmSync.
- The wizard asks exactly one plain-English question, phrased as a business choice:
  *"Would you like an independent check on invoices before they reach your books? This sends the
  invoice to an outside verification service. It is optional and off by default."*
- The proof-gating code, the fail-closed behavior, and the `proof_fail_safe` / `proof_gate_posting`
  tests are all **retained**.

### The three disabled/unavailable rules (binding)

Turning the feature off must never turn a gate into a fail-open path. Exactly three rules govern it,
and they are distinguished by the company's own policy setting, not by the service's availability:

1. **SwarmSync optional for this company (default).** Disabled or unavailable → the item continues
   through AP-Hub's own duplicate, wrong-company, arithmetic and read-back controls, which are
   unchanged. The stage returns `noop`. It is neither a pass nor a failure.
2. **SwarmSync required by this company's policy.** Disabled or unavailable → the item is sent to
   **review**, held, and a typed exception is raised. It never proceeds silently and it is never
   treated as verified. A policy that requires verification cannot be satisfied by the absence of it.
3. **Labelling.** The interface must never show "independently verified," a verification badge, or
   any equivalent claim on an item that was not actually scanned. An unscanned item shows
   "not independently checked" or nothing at all. A verification claim requires a stored proof
   reference for that specific item.

`proof_fail_safe` is extended with a case for rule 2 and a case for rule 3 so a future change cannot
quietly relabel unscanned work as verified.

---

## 6. Document understanding without asking the user for an API key

**The wizard must never ask "what is your API key?"** Most business owners do not have one and must
never be told to obtain one. Removing the hosted broker removed the answer that used to hide this
problem, so the product needs its own default.

**Decision: a three-tier extraction ladder, tried in order, with no configuration.**

| Tier | Method | Needs | Covers |
|---|---|---|---|
| **1 — Deterministic (always on, the default)** | Text-layer parsing via `mupdf` plus rule- and pattern-based field extraction, vendor matching against the discovered vendor list, and arithmetic validation | Nothing. No network, no key, no model. | Machine-generated PDF invoices and statements, which is the large majority of emailed accounting documents |
| **2 — Local AI (automatic when present)** | The already-built probe in `src/llm/detect.ts` finds Ollama, LM Studio, Jan, LocalAI or any OpenAI-compatible endpoint and uses it for vision extraction | A local runtime the user already has | Scanned and photographed documents, unusual layouts |
| **3 — Assisted cloud processing (explicit consent only)** | An AP-Hub-operated extraction endpoint, or the user's own provider key under Advanced | One plain-language consent screen | Anything tier 1 and 2 could not read confidently |

**Rules that bind the ladder**

1. Tier 1 runs first, always, and its result is used whenever confidence clears the threshold.
2. Tier 2 is selected silently when a local runtime is detected. The wizard states it as a finding —
   *"We found an AI assistant already on this computer and will use it. Nothing leaves your
   computer."* — never as a question with a technical answer.
3. Tier 3 is **never** reached without explicit consent, phrased as a business decision:
   *"Some documents are images rather than text. To read those, AP-Hub can send just that document
   to a secure processing service. Nothing else is sent. You can say no and review those documents
   yourself."*
4. **A document that no enabled tier can read confidently goes to review. It is never guessed at.**
   Low confidence is a review reason, not a silent estimate.
5. The user's own provider key is an **Advanced** setting only. It is never requested, never
   prompted for, and never blocks setup.
6. Whichever tier ran is recorded per document and shown in evidence, so the user can always see how
   a number was obtained.

**Consequence:** AP-Hub is fully functional on a computer with no AI of any kind, no key and no
network beyond the connected accounting systems. AI is an enhancement to coverage, never a
prerequisite for the product working.

---

## 7. Backup, recovery and repair

Because everything is local, a failed drive or a corrupted database would otherwise destroy the
user's entire AP history. This is a **P0 requirement**, not an afterthought.

| Capability | Design |
|---|---|
| Automatic local backup | Scheduled by the supervisor: nightly full plus a pre-migration and pre-update snapshot. Consistent PostgreSQL dump plus the document store, taken without stopping the engine |
| Encryption | Every backup encrypted at rest with a key held in the OS credential store. A backup file alone is useless without the key |
| Rotation | Daily kept 7, weekly kept 4, monthly kept 3, plus every pre-update snapshot until the next successful update. Oldest pruned only after a newer backup verifies |
| Verification | Every backup is verified immediately after creation by re-reading it and checking a manifest hash and row counts. **An unverified backup is reported as failed, never counted** |
| One-click restore | Settings → Restore lists verified backups in plain language ("Yesterday, 2:15 AM — 428 invoices"). Restoring is a single confirmation and shows progress |
| Repair mode | Reinstalls program components and rebuilds indexes and derived state **without touching user data**. Reachable from the installer and from the tray when the app will not start |
| Exportable backup | A single encrypted file the user can copy anywhere, with a plain-language explanation of what it contains and that the key is required |
| Optional external copy | The user may nominate a folder — OneDrive, Google Drive, Dropbox, a network share or an external drive. AP-Hub copies the encrypted backup there. **User-selected, never automatic, never a hosted AP-Hub location** |
| Recovery testing | Part of clean-machine certification (§18): back up, destroy the data directory, restore, and prove the restored install matches — counts, audit trail and postings intact |
| Failure surfacing | A failed or unverified backup raises a visible plain-language warning. Silent backup failure is the failure mode this design exists to prevent |

Restore and repair never require the user to know where anything is stored.

---

## 8. Update delivery

The packet's "no hosted AP-Hub service" rule and signed automatic updates appear to conflict. They
do not, once three distinct things are separated:

| Thing | Present? |
|---|---|
| A hosted AP-Hub **application** | **No** |
| A public AP-Hub **user interface** or URL the user visits | **No** |
| An **invisible static endpoint** serving a signed update manifest and installer | **Yes, and it is the only one** |

**Decision: signed updates from a static endpoint, checked with consent, installed only on the
user's confirmation — with a fully manual path always available.**

- The endpoint is a static file host. It serves a signed manifest and signed installers. It holds no
  user data, has no user interface, accepts no user input, and receives no telemetry. The request
  carries the current version and platform, and nothing else.
- The wizard asks once, as a business decision: *"Should AP-Hub check for updates automatically?"*
  Declining is fully supported and disables all outbound update traffic permanently.
- Update signatures are verified before installation. A signature that does not verify is refused,
  and the installed version is left untouched.
- A pre-update backup snapshot (§7) is taken before every update, and a failed update rolls back to
  the previous version with data intact.
- **Manual path:** the user downloads the next installer and runs it. This is always available and
  is the only path when automatic checking is declined.

---

## 9. Multi-user and multi-machine scope — stated honestly

**Decision: the first release is one computer, one operating-system account, one AP-Hub install —
and that install handles many companies.**

| Question | Answer for v1 |
|---|---|
| Who is the owner? | The OS account holder who installed it |
| Can one install manage several businesses? | **Yes.** Tenancy already exists in the schema; a bookkeeper with twelve clients runs one install with twelve companies. This is the bookkeeper persona, and it is fully supported |
| Owner and bookkeeper on the same computer, same OS account | Supported — they share the install, and the existing owner / bookkeeper / CPA roles govern what each may do within it |
| Owner and bookkeeper with separate OS accounts on one computer | **Each gets a separate install with its own database and its own credentials.** They do not share data. This is a consequence of OS-account identity and is stated plainly in the product |
| Two people using one AP-Hub database at the same time from different accounts | **Out of scope for v1** |
| Remote bookkeeper access to someone else's install | **Out of scope for v1** |
| Cross-machine anything | **Only** the Mac ↔ Windows QuickBooks Desktop bridge (§11), which carries accounting requests, never the AP-Hub database |

The three roles are retained and enforced now, both because they already work and because they are
what a later shared-install phase will build on. Where a limit exists, the product says so in plain
language rather than failing confusingly — for example, a second OS account opening AP-Hub is told
it has its own separate AP-Hub, not shown an empty database with no explanation.

---

## 10. Locked forwarder — purpose, and its carve-out

### What it actually is, in plain English

QuickBooks Online gives every company a private email address that turns forwarded invoices into
draft transactions automatically. Forwarding to that address blindly is dangerous: a fraudulent or
tampered invoice would be captured straight into the books with no check.

The locked forwarder is the **safety valve in front of that address**. When enabled, AP-Hub scans
every invoice attachment first. If the scan is clean it forwards the original email — exactly once —
to that one pre-configured QuickBooks capture address. If the scan finds a critical or high-severity
problem, or the attachment cannot be scanned, or the scanning service is unreachable, it does **not**
forward: it holds the message, records a typed exception, and alerts the owner
(`src/gatekeeper/gatekeep.ts:98-140`).

The recipient is a machine address belonging to the user's own QuickBooks company. It is not a
person, not a vendor, and cannot be changed by a caller: `createLockedForwarder` binds the address
at construction, `forward(messageId)` takes **no recipient parameter**, and the result is
re-checked against the configured address before returning
(`src/gatekeeper/forwarder.ts:26-45`).

### Why it is distinct from the ordinary reply workflow

| | Create Gmail draft | Use locked forwarder |
|---|---|---|
| Purpose | Ask a vendor or colleague a question | Feed a screened invoice into QuickBooks' own capture inbox |
| Recipient | Chosen by the human, in Gmail | One pre-configured QuickBooks address, fixed in config |
| Who sends | **The human**, from Gmail | AP-Hub, after a passing fraud scan |
| Content | A message the human writes | The original invoice email, unaltered |
| Default | On — this is the normal workflow | **Off** |
| Visibility | Main product surface | Advanced / Security settings only |

### Current standing and decision

It has a clear legitimate use, but in this product it is **redundant with direct API posting** —
AP-Hub already writes to QuickBooks through `src/qbo/write.ts`, so the email-capture route is an
alternative ingestion path, not a necessary one. It is also doubly inert under the new defaults:
`GATEKEEPER_ENABLED` is already `false` (`src/config.ts:84`) and the stage additionally returns
`noop` when SwarmSync is off (`src/pipeline/gatekeep.ts:17`), which is now the default.

**Decision: retain, disabled, documented, and marked for a later product decision.** It does not
interfere with the main build. Requirements that bind it:

1. Default disabled; never enabled by the installation wizard.
2. Never shown in the basic wizard; appears only under Advanced → Security.
3. Settings copy states exactly what it forwards, to whom, under what conditions, and why.
4. Bound to one owner-approved recipient; no caller or user-entered payload may change it.
5. Owner-only enablement.
6. Complete audit logging retained (`gatekeep.forward`, `gatekeep.hold`).
7. The UI must visibly distinguish *Create Gmail draft* from *Use locked forwarder*.
8. The guarantee is preserved unless the owner explicitly removes it later.

### Carve-out language for every no-send test and specification

> AP-Hub has no general email-sending capability. Exactly one call site may invoke a provider send
> API: `sendForward` in `src/gmail/adapter.ts`, reachable only through `createLockedForwarder` in
> `src/gatekeeper/forwarder.ts`, which binds a single configured recipient at construction and
> accepts no recipient parameter. Any other call to `messages.send`, `drafts.send`, or an equivalent
> transport, and any code path that accepts a caller-supplied recipient, is a defect. Automated
> scans must assert **exactly one** allowed occurrence at that named location, not zero.

---

## 11. Windows and macOS platform design

One product, one shared core, thin platform adapters behind `src/host/types.ts`.

| Concern | Windows | macOS |
|---|---|---|
| Credential storage | Credential Manager (`src/host/windows.ts:176`, built) | Keychain via `security` / Keychain Services |
| Autostart + supervision | Per-user Task Scheduler + watchdog | LaunchAgent in `~/Library/LaunchAgents` |
| Install root | `%LOCALAPPDATA%\APHub` | `~/Library/Application Support/APHub` |
| Installer | Signed `.exe` (NSIS/Squirrel), non-admin | Signed + **notarized** `.dmg`/`.pkg` |
| File permissions | NTFS ACLs, current user | POSIX + **TCC privacy prompts** (Documents, Desktop, Downloads, cloud folders) — a denial is a resolvable user state, not a crash |
| File discovery | Registry probes + drive walk | Spotlight metadata + `~` walk |
| QuickBooks Desktop | qbXML / Web Connector bridge | **Not available — no Intuit mechanism exists** |
| Updates | Signed auto-update | Signed + notarized auto-update |

**QuickBooks Desktop on a Mac household.** A Mac bookkeeper runs the AP-Hub desktop app on macOS and
connects to a QuickBooks Desktop bridge running on the authorized Windows machine that holds the
company file. The bridge is a Windows-side component; the Mac app talks to it over the local network
with an owner-approved pairing. This is stated as an explicit product capability, not a workaround,
and it is the only cross-machine path in the product.

**Sequencing.** Windows is packaged and validated first. macOS adapters are implemented and compiled
in the same phases — never stubbed and deferred — and macOS validation follows Windows validation.
Linux is out of scope.

---

## 12. Automatic discovery architecture

Implements `specs/reference/ARCHITECTURE-ap-hub-platform.md` §8, which already establishes the
threat model. Runs in a **separate child process** so a hostile file cannot reach the engine or the
credential store, and so the user can cancel a scan instantly.

**Pipeline:** suggest locations → user approves or removes → metadata-first pass → filter → preview
→ explicit approval → content read → monitor approved folders only.

| Stage | Rule |
|---|---|
| Suggest | Documents, Downloads, Desktop, detected accounting/company folders, OneDrive, Google Drive for Desktop, Dropbox, SharePoint-synced, selected network drives, QuickBooks company-file locations, prior AP exports |
| Consent | Every suggested location is shown and removable. Nothing outside the approved set is ever touched. |
| Deny (absolute) | OS and app-install directories, browser profiles, credential and password stores, photo/music/video libraries, hidden and system directories, temp, Recycle Bin/Trash, other user profiles, unapproved network and removable drives |
| Metadata first | Names, sizes, types, timestamps only. No content is opened in this pass. |
| Filter | PDF, common image types, and defined accounting document types only |
| Safety | Max file size; ZIP handling with ratio, depth and total-size limits; symlink/junction loop detection with a visited-inode set and depth cap; scan-on-import hook with quarantine |
| Cloud placeholders | Detect OneDrive / Drive "online-only" files; never force-hydrate without consent; handle hydration failure gracefully |
| Network drives | Timeout and degrade gracefully; never block the pipeline |
| Duplicates | Content hashing to avoid re-importing the same document |
| Transparency | Visible progress, pause and cancel, and a user-readable log of every location inspected |
| Immutability | Source files are never modified, renamed, moved or deleted without separate explicit permission |

**Accounting-application detection (Windows):** registry probes for installed QuickBooks Desktop
editions and versions; company-file discovery by extension and known locations; QuickBooks Online
and Xero presence inferred from Gmail (provider notification mail) and from discovered exports.

**Inference layer.** From discovered documents, prior exports, AP spreadsheets and the connected
accounting system, AP-Hub derives company names and likely entities, vendor lists and aliases, chart
of accounts, classes/locations/departments/projects, historical coding patterns, payment terms and
approval history. Every inference carries a confidence value and a source citation, is presented as
"here is what we found — correct anything wrong," and is never silently applied to a posting.

---

## 13. Installation wizard flow

One downloaded package installs the desktop app, the engine, the private PostgreSQL, the supervisor,
the workers, the connectors, the document components, the migrations, the credential store, the
startup and recovery components, and the uninstaller/repair tools. The user is never told those
pieces exist.

| Screen | Shows | Asks |
|---|---|---|
| 1 · Welcome | What AP-Hub will do, in one sentence | **Get Started** |
| 2 · Permission to search | Plain-language explanation; recommended locations pre-selected; every one removable; explicit "we will not change or delete anything" | Approve or edit the location list |
| 3 · Discovery | Live progress, current area in plain words, pause and cancel | Nothing |
| 4 · What we found | Editions, company files, document counts, folders, spreadsheets, vendor lists, detected local AI | Confirm or correct the businesses |
| 5 · Connect accounts | Large buttons for **detected** systems first, then "Choose another system"; provider login opens in the system browser and returns to the app | Which systems to connect |
| 6 · Business rules | Everything inferable is pre-filled with its source shown | Only the genuinely undeterminable: approval threshold, drafts-only versus prepare-for-posting, ambiguous folder ownership, vendor-identity merges, unusual tax treatment, optional SwarmSync verification |
| 7 · Safe start | "AP-Hub will prepare everything for review and will not post anything automatically yet." | Acknowledge |
| 8 · Ready | Email connected · Accounting connected · Documents discovered · Companies identified · Initial scan running · Items needing review | Opens the app |

**Never asked:** database, hosting, runtime, port, API, OAuth, key, environment-variable or
architecture questions.

**Every question must fail all five tests before it may be asked:** Can AP-Hub find it on the
computer? In Gmail? In the accounting system? Infer it from prior behavior? Offer a safe default?

---

## 14. Local / cloud data boundary

| Data | Location | Leaves the computer? |
|---|---|---|
| Invoices, statements, extracted fields | Local PostgreSQL + local file store | No |
| Vendors, chart of accounts, mappings, coding history | Local PostgreSQL | No |
| Proposals, approvals, postings, audit trail | Local PostgreSQL | No |
| Discovery index and access log | Local PostgreSQL | No |
| Provider tokens | Credential Manager / Keychain | No |
| Operational logs | Local rotating JSON | Only via explicit, redacted support export |
| Email content | Gmail (read) + local copies | To Google only, already the user's own account |
| Accounting writes | — | To the accounting system the user connected |
| Document text (extraction tier 1) | Parsed locally by `mupdf` | **No — never.** Works with no network at all |
| Document images (extraction tier 2) | Local AI runtime on the same computer | **No** |
| Document images (extraction tier 3) | Only the document that tiers 1 and 2 could not read | **Only with explicit consent**, and only that document. Declining is fully supported |
| Encrypted backups | Local backup directory | **Only** to a folder the user nominates (OneDrive, Drive, Dropbox, network share, external drive). Never to an AP-Hub location |
| Backup encryption key | OS credential store | **No** |
| SwarmSync verification | — | Only if explicitly enabled; off by default |
| Update check | Static signed-manifest endpoint | **Only if the user enabled automatic checking.** Sends current version and platform only — no user data, no identifier |
| Telemetry | — | **Never by default.** No mandatory telemetry exists. |

---

## 15. Components retained, modified, built, removed

**Retained unchanged (~85% of the engine):** 8-stage pipeline · Gmail intake · extraction ·
local-model detection · canonical AP model · proof and approval controls · tax and dimension
handling · bank-statement workflows · Gmail drafts · QBO connector · QuickBooks Desktop
qbXML/Web Connector · provider-neutral connector contract · PostgreSQL migrations · owner and
bookkeeper roles · duplicate protection · wrong-company protection · authoritative read-back ·
audit trail.

**Modified:** React screens move into the Electron renderer · session becomes OS-account identity ·
SwarmSync re-defaults to off · error surfacing becomes exhaustive plain language · telemetry becomes
local-only · configuration becomes installer-managed.

**Built:** filesystem discovery · accounting-application and company-file detection · Electron
shell · bundled invisible PostgreSQL · **encrypted backup, verification, rotation, one-click restore
and repair mode** · **deterministic extraction tier 1 and the consent-gated extraction ladder** ·
**signed update delivery with a manual path** · macOS host adapters · Xero connector · Sage Intacct
connector · inference-first onboarding · one-click signed installers · clean-machine install and
recovery testing.

**Removed:** hosted Render key broker · public AP-Hub URL · browser-based product use · Google SSO
as the front door · Docker PostgreSQL · user-facing environment variables · raw provider errors ·
mandatory telemetry.

---

## 16. Phases and implementation order

| Phase | Delivers | Exit criteria |
|---|---|---|
| **P1 — Desktop shell + invisible database + backup** | Electron main/preload/renderer; existing React tree served from the renderer; IPC replaces HTTP for product operations; bundled PostgreSQL as a supervised child on a probed port; OS-account identity replaces SSO; broker, Docker and user-facing env vars removed; plain-language error mapping; **encrypted backup, verification, rotation, one-click restore and repair mode (§7)** | App launches from an icon on Windows and macOS with no browser, no port, no env var; `npm run verify` green; no `BROKER_` reference remains; **destroy-and-restore drill passes with counts, audit trail and postings intact** |
| **P2 — Discovery + detection + deterministic extraction** | Discovery worker with allow/deny, metadata-first, ZIP/symlink/placeholder safety, progress, pause, cancel, access log; QuickBooks Desktop edition and company-file detection; document classification; **extraction tier 1 — deterministic text-layer parsing with confidence gating (§6)** | On a seeded test profile, discovery finds the planted set, touches nothing denied, modifies no source file, and the access log matches what was inspected; **a text-layer invoice extracts correctly with no AI and no network** |
| **P3 — Inference + wizard + extraction ladder** | Inference of companies, vendors, accounts, dimensions, terms, coding patterns with confidence and source; the eight wizard screens; the five-test question gate; safe review-only start; **extraction tiers 2 and 3 with consent copy (§6)** | A nontechnical tester completes setup unaided; every question asked provably fails all five tests; **the wizard never displays the words API, key, token or model, and setup completes on a machine with no AI and no network beyond the connected providers** |
| **P4 — Providers + platform completion** | Xero and Sage Intacct against the existing connector contract; macOS host adapters exercised on real hardware; Mac ↔ Windows QuickBooks Desktop bridge pairing; signed Windows installer, signed and notarized macOS installer; update delivery | **Three cloud providers (QBO, Xero, Sage Intacct) plus the QuickBooks Desktop bridge** all pass the same connector contract suite; clean-machine install passes on both platforms; QBD bridge pairs from a Mac |

**Do-not-cross lines for all phases:** production accounting writes stay disabled by default and
behind the owner gate · no unrestricted filesystem scanning · no existing safety test weakened ·
every provider, proof and read-back path fails closed · no telemetry without explicit opt-in ·
bundled PostgreSQL isolated from any existing local PostgreSQL.

---

## 17. Acceptance tests for a nontechnical business owner

Performed by a tester who has never seen the product and is told nothing beyond "set this up."

1. Downloads one file, double-clicks, and reaches Screen 1 without reading documentation.
2. Never sees the words OAuth, API, key, token, port, environment variable, migration, worker, model, JSON, or a stack trace.
3. Is never asked where PostgreSQL should live, which port to use, which extraction model to run, or for an API key of any kind.
3a. Completes the entire setup on a computer with **no AI installed and no API key**, and successfully extracts a text-layer invoice.
3b. Is told, in one plain sentence, that AP-Hub backs itself up — and can restore from Settings without knowing where anything is stored.
4. Reaches Screen 4 and sees their real QuickBooks edition, company files and document counts.
5. Connects Gmail and one accounting system; each provider login opens in the system browser and returns them to the app automatically.
6. Answers only business questions; each question, when audited, provably fails all five discovery tests.
7. Finishes in review-only mode and is told, in plain words, that nothing will be posted automatically.
8. Disconnects the network mid-setup and receives a plain-language message with a specific next action, not an error code.
9. Restarts the computer; AP-Hub returns on its own with its work intact.
10. Uninstalls cleanly, and is asked explicitly what should happen to their data.

---

## 18. Clean-machine installation test plan

| Check | Windows | macOS |
|---|---|---|
| Install as a standard, non-admin user | Required | Required |
| No pre-installed Node, PostgreSQL, Docker or Git present | Required | Required |
| Installer signature accepted; SmartScreen / Gatekeeper friction recorded | SmartScreen | Gatekeeper + notarization |
| App launches from the icon; no browser opens except provider login | Required | Required |
| No listening socket other than loopback OAuth and QBWC | `Get-NetTCPConnection` | `lsof -i` |
| Bundled PostgreSQL does not collide with an existing instance on 5432 | Required | Required |
| Privacy prompts handled as resolvable states | n/a | TCC for Documents / Desktop / Downloads |
| Reboot recovery: app returns with jobs intact | Task Scheduler | LaunchAgent |
| Kill each child process; supervisor restores within 90 seconds | Required | Required |
| Crash loop stops after 5 failures in 10 minutes with a plain-language message | Required | Required |
| Secrets absent from disk, logs, command lines and browser storage | Required | Required |
| Extraction works with no AI runtime and no API key present | Required | Required |
| Backup runs, verifies, and reports failure visibly if corrupted | Required | Required |
| **Destroy-and-restore drill**: back up → delete the data directory → restore → counts, audit trail and postings all match | Required | Required |
| Restore from a user-nominated external folder | Required | Required |
| Update signature refused when tampered; previous version left intact | Required | Required |
| Second OS account gets its own install with a plain-language explanation | Required | Required |
| Uninstall removes components; data removal is an explicit user choice | Required | Required |
| Repair reinstalls components without touching user data | Required | Required |

---

## 19. Updated risk register

| Risk | Evidence | Impact | Mitigation | Priority |
|---|---|---|---|---|
| **Local-only storage destroyed by a drive or database failure** | Everything lives on one computer by design | **Total loss of the user's AP history** | §7 — encrypted automatic backup, verification before rotation, one-click restore, repair mode, optional user-selected external copy, destroy-and-restore drill in certification | **P0** |
| **Setup dead-ends on a user with no AI and no API key** | Broker removal left key custody unanswered; most owners have neither | Product unusable for the target audience | §6 — deterministic tier 1 works with no AI, no key and no network; the wizard never asks for a key; low confidence routes to review, never a guess | **P0** |
| Discovery reads something private | New subsystem, broad by nature | Trust loss; potential PII exposure | Absolute denylist; metadata-first; explicit per-location consent; visible access log; separate worker process | **P0** |
| Malicious document reaches the engine | Discovery ingests arbitrary local files | Code execution | Separate child process; type allowlist; size caps; ZIP ratio/depth/total limits; symlink loop detection; scan-on-import with quarantine | **P0** |
| No-send scan finds the locked forwarder and deletes it | `src/gmail/adapter.ts:142`, `app/api/replies/[id]/send/route.ts` | Loss of a documented safety control | §6 carve-out: scans assert exactly one allowed site, not zero | **P0** |
| Bundled PostgreSQL collides with an existing install | New component | Data confusion or startup failure | Probe from 55432 upward; private data directory; never touch 5432 | P1 |
| Electron renderer given too much power | New shell | Local compromise becomes total | `contextIsolation`, `sandbox`, no `nodeIntegration`, frozen preload API, CSP without remote origins | P1 |
| macOS deferred in practice despite the decision | Historical pattern in this repo | A future rewrite, exactly what was ruled out | macOS adapters implemented in the same phase as Windows, never stubbed | P1 |
| Inference silently miscodes transactions | New layer | Wrong books | Confidence + source on every inference; review-only start; nothing auto-applied to a posting | P1 |
| Provider login in an embedded webview | Implementation shortcut | Policy violation; phishing pattern | System browser only; loopback callback; enforced by review | P1 |
| Green E2E cannot detect integration failure | All 24 tests stub `/api/**` (`e2e/app.spec.ts:97-226`) | False confidence | Retain as UI contract; add a live-integration tier against disposable accounts | P1 |
| Work lost — nothing pushed | `git status -sb` → ahead 3, 19 uncommitted | Total loss of CHUNK_1 and all specs | Commit and push before further building | P1 |
| Cross-machine QBD bridge widens the attack surface | Mac ↔ Windows pairing | Unauthorised accounting writes | Owner-approved pairing; local network only; company-identity verification per request; fail closed | P1 |
| Backup fails silently and is only discovered during a real restore | The classic backup failure mode | Believed-safe data is unrecoverable | Verify every backup by re-reading it; never prune until a newer one verifies; surface failure as a visible plain-language warning | P1 |
| Tier-3 cloud extraction used without the user understanding it | New consent surface | Documents leave the computer unexpectedly | Explicit consent naming exactly what is sent; per-document tier recorded and shown in evidence; declining is fully supported | P1 |
| Update endpoint drifts into a hosted service | Scope creep | Contradicts the no-hosted-service rule | §8 — static files only, no user data, no input, no telemetry; automatic checking is optional; manual install always available | P1 |
| Second OS account sees an empty database and assumes data loss | Consequence of OS-account identity | Support burden, mistrust | §9 — explicitly explained in plain language at first launch, not left to inference | P2 |
| SwarmSync-required item quietly proceeds while the service is off | Optional-by-default change | An unverified item treated as verified | §5 rule 2 sends it to review; rule 3 forbids the verified label; both covered by `proof_fail_safe` | P1 |

---

## 20. Alternatives considered

| Alternative | Rejected because |
|---|---|
| Tauri instead of Electron | Smaller bundle, but adds a Rust toolchain and sidecar plumbing for a Node engine that already exists. Bundle size is not a constraint for this audience. |
| Tray icon opening the existing localhost UI | Cheapest by far, but the user still lands in a browser tab at an address — precisely what the product direction rules out. |
| Loopback HTTP as the main renderer transport | Reachable by every other local process, so it must invent an authentication scheme to defend a door IPC never opens. |
| SQLite instead of PostgreSQL | Existing tests and guarantees rely on PostgreSQL behavior; rewriting would break tested logic for an install-simplicity gain that bundling already delivers. |
| Keeping the hosted broker for key custody | Contradicts "no public AP-Hub URL" and ships telemetry off-machine; the local credential store and local-model detection already solve the problem it was built for. |

---

## 21. Documents reconciled by this packet

| Document | Action |
|---|---|
| `CLAUDE.md` | Rewrite: guarantees restated against actual code; add the §6 forwarder carve-out; remove deleted chunk numbering |
| `.ralph/guardrails.md` | Replace "DO NOT BUILD: Gmail send capability" with the §6 carve-out; add discovery-safety guardrails |
| `.ralph/state.md`, `IMPLEMENTATION_PLAN.md` | Reset to the P1–P4 plan; record which `cbv-loc001` commits are retained |
| `specs/SPEC-windows-local-only-runtime.md` + `specs/01–07_CHUNK_*.md` | Archive — superseded. CHUNK_1 (credentials) and CHUNK_6 (watchdog/install) content is carried forward; CHUNK_2 (loopback HTTP session) is dropped per §4 |
| `specs/reference/**` | Retained — this packet builds on it |
| `broker/`, `compose.yaml`, `ralph-*/`, built `SPEC-*.md` | Archive |
