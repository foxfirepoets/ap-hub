# DEVIATIONS.md — functionally-correct departures from literal spec text

These three items differ from the literal wording of the spec but are functionally
correct and intentional. They are documented here so future audits do not re-flag
them as defects.

## 1. Migration 006 — blue-green rename instead of in-place `ALTER TABLE ... RENAME COLUMN`

Spec implies a literal in-place column rename on `postings`. Instead, migration 006
renames the base table `postings -> postings_ap` and exposes an updatable back-compat
`VIEW postings`.

**Reason:** an in-place rename would break the immutable `test/read.test.ts` (which
INSERTs the old column names) and the `resetTables` TRUNCATE. The blue-green swap renames
the physical columns to the provider-neutral names while every existing query and test
keeps working. DOWN fully reverses the change; UP -> DOWN -> UP was verified clean.

## 2. `src/pipeline/posting.ts` `recordPosting()` — SQL identifiers changed, not logic

The spec's "logic explicitly NOT changed" list names `posting.ts`. Its INSERT target was
repointed `postings -> postings_ap` with the new provider-neutral column names.

**Reason:** this is a mechanical SQL-identifier change forced by deviation #1, NOT a
behavioral change. Idempotency and upsert semantics are identical, and
`test/posting.test.ts` is unmodified and green. Clarification: the SQL identifiers in
`posting.ts` changed; its logic did not.

## 3. `scripts/lint-noleak.mjs` — scoped `qbo` ban, not repo-wide

The literal spec bullet reads as a repo-wide ban on the QBO term `qbo`. The linter does
NOT ban `qbo` in the pre-existing QBO reference implementation (`src/qbo/**`) or legacy
core; it DOES strictly ban `qbo` in `src/canonical/**`, and bans non-QBO provider and OS
tokens in core.

**Reason:** a repo-wide `qbo` ban would require rewriting tested QBO reference code, which
is out of scope for an interface extraction. This carve-out means a green `lint:noleak`
should not be read as satisfying the literal repo-wide spec bullet — the scoped ban is the
intended behavior.

## 4. CHUNK_1 — the renderer static export is executed in CHUNK_3, not CHUNK_1

`IMPLEMENTATION_PLAN.md` places "static-export the existing React tree into the renderer and
load it" in CHUNK_1 task 3. It is executed in CHUNK_3 instead. CHUNK_1 ships the shell loading
its own plain-language boot page (`desktop/boot.html`), which is also the `DB_STARTING` surface
the happy path calls for.

**Reason:** `next build` with `output: 'export'` refuses to run while `app/api/**` exists —
Next.js does not support route handlers in a static export. Those 52 route files are deleted by
CHUNK_3, which is the chunk that replaces them with IPC. Attempting the export in CHUNK_1 would
require deleting the routes in CHUNK_1, which *is* CHUNK_3's work, and would move the
cross-tenant/RBAC replay earlier than the chunk that owns it.

This is a sequencing correction, not a dropped requirement. The spec's own CHUNK_1 exit
criterion (§18) is *"an empty window opens from an icon and `window.require` is undefined"* —
which is met and proved by `e2e-desktop/shell.spec.ts`. The plan task is more ambitious than
the spec's exit criterion, and the spec governs.

**Open at CHUNK_3:** three dynamic page routes (`statements/[id]`, `transactions/[id]`,
`settings/tax-mapping/[id]`) take runtime ids that `generateStaticParams` cannot enumerate.
They are the leading candidates for the per-route embedded-Next fallback (packet §3) and must
be reported explicitly there, whichever way they resolve.

## 5. CHUNK_3 — the static export costs 13 lines in 3 page components, and there are 54 route handlers, not 52

Two findings from the throwaway spike on `spike/static-export` (commit `2194f92`, not merged —
the knowledge is the product, not the code). Recorded here because
`specs/03_CHUNK_3_IPC.md` says silent scope widening is a failure.

### 5a. Acceptance criterion "Zero page components are changed (14 of 14)" cannot be met

`specs/03_CHUNK_3_IPC.md` requires zero page-component changes. That is **not achievable**, and
the reason is a Next.js property, not a shortcut:

Three page routes take runtime database ids — `statements/[id]`, `transactions/[id]`,
`settings/tax-mapping/[id]`. All three are `'use client'` pages that read the id with
`useParams()`. Under `output: 'export'` a dynamic segment must be enumerated by
`generateStaticParams`, and **the enumerated value is baked in: `useParams()` returns the
build-time sentinel, not the runtime id.** Proven live in a real browser against the real
exported artifacts: `/statements/999123` yielded `useParams id = sentinel` while
`window.location.pathname` held the true `/statements/999123`.

Options tested empirically, not reasoned about:

| Option | Result |
|---|---|
| A — sentinel `generateStaticParams` + read id from `window.location` | works; 0 link changes |
| B — query-param routes (`/transactions/detail?id=…`) | works, but rewrites 3 pages **and 5 link call sites** |
| C — catch-all `[...slug]` | same baking limitation as A, plus structural complexity |

**Decision: option A, in its `layout.tsx` variant.** `generateStaticParams` can be exported from
a `layout.tsx` rather than forcing each page into a server wrapper with its body forked into a
new `PageClient.tsx`. Measured against `53c4d9b`:

- 3 new files, 10 lines each: `app/(app)/{statements,transactions,settings/tax-mapping}/[id]/layout.tsx`
- 3 existing pages changed **+5/-1, +6/-1, +5/-1** — 13 insertions, 3 deletions total. Every
  other line (imports, JSX, handlers, helpers) byte-identical. The only semantic change is the
  id read.
- **Zero** `href` / `router.push` call sites change: the URL shape stays exactly as it is today.
- **Zero** security relaxation. Interception is on the built-in `file:` protocol, so
  `isAllowedNavigation` (`desktop/channels.ts:79-86`, which only accepts `protocol === 'file:'`),
  `contextIsolation`, `sandbox`, `nodeIntegration` and the CSP are all untouched.
- The existing `(app)` layout chain and `SessionGuard` still compose correctly (verified: one
  `nav`, one `#main-content`, `/api/me` resolves, no redirect to `/login`, no hydration warning).

The rejected alternative for the record: the server-wrapper split reaches the same outcome with
386 deletions and three new 80–170-line files. Same behaviour, far worse reviewability.

**Still open — `[UNVERIFIED in real Electron]`:** the `file://` path interception that serves the
exported sentinel HTML for an arbitrary `/statements/<id>` path is **not yet built**.
`desktop/main.ts` currently does a single fixed `win.loadFile(rendererEntry())` with no protocol
interception. The client-hydration half — the part actually in question — was proved through an
HTTP stand-in serving the identical exported artifacts, which is protocol-agnostic browser
behaviour. The Electron wiring must still be built and proved end-to-end under a real Electron
process before CHUNK_3 closes.

### 5b. There are 54 route handlers, not 52

`app/api/**` holds 52, and the inventory in `docs/build/route-to-service-map.md` and
`docs/audits/electron-migration-inventory-2026-07-25.md` counts only those. Two more exist
outside that tree and **also** block `output: 'export'`
(`Route ... couldn't be rendered statically because it used request.url`):

- `app/oauth/gmail/callback/route.ts`
- `app/oauth/qbo/callback/route.ts`

Both are three-line wrappers delegating to `runGmailOAuthCallback` / `runQboOAuthCallback`.
They are **redundant**: `src/auth/routes.ts:21,26` already serves those two paths on the engine's
own listener, and `test/oauth-callback.test.ts` exercises the service directly rather than the
Next route, so deleting the wrappers leaves those tests green.

**Decision:** CHUNK_3 deletes both alongside the 52, taking the total to 54. Neither becomes an
IPC channel — consistent with the existing rule that `/api/auth/callback` must not
(`route-to-service-map.md` carry-forward warning 2). CHUNK_5 replaces the provider return path
with the single-use ephemeral loopback callback. **Consequence to state plainly: between CHUNK_3
and CHUNK_5 there is no working provider OAuth return path.** That is acceptable only because
CHUNK_5 is the chunk that builds the desktop connect flow in the first place — the deleted
surface belongs to the retired hosted/dev web mode, not to the desktop product.
