#!/usr/bin/env node
// CHUNK_8_REVIEWDASH — build-time generator (Node 20, zero deps). Reads a
// tenant-scoped review snapshot JSON (src/services/review/snapshot.ts) and writes a
// single self-contained offline HTML artifact: inline CSS + inline JS, NO external
// host references (fonts/scripts/images), all data rendered via `textContent`
// (never `innerHTML`), and the embedded `const DATA` has every `<` escaped to the
// JS string escape `<` so an injected `</script>`/`<script>` in a vendor or
// finding string can never break out of the `<script>` tag or execute.
//
// Usage: node scripts/build-review-dashboard.mjs <snapshot.json> <out.html>
// Exit 0 on success; exit 1 with "BAD_SNAPSHOT: <reason>" on parse/shape failure
// (per specs/SPEC-reviewer-dashboard.md §7/§12) — no HTML is written in that case.
//
// White-label guardrail (guarantee 6): this template contains NO tenant-specific
// value. Every tenant-specific string (company, tenant id, proposals, vendors) is
// injected at build time from the snapshot argument only.

import { readFile, writeFile } from 'node:fs/promises';

function fail(message) {
  console.error(`BAD_SNAPSHOT: ${message}`);
  process.exitCode = 1;
}

async function main() {
  const [, , inPath, outPath] = process.argv;
  if (!inPath || !outPath) {
    console.error('Usage: node scripts/build-review-dashboard.mjs <snapshot.json> <out.html>');
    process.exitCode = 1;
    return;
  }

  let raw;
  try {
    raw = await readFile(inPath, 'utf8');
  } catch (err) {
    fail(`cannot read ${inPath}: ${err.message}`);
    return;
  }

  let snapshot;
  try {
    snapshot = JSON.parse(raw);
  } catch (err) {
    fail(`invalid JSON in ${inPath}: ${err.message}`);
    return;
  }

  if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.proposals)) {
    fail(`${inPath} is missing a "proposals" array`);
    return;
  }

  const html = renderDashboard(snapshot);
  await writeFile(outPath, html, 'utf8');
  console.log(`wrote ${snapshot.proposals.length} proposal(s) -> ${outPath}`);
}

/** Escape `<` to the JS/JSON unicode escape so the DATA payload can never
 *  contain a literal `</script>` (or `<script>`) byte sequence in the HTML
 *  source, regardless of what a vendor/finding/source string contains. */
function escapeForInlineScript(json) {
  return json.replace(/</g, '\\u003c');
}

function renderDashboard(snapshot) {
  const dataJson = escapeForInlineScript(JSON.stringify(snapshot));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>AP-Hub Reviewer Packet</title>
<style>
${CSS}
</style>
</head>
<body>
<div class="wrap">

  <header class="report-header">
    <div class="stamp" aria-hidden="true">DRAFT</div>
    <h1>AP-Hub Reviewer Packet</h1>
    <div class="meta">
      <span>Company: <b id="hdr-company"></b></span>
      <span>Tenant: <b id="hdr-tenant"></b></span>
      <span>Run: <b id="hdr-run"></b></span>
      <span>Generated: <b id="hdr-generated"></b></span>
    </div>
    <p class="offline-note">Offline artifact — no network calls. Decisions are saved to this browser's
      local storage and must be exported and replayed through the operator CLI to take effect.</p>
  </header>

  <section class="kpi-band" id="kpi-band" aria-label="Summary"></section>

  <section class="vendor-cards" id="vendor-cards" aria-label="Per-vendor totals"></section>

  <section class="proof-panel" id="proof-panel" aria-label="Proof / verify coverage"></section>

  <section class="review-bar" aria-label="Review progress">
    <div class="progress-track" id="progress-track">
      <div class="progress-approved" id="progress-approved"></div>
      <div class="progress-rejected" id="progress-rejected"></div>
    </div>
    <div class="progress-counts" id="progress-counts"></div>
    <div class="export-buttons">
      <button type="button" id="export-json" class="btn">Export JSON</button>
      <button type="button" id="export-csv" class="btn">Export CSV</button>
    </div>
  </section>

  <section class="controls" aria-label="Filters">
    <div class="chip-row" id="risk-chips" role="group" aria-label="Filter by risk"></div>
    <label class="ctl">Vendor
      <select id="vendor-select"></select>
    </label>
    <label class="ctl">Decision
      <select id="decision-select">
        <option value="all">All</option>
        <option value="pending">Pending</option>
        <option value="approved">Approved</option>
        <option value="rejected">Rejected</option>
      </select>
    </label>
    <label class="ctl search-ctl">Search
      <input type="search" id="search-input" placeholder="vendor, issue, source...">
    </label>
  </section>

  <div id="storage-warning" class="storage-warning" hidden>
    Local storage is unavailable (private/incognito mode) — decisions are kept for this
    session only. Export before closing this tab.
  </div>

  <section class="table-wrap" aria-label="Proposals">
    <table id="proposals-table">
      <thead>
        <tr>
          <th></th>
          <th>ID</th>
          <th>Vendor</th>
          <th>Issue</th>
          <th class="num">Amount</th>
          <th>Risk</th>
          <th>Status</th>
          <th>Proof</th>
          <th>Source</th>
          <th>Decision</th>
        </tr>
      </thead>
      <tbody id="proposals-tbody"></tbody>
    </table>
    <p id="empty-state" class="empty-state" hidden>Nothing to review.</p>
  </section>

</div>
<script>
const DATA = ${dataJson};
${CLIENT_JS}
</script>
</body>
</html>
`;
}

const CSS = `
:root{
  --paper:#eef1f0; --panel:#fff; --panel-2:#f6f8f7;
  --ink:#161b1d; --ink-soft:#3b474b; --muted:#66757b; --line:#d8e0de; --line-soft:#e6ecea;
  --accent:#0d6e64; --accent-ink:#0a534c;
  --crit:#b23b30; --crit-bg:#f7e7e4;
  --warn:#9a6a13; --warn-bg:#f6edda;
  --info:#4d6873; --info-bg:#e9eef0;
  --good:#0d6e64; --good-bg:#e2efec;
  --reject:#b23b30; --reject-bg:#f7e7e4;
}
@media (prefers-color-scheme:dark){ :root{
  --paper:#0f1416; --panel:#161d1f; --panel-2:#1b2426; --ink:#e7edec; --ink-soft:#c0cbc9;
  --muted:#8a9a99; --line:#28322f; --line-soft:#202a28; --accent:#3fb0a1; --accent-ink:#6fd0c2;
  --crit:#e07a6e; --crit-bg:#33211f; --warn:#d3a24e; --warn-bg:#2e2716; --info:#8fabb5; --info-bg:#1d282c;
  --good:#3fb0a1; --good-bg:#16302c; --reject:#e07a6e; --reject-bg:#33211f;
}}
:root[data-theme="light"]{
  --paper:#eef1f0; --panel:#fff; --panel-2:#f6f8f7;
  --ink:#161b1d; --ink-soft:#3b474b; --muted:#66757b; --line:#d8e0de; --line-soft:#e6ecea;
  --accent:#0d6e64; --accent-ink:#0a534c;
  --crit:#b23b30; --crit-bg:#f7e7e4;
  --warn:#9a6a13; --warn-bg:#f6edda;
  --info:#4d6873; --info-bg:#e9eef0;
  --good:#0d6e64; --good-bg:#e2efec;
  --reject:#b23b30; --reject-bg:#f7e7e4;
}
:root[data-theme="dark"]{
  --paper:#0f1416; --panel:#161d1f; --panel-2:#1b2426; --ink:#e7edec; --ink-soft:#c0cbc9;
  --muted:#8a9a99; --line:#28322f; --line-soft:#202a28; --accent:#3fb0a1; --accent-ink:#6fd0c2;
  --crit:#e07a6e; --crit-bg:#33211f; --warn:#d3a24e; --warn-bg:#2e2716; --info:#8fabb5; --info-bg:#1d282c;
  --good:#3fb0a1; --good-bg:#16302c; --reject:#e07a6e; --reject-bg:#33211f;
}
--serif:Iowan Old Style,"Palatino Linotype",Palatino,Georgia,"Times New Roman",serif;
* { box-sizing: border-box; }
html,body{ margin:0; padding:0; background:var(--paper); color:var(--ink);
  font-family: system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
body{ padding: 24px 16px 64px; }
.wrap{ max-width: 1120px; margin: 0 auto; display: grid; gap: 20px; }
a{ color: var(--accent-ink); }
button, select, input{ font: inherit; color: inherit; }
:focus-visible{ outline: 2px solid var(--accent); outline-offset: 2px; }
@media (prefers-reduced-motion: reduce){ *{ animation: none !important; transition: none !important; } }

.report-header{ position: relative; background: var(--panel); border: 1px solid var(--line);
  border-radius: 10px; padding: 20px 24px; overflow: hidden; }
.report-header h1{ margin: 0 0 8px; font-family: Iowan Old Style,"Palatino Linotype",Palatino,Georgia,"Times New Roman",serif;
  font-size: 1.5rem; }
.report-header .meta{ display:flex; flex-wrap: wrap; gap: 16px; color: var(--muted); font-size: .9rem; }
.report-header .meta b{ color: var(--ink); font-variant-numeric: tabular-nums;
  font-family: ui-monospace,"SF Mono","JetBrains Mono",Menlo,Consolas,monospace; }
.offline-note{ margin: 10px 0 0; color: var(--muted); font-size: .82rem; }
.stamp{ position: absolute; top: 10px; right: -28px; transform: rotate(18deg);
  background: var(--crit-bg); color: var(--crit); border: 2px solid var(--crit);
  font-weight: 700; letter-spacing: .12em; padding: 4px 40px; font-size: .78rem; }

.kpi-band{ display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 10px; }
.kpi-tile{ background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; }
.kpi-tile .kpi-label{ color: var(--muted); font-size: .74rem; text-transform: uppercase; letter-spacing: .05em; }
.kpi-tile .kpi-value{ font-family: ui-monospace,"SF Mono","JetBrains Mono",Menlo,Consolas,monospace;
  font-variant-numeric: tabular-nums; font-size: 1.35rem; margin-top: 2px; }

.vendor-cards{ display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 10px; }
.vendor-card{ text-align: left; cursor: pointer; background: var(--panel); border: 1px solid var(--line);
  border-radius: 10px; padding: 10px 12px; }
.vendor-card:hover, .vendor-card.active{ border-color: var(--accent); }
.vendor-card .v-name{ font-weight: 600; }
.vendor-card .v-sub{ color: var(--muted); font-size: .82rem; margin-top: 2px;
  font-variant-numeric: tabular-nums; }

.proof-panel{ background: var(--panel-2); border: 1px solid var(--line-soft); border-radius: 10px;
  padding: 12px 16px; display: flex; flex-wrap: wrap; gap: 18px; font-size: .88rem; color: var(--ink-soft); }
.proof-panel b{ color: var(--ink); }

.review-bar{ display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
.progress-track{ flex: 1 1 220px; height: 10px; border-radius: 6px; background: var(--line-soft);
  display: flex; overflow: hidden; min-width: 160px; }
.progress-approved{ background: var(--good); height: 100%; }
.progress-rejected{ background: var(--reject); height: 100%; }
.progress-counts{ color: var(--muted); font-size: .85rem; }
.export-buttons{ display: flex; gap: 8px; }
.btn{ background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 7px 14px;
  cursor: pointer; }
.btn:hover{ border-color: var(--accent); }

.controls{ display: flex; flex-wrap: wrap; align-items: end; gap: 14px; }
.chip-row{ display: flex; gap: 6px; }
.chip{ border: 1px solid var(--line); background: var(--panel); border-radius: 999px; padding: 5px 12px;
  cursor: pointer; font-size: .84rem; }
.chip[aria-pressed="true"]{ border-color: var(--accent); background: var(--good-bg); color: var(--accent-ink); }
.ctl{ display: flex; flex-direction: column; gap: 4px; font-size: .78rem; color: var(--muted); }
.ctl select, .ctl input{ background: var(--panel); border: 1px solid var(--line); border-radius: 8px;
  padding: 6px 8px; }
.search-ctl{ flex: 1 1 200px; }
.search-ctl input{ width: 100%; }

.storage-warning{ background: var(--warn-bg); color: var(--warn); border: 1px solid var(--warn);
  border-radius: 8px; padding: 8px 12px; font-size: .85rem; }

.table-wrap{ background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
  overflow-x: auto; }
table{ width: 100%; border-collapse: collapse; font-size: .88rem; }
thead th{ text-align: left; padding: 10px 12px; color: var(--muted); font-size: .74rem;
  text-transform: uppercase; letter-spacing: .04em; border-bottom: 1px solid var(--line); white-space: nowrap; }
th.num, td.num{ text-align: right; }
tbody td{ padding: 9px 12px; border-bottom: 1px solid var(--line-soft); vertical-align: middle; }
tbody tr{ border-left: 4px solid transparent; }
tbody tr.risk-high{ border-left-color: var(--crit); }
tbody tr.risk-med{ border-left-color: var(--warn); }
tbody tr.risk-low{ border-left-color: var(--info); }
tbody tr.decision-approved{ background: var(--good-bg); }
tbody tr.decision-rejected{ opacity: .6; }
tbody tr.decision-rejected .cell-issue, tbody tr.decision-rejected .cell-vendor{ text-decoration: line-through; }
.amount{ font-family: ui-monospace,"SF Mono","JetBrains Mono",Menlo,Consolas,monospace;
  font-variant-numeric: tabular-nums; }
.pill{ display: inline-block; border-radius: 999px; padding: 2px 9px; font-size: .76rem; font-weight: 600; }
.pill-high{ background: var(--crit-bg); color: var(--crit); }
.pill-med{ background: var(--warn-bg); color: var(--warn); }
.pill-low{ background: var(--info-bg); color: var(--info); }
.decision-cell{ display: flex; gap: 6px; }
.decision-cell button{ border: 1px solid var(--line); background: var(--panel); border-radius: 6px;
  padding: 4px 10px; cursor: pointer; font-size: .82rem; }
.decision-cell button[aria-pressed="true"].approve-btn{ background: var(--good-bg); border-color: var(--good);
  color: var(--accent-ink); }
.decision-cell button[aria-pressed="true"].reject-btn{ background: var(--reject-bg); border-color: var(--reject);
  color: var(--crit); }
.empty-state{ padding: 24px; text-align: center; color: var(--muted); }
`;

const CLIENT_JS = `
(function () {
  "use strict";
  var runId = DATA.run || "unknown-run";
  var storageKey = "aphub-review-" + runId;
  var storageAvailable = true;
  var decisions = {};

  function loadDecisions() {
    try {
      var raw = window.localStorage.getItem(storageKey);
      if (raw) decisions = JSON.parse(raw) || {};
    } catch (err) {
      storageAvailable = false;
    }
  }

  function saveDecisions() {
    if (!storageAvailable) return;
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(decisions));
    } catch (err) {
      storageAvailable = false;
      showStorageWarning();
    }
  }

  function showStorageWarning() {
    var el = document.getElementById("storage-warning");
    if (el) el.hidden = false;
  }

  function fmtMoney(cents) {
    var n = typeof cents === "number" && isFinite(cents) ? cents : 0;
    var sign = n < 0 ? "-" : "";
    var abs = Math.abs(n);
    var dollars = Math.floor(abs / 100);
    var rem = String(abs % 100).padStart(2, "0");
    return sign + "$" + dollars.toString().replace(/\\B(?=(\\d{3})+(?!\\d))/g, ",") + "." + rem;
  }

  function text(tag, className, value) {
    var el = document.createElement(tag);
    if (className) el.className = className;
    if (value !== undefined && value !== null) el.textContent = String(value);
    return el;
  }

  var state = { risk: "all", vendor: "all", decision: "all", search: "" };

  function decisionFor(id) {
    return decisions[id] || "pending";
  }

  function setDecision(id, value) {
    var current = decisionFor(id);
    decisions[id] = current === value ? "pending" : value;
    saveDecisions();
    render();
  }

  function matchesFilters(p) {
    if (state.risk !== "all" && p.risk !== state.risk) return false;
    if (state.vendor !== "all" && p.vendor !== state.vendor) return false;
    if (state.decision !== "all" && decisionFor(p.id) !== state.decision) return false;
    if (state.search) {
      var q = state.search.toLowerCase();
      var hay = (p.vendor + " " + p.issue + " " + p.source).toLowerCase();
      if (hay.indexOf(q) === -1) return false;
    }
    return true;
  }

  function renderKpiBand() {
    var band = document.getElementById("kpi-band");
    band.textContent = "";
    var s = DATA.summary || {};
    var tiles = [
      ["Total", s.count || 0],
      ["Ready", s.ready || 0],
      ["Review", s.review || 0],
      ["Exception", s.exception || 0],
      ["Total amount", fmtMoney(s.amount_cents || 0)],
    ];
    tiles.forEach(function (t) {
      var tile = text("div", "kpi-tile");
      tile.appendChild(text("div", "kpi-label", t[0]));
      tile.appendChild(text("div", "kpi-value", t[1]));
      band.appendChild(tile);
    });
  }

  function renderVendorCards() {
    var wrap = document.getElementById("vendor-cards");
    wrap.textContent = "";
    (DATA.vendorTotals || []).forEach(function (v) {
      var card = document.createElement("button");
      card.type = "button";
      card.className = "vendor-card";
      if (state.vendor === v.vendor) card.classList.add("active");
      card.appendChild(text("div", "v-name", v.vendor));
      card.appendChild(text("div", "v-sub", v.count + " item(s) - " + fmtMoney(v.amount_cents)));
      card.addEventListener("click", function () {
        state.vendor = state.vendor === v.vendor ? "all" : v.vendor;
        document.getElementById("vendor-select").value = state.vendor;
        render();
        document.getElementById("proposals-table").scrollIntoView({ behavior: "smooth", block: "start" });
      });
      wrap.appendChild(card);
    });
  }

  function renderProofPanel() {
    var panel = document.getElementById("proof-panel");
    panel.textContent = "";
    var proposals = DATA.proposals || [];
    var withProof = proposals.filter(function (p) { return p.proof; }).length;
    var missing = proposals.length - withProof;
    var verdictCounts = {};
    proposals.forEach(function (p) {
      var v = p.proof ? p.proof.verdict : "unavailable";
      verdictCounts[v] = (verdictCounts[v] || 0) + 1;
    });
    function row(label, value) {
      var span = document.createElement("span");
      span.appendChild(document.createTextNode(label + ": "));
      span.appendChild(text("b", null, value));
      return span;
    }
    panel.appendChild(row("Proof coverage", withProof + " / " + proposals.length));
    panel.appendChild(row("Missing proof", missing));
    Object.keys(verdictCounts).forEach(function (v) {
      panel.appendChild(row("Verdict: " + v, verdictCounts[v]));
    });
  }

  function renderRiskChips() {
    var wrap = document.getElementById("risk-chips");
    wrap.textContent = "";
    [["all", "All risk"], ["high", "High"], ["med", "Med"], ["low", "Low"]].forEach(function (pair) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "chip";
      btn.textContent = pair[1];
      btn.setAttribute("aria-pressed", String(state.risk === pair[0]));
      btn.addEventListener("click", function () {
        state.risk = pair[0];
        render();
      });
      wrap.appendChild(btn);
    });
  }

  function renderVendorSelect() {
    var sel = document.getElementById("vendor-select");
    var current = sel.value || "all";
    sel.textContent = "";
    var allOpt = document.createElement("option");
    allOpt.value = "all";
    allOpt.textContent = "All vendors";
    sel.appendChild(allOpt);
    (DATA.vendorTotals || []).forEach(function (v) {
      var opt = document.createElement("option");
      opt.value = v.vendor;
      opt.textContent = v.vendor;
      sel.appendChild(opt);
    });
    sel.value = state.vendor;
  }

  function riskPillClass(risk) {
    if (risk === "high") return "pill pill-high";
    if (risk === "med") return "pill pill-med";
    return "pill pill-low";
  }

  function renderTable() {
    var tbody = document.getElementById("proposals-tbody");
    tbody.textContent = "";
    var rows = (DATA.proposals || []).filter(matchesFilters);
    document.getElementById("empty-state").hidden = rows.length !== 0;

    rows.forEach(function (p) {
      var tr = document.createElement("tr");
      tr.className = "risk-" + p.risk;
      var d = decisionFor(p.id);
      if (d === "approved") tr.classList.add("decision-approved");
      if (d === "rejected") tr.classList.add("decision-rejected");

      tr.appendChild(document.createElement("td"));
      tr.appendChild(text("td", null, p.id));
      tr.appendChild(text("td", "cell-vendor", p.vendor));
      tr.appendChild(text("td", "cell-issue", p.issue));

      var amtTd = document.createElement("td");
      amtTd.className = "num amount";
      amtTd.textContent = fmtMoney(p.amount_cents);
      tr.appendChild(amtTd);

      var riskTd = document.createElement("td");
      riskTd.appendChild(text("span", riskPillClass(p.risk), p.risk));
      tr.appendChild(riskTd);

      tr.appendChild(text("td", null, p.status));
      tr.appendChild(text("td", null, p.proof ? (p.proof.product + ": " + p.proof.verdict) : "unavailable"));
      tr.appendChild(text("td", null, p.source));

      var decTd = document.createElement("td");
      var cell = document.createElement("div");
      cell.className = "decision-cell";
      var approveBtn = document.createElement("button");
      approveBtn.type = "button";
      approveBtn.className = "approve-btn";
      approveBtn.textContent = "Approve";
      approveBtn.setAttribute("aria-pressed", String(d === "approved"));
      approveBtn.addEventListener("click", function () { setDecision(p.id, "approved"); });
      var rejectBtn = document.createElement("button");
      rejectBtn.type = "button";
      rejectBtn.className = "reject-btn";
      rejectBtn.textContent = "Reject";
      rejectBtn.setAttribute("aria-pressed", String(d === "rejected"));
      rejectBtn.addEventListener("click", function () { setDecision(p.id, "rejected"); });
      cell.appendChild(approveBtn);
      cell.appendChild(rejectBtn);
      decTd.appendChild(cell);
      tr.appendChild(decTd);

      tbody.appendChild(tr);
    });
  }

  function renderProgress() {
    var proposals = DATA.proposals || [];
    var approved = 0, rejected = 0;
    proposals.forEach(function (p) {
      var d = decisionFor(p.id);
      if (d === "approved") approved++;
      else if (d === "rejected") rejected++;
    });
    var total = proposals.length || 1;
    document.getElementById("progress-approved").style.width = (approved / total * 100) + "%";
    document.getElementById("progress-rejected").style.width = (rejected / total * 100) + "%";
    document.getElementById("progress-counts").textContent =
      approved + " approved, " + rejected + " rejected, " + (proposals.length - approved - rejected) + " pending";
  }

  function render() {
    renderVendorCards();
    renderRiskChips();
    renderTable();
    renderProgress();
  }

  function buildExportPayload() {
    var proposals = DATA.proposals || [];
    var approved = 0, rejected = 0, pending = 0;
    var decisionsOut = proposals.map(function (p) {
      var d = decisionFor(p.id);
      if (d === "approved") approved++;
      else if (d === "rejected") rejected++;
      else pending++;
      return {
        id: p.id,
        vendor: p.vendor,
        risk: p.risk,
        amount_cents: p.amount_cents,
        decision: d,
        finding: p.issue,
        source: p.source,
      };
    });
    return {
      run: DATA.run,
      tenant: DATA.tenant,
      exported: new Date().toISOString(),
      summary: { total: proposals.length, approved: approved, rejected: rejected, pending: pending },
      decisions: decisionsOut,
    };
  }

  function downloadBlob(filename, mime, content) {
    var blob = new Blob([content], { type: mime });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function csvEscape(value) {
    var s = String(value === undefined || value === null ? "" : value);
    // CSV/formula-injection guard (CWE-1236): a field beginning with =, +, -, @,
    // or a tab/CR can execute as a formula when opened in Excel/Sheets. Source
    // strings here (vendor/finding/source) come from AP email content, so they
    // are attacker-influenced. Prefix with a literal-text quote to neutralize.
    if (/^[=+@\\t\\r-]/.test(s)) s = "'" + s;
    if (/[",\\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function toCsv(payload) {
    var header = ["id", "vendor", "risk", "amount_cents", "decision", "finding", "source"];
    var lines = [header.join(",")];
    payload.decisions.forEach(function (d) {
      lines.push(header.map(function (k) { return csvEscape(d[k]); }).join(","));
    });
    return lines.join("\\r\\n");
  }

  function wireControls() {
    document.getElementById("vendor-select").addEventListener("change", function (e) {
      state.vendor = e.target.value;
      render();
    });
    document.getElementById("decision-select").addEventListener("change", function (e) {
      state.decision = e.target.value;
      render();
    });
    document.getElementById("search-input").addEventListener("input", function (e) {
      state.search = e.target.value;
      render();
    });
    document.getElementById("export-json").addEventListener("click", function () {
      var payload = buildExportPayload();
      downloadBlob("aphub-review-" + runId + "-decisions.json", "application/json", JSON.stringify(payload, null, 2));
    });
    document.getElementById("export-csv").addEventListener("click", function () {
      var payload = buildExportPayload();
      downloadBlob("aphub-review-" + runId + "-decisions.csv", "text/csv", toCsv(payload));
    });
  }

  function renderHeader() {
    document.getElementById("hdr-company").textContent = DATA.company || "-";
    document.getElementById("hdr-tenant").textContent = DATA.tenant;
    document.getElementById("hdr-run").textContent = DATA.run;
    document.getElementById("hdr-generated").textContent = DATA.generated;
  }

  loadDecisions();
  renderHeader();
  renderKpiBand();
  renderProofPanel();
  renderVendorSelect();
  wireControls();
  render();
  if (!storageAvailable) showStorageWarning();
})();
`;

main();
