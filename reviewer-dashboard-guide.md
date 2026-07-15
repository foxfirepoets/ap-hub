# Reviewer Dashboard — reusable build guide

A portable recipe for the single-page **review dashboard** built for the PacketOS
test run (a licensed reviewer approves/rejects AI-proposed findings, then the
decisions regenerate a clean work product). It is a self-contained HTML artifact
— no build step, no framework, no backend — generated from your own data.

Copy this pattern into any project that has: *a list of machine-proposed items a
human must triage, grouped by some entity, with per-group totals and a
verify/score step.* (Code review findings, audit exceptions, data-quality flags,
moderation queues, lint results, etc.)

---

## 1. Architecture: a build-time generator, not a hand-written page

Do **not** hand-write the HTML with the data inside it. Write a small Node
generator that **reads your real data files and injects them** into an HTML
template. This guarantees the page matches the source and never drifts.

```
build-dashboard.mjs   # reads JSON/CSV  →  writes dashboard.html (data embedded)
```

- The data is injected once as a single `const DATA = {...}` (JSON), with `<`
  escaped to `<` so it can never break out of the `<script>` tag.
- **All row/label text is rendered with `textContent`, never `innerHTML`.** This
  is the whole XSS story — you can drop arbitrary source strings in safely.
- Numbers are formatted at render time from integer minor units (cents), never
  pre-formatted in the data.

Publish the resulting file as an Artifact (or open it directly). It is fully
self-contained: inline CSS + inline JS, no external fonts/scripts (a strict CSP
blocks them).

---

## 2. Input data contract

The generator expects these shapes (rename to your domain):

```jsonc
// rows to triage
exceptions: [
  { "entity": "ENT-RWM", "issue": "short human label",
    "amount_cents": 2400000,          // integer minor units; 0 = "no amount"
    "source": "path/to/evidence.pdf", // provenance string
    "risk": "high" | "med" | "low" }
]

// per-group totals strip (parsed from your books/CSVs)
entityTotals: [
  { "code":"ENT-SRDG", "short":"SRDG", "name":"Legal Name, LLC",
    "taxReadyCents": 160036404, "balanced": true, "accounts": 17 }
]

// optional: a score vs a known-answer set
score: { "detected": 21, "total": 30, "rate": 0.7,
         "missed": [ { "id":"ISSUE-004", "entity":"GROUP", "issue":"…", "risk":"High" } ] }

// optional: an independent verification pass
ai: { "reconciles": true, "mismatches": [...], "topRisks": 18, "blocking": [...], "agent": "claude" }
```

Parsing per-group totals from a CSV: read the file's own `TOTALS` summary row
(regex out the balanced total + a balance flag) rather than re-summing — the
source of truth stays the source.

---

## 3. Design system

This is a **tool, not a document**: information design over editorial flourish —
summary before detail, state encoded in form (stripe / chip / pill), semantic
color separate from the brand accent.

### Color tokens (drop-in, both themes)

Define every color as a CSS custom property on `:root`, redefine the tokens (not
the components) under the dark media query **and** under
`:root[data-theme="dark|light"]` so the viewer's manual theme toggle wins in both
directions. Style components through the tokens only.

```css
:root{
  --paper:#eef1f0; --panel:#fff; --panel-2:#f6f8f7;
  --ink:#161b1d; --ink-soft:#3b474b; --muted:#66757b; --line:#d8e0de; --line-soft:#e6ecea;
  --accent:#0d6e64; --accent-ink:#0a534c;               /* deep teal — brand, NOT a severity color */
  --crit:#b23b30; --crit-bg:#f7e7e4;                    /* semantic: high/critical */
  --warn:#9a6a13; --warn-bg:#f6edda;                    /* semantic: medium */
  --info:#4d6873; --info-bg:#e9eef0;                    /* semantic: low/info */
  --good:#0d6e64; --good-bg:#e2efec;                    /* approved / balanced */
  --reject:#b23b30; --reject-bg:#f7e7e4;                /* rejected */
}
@media (prefers-color-scheme:dark){ :root{
  --paper:#0f1416; --panel:#161d1f; --panel-2:#1b2426; --ink:#e7edec; --ink-soft:#c0cbc9;
  --muted:#8a9a99; --line:#28322f; --line-soft:#202a28; --accent:#3fb0a1; --accent-ink:#6fd0c2;
  --crit:#e07a6e; --crit-bg:#33211f; --warn:#d3a24e; --warn-bg:#2e2716; --info:#8fabb5; --info-bg:#1d282c;
  --good:#3fb0a1; --good-bg:#16302c; --reject:#e07a6e; --reject-bg:#33211f;
}}
:root[data-theme="light"]{ /* …same as the light :root values… */ }
:root[data-theme="dark"]{  /* …same as the dark values… */ }
```

The point: a **cool "ledger-paper" neutral** (not the cream/#F4F1EA AI cliché),
one restrained accent, and **semantic severity colors that carry the scanning
load** — the accent never doubles as a severity color.

### Type roles (system stack — no webfont CDN under CSP)

```css
--serif:Iowan Old Style,"Palatino Linotype",Palatino,Georgia,"Times New Roman",serif; /* titles: "official document" tone */
--sans: system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;         /* UI / body */
--mono: ui-monospace,"SF Mono","JetBrains Mono",Menlo,Consolas,monospace;              /* figures + codes */
```

Every figure and entity code uses `--mono` with `font-variant-numeric:tabular-nums`
so columns of digits align — the ledger reinforces the subject. If you must have
a branded face, inline it as a `@font-face` **data URI**; never `<link>` a font
URL (it silently fails under the Artifact CSP).

### Layout

`max-width` container → report header with a rotated **DRAFT stamp** → scannable
**KPI band** (grid of stat tiles) → **per-group totals** cards → two verification
**panels** → a **review bar** (progress + export) → **controls** (filter chips +
selects + search) → a **table** with a left **severity stripe**. Lay siblings out
with `grid`/`gap`; give wide content (`table`) its own `overflow-x:auto` wrapper
so the page body never scrolls sideways.

---

## 4. Interactivity (vanilla JS, no deps)

- **Filters**: severity chips (`aria-pressed`), an entity `<select>`, a decision
  `<select>`, and a search box — all re-run one `render()` that rebuilds `<tbody>`.
- **Per-group cards cross-filter the table** on click (and scroll to it), tying
  the summary to the detail.
- **Approve / reject per row**: two buttons per row; clicking the active one
  clears back to pending. Row state encoded visually (green stripe/tint for
  approved, muted + strike-through for rejected).
- **Persistence**: decisions live in `localStorage` under a run-scoped key
  (`app-review-<runId>`), so they survive reload. (An artifact has no backend —
  this is the durable store.)
- **Progress**: a two-color track (approved / rejected) + live counts.
- **Export**: build a Blob and click a synthetic `<a download>` for **JSON** and
  **CSV** — `{run, company, exported, summary, decisions:[{id,entity,risk,amount_cents,decision,finding,source}]}`.

Row identity: assign each item a stable `_id = "ex_" + originalIndex` **before**
sorting/filtering, and key decisions + export by that id.

Accessibility: visible `:focus-visible`, `aria-pressed` on toggles,
`aria-label` on icon buttons, and `@media (prefers-reduced-motion:reduce)`.

---

## 5. Decisions → regenerated work product (the loop)

The export file is the hand-off to a controller-side script that rebuilds the
work product applying **only approved** items:

```
node apply-decisions.mjs <decisions.json> [source-dir] [target-dir]
```

Contract:
- Read the exported decisions (`decisions[].id → decision`) + the original items.
- For each proposed change, **apply it only if its decision is `approved`**;
  back out `rejected` **and** `pending` (proposal ≠ accepted).
- **Preserve invariants deterministically.** In the tax case each change is a
  balanced journal entry (both legs tagged `JE-<id>`, netting to zero), so
  applying/backing-out a whole JE keeps the trial balance in balance *by
  construction*. Find the equivalent invariant in your domain and make the
  regeneration respect it.
- Recompute and **re-verify** (the script exits non-zero if any group fails its
  balance/consistency check — fail loud, never ship a broken regen).
- Emit: the regenerated files, items tagged with their decision, a
  `decision-to-change-map.csv` (transparency: exactly what drove each edit), and
  an `approval-log.md` (audit trail + post-regen check).

Because an artifact can't run Node, the exported file **is** the wire between the
browser and the regenerator — document the command on the page itself.

---

## 6. Adapting to another project — checklist

1. Replace `exceptions` with your rows (`entity`, `issue`, `amount_cents`,
   `source`, `risk`); keep the field names or rename throughout the generator.
2. Replace `entityTotals` with your groups; parse totals from your own source.
3. Keep or drop `score`/`ai` panels depending on whether you have a known-answer
   set / an independent verifier.
4. Relabel the header, stamp, and copy to your domain's vernacular.
5. Keep the token system + type roles; only shift the **accent** hue to your
   brand — leave the semantic severity colors alone.
6. If you have a "regenerate" step, mirror `apply-decisions.mjs`: apply approved
   only, preserve your invariant, re-verify, log.

## 7. Guardrails (don't skip)

- `textContent` for all data; escape `<`→`<` in the embedded JSON.
- No external fonts/scripts/images — inline everything (Artifact CSP blocks hosts).
- Design both themes at the token level; the manual toggle must win.
- Any control says exactly what it does ("Approve" → the row shows "approved").
- If the page states a number, it came from the data; if it can't be proven,
  label it — never fabricate a score or a "balanced" flag.
