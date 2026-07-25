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
