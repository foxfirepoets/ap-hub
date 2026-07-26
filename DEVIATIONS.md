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

**CLOSED 2026-07-26 — `[VERIFIED in real Electron]`.** The `file://` interception is built
(`desktop/renderer.ts` for the rules, `serveExportedRenderer()` in `desktop/main.ts` for the
wiring) and proved by `e2e-desktop/renderer.spec.ts` against a real Electron process: navigating to
`/statements/424242`, `/transactions/999123` and `/settings/tax-mapping/919191` is answered 200 with
that family's exported sentinel page, the address is preserved, and the page then calls
`aphub:{statements,transactions,tax-mappings}:get` with the **runtime** id — observed at the main
process, whose stub for that channel is the only thing the test adds. The sentinel document and every
script it loads contain the sentinel and never the runtime id, so the id can only have come from the
address. 13 desktop Playwright tests pass; `npx playwright test --project=desktop` exits 0.

As built, the page diff is **+5/-1 in each of the three pages** (15 insertions, 3 deletions), two
insertions per page being the comment explaining why the address is read instead of the route
parameter; the semantic change is the two lines §5a predicted. The three new layouts are 14 lines
each. Zero `href` / `router.push` call sites changed, as forecast.

Findings the HTTP stand-in could not have produced are recorded as §7.

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

## 6. CHUNK_3 — moving the renderer to IPC breaks the 24 browser E2E journeys by design

Discovered 2026-07-26 when the gate reached Playwright: **22 of the 24 tests in
`e2e/app.spec.ts` fail** with `getByTestId('today-page')` not found.

**Cause, and it is correct behaviour rather than a defect:** `app/lib/api.ts` no longer calls
`fetch`. It calls `window.aphub.invoke`, which is injected by the Electron preload and **does not
exist in a plain Chromium browser** served by `next start`. So the pages never render. This is the
direct, intended consequence of CHUNK_3's whole purpose — AP-Hub is not a browser application and
opens no product listening socket. `playwright.config.ts` has two projects: `chromium` (`./e2e`,
browser) and `desktop` (`./e2e-desktop`, real Electron).

Test 9 of the suite still passes, which is informative: *"reply draft surface contains no
transmission control or provider-send source path"* inspects source rather than driving a UI, so
it is transport-independent.

### What must NOT happen

- **Do not delete these tests.** They carry coverage nothing else has: UI-level RBAC (bookkeeper
  sees "Send to Owner" and never an approve-and-post button; cpa is read-only), the Gmail draft
  prepare/edit/open/discard flow, the missing-compose-scope recovery path, immutability of an
  externally sent Gmail projection, statement review/match/exclude/file, tax-mapping badges and
  audit trail, keyboard skip-navigation, focus trapping, and mobile viewport behaviour.
- **Do not add a `fetch` fallback** to `app/lib/api.ts` so the browser suite keeps passing. That
  reintroduces the browser product surface this chunk exists to remove, keeps `app/api/**` alive,
  and therefore also keeps `next build --output export` blocked (DEVIATIONS §4).
- **Do not mark CHUNK_3 complete while the gate is red here.** The chunk's own acceptance criteria
  require `npm run verify` to exit 0 and a Playwright trace showing zero renderer requests to an
  AP-Hub origin. Neither is satisfied yet.

### Resolution

Migrate the 24 journeys from the `chromium` project into the `desktop` project so they drive the
**static-exported renderer inside real Electron over IPC**. This is the same coverage against the
real transport, and it is what finally proves the acceptance criterion "a Playwright network trace
shows zero renderer requests to an AP-Hub origin" — a browser-served suite could never prove that.

This is bundled with the rest of the remaining CHUNK_3 work, because these pieces only make sense
together:

1. Delete all **54** route handlers (52 under `app/api/**` + the two `app/oauth/*/callback`, §5b).
2. Apply the static-export change: 3 new `layout.tsx` + ~13 lines across 3 pages (§5a).
3. Build the `file://` path interception in `desktop/main.ts` and prove it under real Electron —
   currently `[UNVERIFIED in real Electron]` (§5a).
4. Migrate the 24 journeys to the `desktop` project.
5. Capture the zero-AP-Hub-origin network trace.

Until all five land, CHUNK_3 is **incomplete** and its promise line must not be appended.

**Status 2026-07-26:** items 1, 2 and 3 are done (see §7). Items 4 and 5 are open — the 24 journeys
in `e2e/app.spec.ts` are deliberately left failing for the agent that migrates them, so
`npm run verify` still exits 1 at Playwright and CHUNK_3 is still incomplete.

## 7. CHUNK_3 — three things only a real Electron window revealed

The static export and the `file://` interception landed together. Three departures were forced by
evidence, and none of them was foreseeable from the spike, whose HTTP stand-in could not have
produced any of them.

### 7a. The exported pages carried inline scripts the window's script policy refuses

`RENDERER_CSP` is `script-src 'self'` (`desktop/security.ts`), and its comment is explicit that
"scripts get no such latitude". The exported pages, however, carry their startup data — the router
tree, the redirect, the flight payload — in **inline `<script>` blocks**: five per page, 80 across
the 16 pages. Under the policy every one of them is refused. Proved in a real window: the console
showed `Refused to execute inline script` five times per page, `self.__next_f` stayed empty, nothing
hydrated, and the app was dead static markup. **A browser stand-in without the app's CSP cannot see
this at all**, which is exactly why the spike did not.

The two available fixes are not equivalent:

| Fix | Verdict |
|---|---|
| add `'unsafe-inline'` to `script-src` | **refused** — bends the control that stops rendered invoice/email content becoming executable |
| name each block's digest in the policy | **refused** — ~80 digests regenerated per build; drift silently blanks the window |
| externalize each block to a content-addressed file | **chosen** — artifacts conform to the policy instead |

`scripts/externalize-inline-scripts.mjs` (wired into `npm run web:build`) writes each inline block to
`out/_next/static/inline/<sha256-of-its-contents>.js` and rewrites the tag to a plain reference. It
is idempotent, collapses the blocks pages share (80 → 39 files), and leaves `RENDERER_CSP` **byte
for byte unchanged**. The invariant it creates is asserted twice: `test/desktop-renderer.test.ts`
and `e2e-desktop/renderer.spec.ts` both fail if any exported page regains an inline script.

### 7b. `connect-src 'none'` sends every in-app navigation down the full-page-load path

Also visible only in a real window: the page router tries to fetch `<address>.txt?_rsc=…` before
navigating, and `connect-src 'none'` refuses it — so the router falls back to a browser navigation
every time. That is **correct and load-bearing**, not a defect: the fallback is the path the
interception serves, and it is why the interception had to exist rather than being optional. The
consequence for the resolver is that a request naming a file must be answered as MISSING and never
substituted with a page, or the fallback never happens. Asserted in both new test files.

### 7c. `rendererEntry()` opens the destination screen, not the exported root

The task's literal wording was to point `rendererEntry()` at `out/index.html`. It points at
`file:///login` instead (`file:///today` once a session is held — `hasSession()`), because
`out/index.html` holds no screen: `app/page.tsx` is `redirect('/today')`, which the export turns into
a forwarding stub, and Today then forwards again to sign-in when nobody is signed in. Three full page
loads to show one screen.

That is a cost, but the deciding evidence is stronger: the redirect chain **broke five assertions in
`e2e-desktop/shell.spec.ts`** with `Execution context was destroyed, most likely because of a
navigation`. That file may not be edited, and it was right — a startup that renavigates twice is a
startup nothing can inspect. Entering at the destination makes startup a single navigation. The
exported root still works and is still proved to (`renderer.spec.ts` navigates to `file:///` and
asserts it lands on Today), it is simply not where startup begins.

### 7d. Three test files stopped importing route handlers

`test/bank-statement-api.test.ts` and `test/provider-durable-jobs.test.ts` imported four of the
deleted route handlers; `test/reply-drafts-api.test.ts` scanned two of them for a send call. None is
a listed safety test, and none lost an assertion: the two importers now compose the same `runRead` /
`requireSession` one-liners the deleted handlers contained, verbatim, so every RBAC, tenant-isolation
and 401/403/404/409 case still runs against the real `src/**` code; the send scan now reads the IPC
modules that replaced the routes (`desktop/ipc/{read/reply-drafts,action/replyDrafts}.ts`) rather
than shrinking to the two files that survived. Test count went 1535 → 1557, files 75 → 76.

**One item for the journey-migration agent.** `e2e/app.spec.ts:287` ("reply draft surface contains no
transmission control or provider-send source path") was one of the two chromium journeys still
passing, because it reads source rather than driving a UI. It now fails for a DIFFERENT reason from
the other 22: `ENOENT ... app\api\reply-drafts\route.ts` at `app.spec.ts:303`. Its `sourceFiles` list
(lines 300–301) names two of the deleted route handlers and needs the same substitution already
applied in `test/reply-drafts-api.test.ts` — `desktop/ipc/read/reply-drafts.ts` and
`desktop/ipc/action/replyDrafts.ts`. It is the one failure in that file that is not fixed by moving
the journey to Electron. Chromium is now 23 of 24 red rather than 22 of 24; the extra one is this.
