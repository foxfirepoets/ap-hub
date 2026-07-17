# Architecture Cartographer Report — ap-hub (Windows installer feasibility)
**Audited:** 2026-07-17 · **Mode:** QUICK MAP + targeted deep-dive on the installer question

> Scope note: this is NOT a full 9-phase audit of the whole repo. It is a QUICK MAP (Phases 1–3)
> plus a focused Phase 4 integration-forensics pass on exactly the surfaces a Windows desktop
> installer would have to wrap: process model, config/secret custody, ports, and the DB.
> Phases 5–9 were not run. Do not cite this as a full architecture audit or as launch evidence.

## Executive Summary

ap-hub is a single-tenant server product: it polls Gmail, proof-gates through SwarmSync, and
writes proposals to a QuickBooks **sandbox** company. The brainstorm being spec'd asks to wrap it
in a Windows desktop installer for non-technical users. Two facts in the code block that premise,
and neither appears anywhere in the brainstorm: (1) the process refuses to boot without
`ANTHROPIC_API_KEY` and uses `SWARMSYNC_API_KEY` — on a desktop install, the operator's own
billable API keys ship to every stranger's machine; (2) `QBO_ENV=production` is hard-refused at
config load, so the installable product can only ever write to a sandbox company. The top
recommendation is to resolve secret custody before writing the installer spec — the answer
determines the architecture.

## Project Map

### Project Type
Single-package Node 20 / TypeScript (ESM, `moduleResolution: Bundler`) app with a Next.js 14
App Router UI layered on top. Not a monorepo. 259 tracked files. `package.json:1` — one package,
no workspaces.

### Main Applications
| App/Service | Path | Framework | Runtime | Purpose |
|---|---|---|---|---|
| Pipeline service | `src/index.ts` | none (node:http + pg-boss) | Node 20 | HTTP `/health` + OAuth callbacks + all pipeline workers |
| Web UI | `app/` | Next.js 14 App Router | Node 20 | Human review/onboarding surface |

### Entry Points
| Entry | File Path | Notes |
|---|---|---|
| Service boot | `src/index.ts:16` (`boot()`) | Starts pg-boss, registers pipeline jobs, listens on `PORT` (default **3001**) |
| Operator CLI | `src/cli.ts` | `npm run cli -- <command>` |
| Migration runner | `src/db/migrate.ts` | Custom, idempotent; `npm run migrate:up` |
| Web | `app/layout.tsx`, `app/page.tsx` | `next dev` / `next build` — **separate process**, default port 3000 |

### Important Config
| File | Path | What It Controls |
|---|---|---|
| Typed config | `src/config.ts` | All env; **hard-refuses `QBO_ENV!=sandbox`** (`src/config.ts:104`) |
| Env template | `.env.example` | 30 vars; see drift finding below |
| Next config | `next.config.mjs` | Web-only tsconfig, `.js`→`.ts` extensionAlias for the ESM specifiers |

### Deployment Surface
| Platform | Config File | Services Deployed | Notes |
|---|---|---|---|
| — | none found | — | **No Dockerfile, no CI workflow, no deploy config exists.** Glob for `Dockerfile*`, `docker-compose*`, `.github/workflows/*`, `render.yaml`, `fly.toml`, `vercel.json` returned zero matches. Today this runs from a dev shell only. |

### Test Surface
| Type | Directory | File Count | Framework |
|---|---|---|---|
| Unit + DB-backed | `test/` | 29 specs + 2 helpers | Vitest (needs live Postgres) |
| E2E | `e2e/app.spec.ts` | 1 | Playwright |

> `> Could not verify from the current repository.` — the brainstorm states "212 existing automated
> tests"; `ralph-guided-installer/.ralph/state.md` states "189/189". Both are unverified here: the
> suite is DB-backed and no Postgres was started for this audit. **Resolve before any spec cites a
> test count as a hard constraint.**

## System Understanding

**Product:** Reads accounting email from Gmail, proof-gates it through SwarmSync, produces
reviewable QuickBooks Online transactions in a **sandbox** company (`CLAUDE.md`, `src/qbo/write.ts`).

**Core backend flow:** `poll → gatekeep → classify → extract → map → propose → post_sandbox`,
wired at `src/pipeline/register.ts`, plus a daily `audit_anchor`. All stages are pg-boss jobs.

**Process model as built (load-bearing for the installer):** the service (`src/index.ts`) and the
Next.js UI are **two separate Node processes on two different ports** — backend `PORT` defaults to
3001 (`src/config.ts:69`), `WEB_BASE_URL` defaults to `http://localhost:3000` (`src/config.ts:65`).
Plus Postgres. That is **three** processes a tray app would have to supervise, not the two the
brainstorm's recommendation assumes.

## Architecture Map

### External Integrations
| Integration | Package | Env Var | Import Location | Risk |
|---|---|---|---|---|
| Anthropic Claude vision | `@anthropic-ai/sdk` | `ANTHROPIC_API_KEY` (**required, boot fails without it** — `src/config.ts:27`) | `src/extract/model.ts`, called at `src/pipeline/extract.ts:214` | **P0 on desktop** — operator's billable key |
| SwarmSync proof suite | (direct fetch) | `SWARMSYNC_API_KEY` (`ssk_live_…`) | `src/services.ts:17` | **P0 on desktop** — operator's billable key |
| Gmail | `googleapis` | `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` (both required) | `src/gmail/client.ts`, `src/auth/gmail-oauth.ts` | P1 — secret ships to client |
| QuickBooks Online | (direct fetch) | `QBO_SANDBOX_CLIENT_SECRET`, `QBO_SANDBOX_REALM_ID` | `src/qbo/client.ts`, `src/qbo/write.ts` | P1 — sandbox-only by hard refusal |
| Telegram | (direct fetch) | `TELEGRAM_BOT_TOKEN` | `src/gatekeeper/telegram.ts` | P1 — secret ships to client |

## Integration Forensics — the installer-blocking findings

### Secret custody — **Isolate** (P0)

**Evidence:**
- `src/config.ts:27` — `ANTHROPIC_API_KEY: z.string().min(1, 'ANTHROPIC_API_KEY is required')` — the
  whole process **refuses to boot** without it.
- `src/pipeline/extract.ts:214` — `getAnthropicExtractor(cfg.ANTHROPIC_API_KEY)` — the key is used
  client-side, in-process, on every extraction.
- `src/services.ts:17` — `apiKey: cfg.SWARMSYNC_API_KEY` — same shape for the proof suite.
- `src/config.ts:31-32` — `GMAIL_CLIENT_SECRET` also required, min 1.
- `.env.example:5,7` — both keys documented as operator-supplied values.

**Why this verdict:** Every one of these is read from local env at runtime by the process that
would ship inside the installer. A Windows installer for non-technical users has exactly three
options and each one changes the architecture:
1. **Bake the operator's keys into the installer** — every buyer can trivially extract
   `ANTHROPIC_API_KEY` and `SWARMSYNC_API_KEY` from disk and spend against the operator's accounts
   without limit. Not viable.
2. **Make each user bring their own keys** — requires a non-technical bookkeeper to create an
   Anthropic account and a SwarmSync account. Contradicts the stated target user.
3. **Add a thin cloud broker** that holds the operator's keys and proxies Claude + SwarmSync —
   viable, but this *is* the cloud component the brainstorm ranked "low impact, low ease" and
   deferred. It arrives through a different door: not for durability, for secret custody.

The brainstorm's Constraint Map, six agents, three cross-examination pairs, and Phase 4 steelman
never raise secret custody. It is not in the Dissent Log or the Crux. This is a genuine gap in the
input, not a disagreement with it.

**Recommended action:** Decide option 1/2/3 **before** the installer spec is written. If 3, scope
the broker as its own spec first — the installer spec depends on its existence and on whether
`ANTHROPIC_API_KEY` remains a required local var at `src/config.ts:27`.

### Sandbox-only hard refusal — **Verify** (P0 for shipping, not for building)

**Evidence:**
- `src/config.ts:104-109` — `if (cfg.QBO_ENV !== 'sandbox') throw new ConfigError(...)`, with the
  message "there is no production write path".
- `CLAUDE.md` guarantee #3 — "Phase 2 writes only to the QBO sandbox."
- `specs/` contains chunks 1–8; production QBO is Phase 3, unspecced.

**Why this verdict:** An installer is a shipping vehicle. The product it would install can only
write to a QuickBooks *sandbox* company — by deliberate, guarantee-bearing refusal. Installing that
on a real bookkeeper's machine ships a demo, not a working AP tool. This does not block *building*
the installer (a sandbox-only pilot build is a legitimate thing to install), but it does mean
"ship the build" cannot mean "sell this to real accountants" yet.

**Recommended action:** Confirm the intent — pilot/demo installer (sandbox is fine, proceed) vs.
customer-shipping installer (Phase 3 production write must land first, and it is a far larger and
more dangerous piece of work than the installer).

### `.env.example` port drift — **Refactor** (P2)

**Evidence:**
- `.env.example:12` — `GMAIL_REDIRECT_URI=http://localhost:3000/oauth/gmail/callback`
- `src/config.ts:33` — default is `http://localhost:3001/oauth/gmail/callback`
- `.env.example:29` vs `src/config.ts:69` — `PORT=3000` vs default `3001`
- OAuth callbacks register onto the **backend** server (`src/auth/routes.ts` → `src/http.ts`), which
  listens on `PORT` — so 3001 is correct and `.env.example` is stale.

**Why this verdict:** Anyone following `.env.example` verbatim registers a redirect URI Google will
call on port 3000, where Next.js is listening and no callback route exists. The installer spec must
pin these ports deliberately; fix the template first so the spec doesn't inherit the wrong numbers.

**Recommended action:** Correct `.env.example` lines 12, 21, 29 to 3001.

## Validation Checklist
- [x] Structure mapped from actual file tree (`git ls-files`, 259 files)
- [x] Entry points mapped with file paths
- [x] Env vars traced to usage (grep run for `ANTHROPIC_API_KEY`, `SWARMSYNC_API_KEY`)
- [x] Deploy configs searched (zero found — recorded as a finding)
- [x] Installer-relevant integrations checked installed / imported / live-wired
- [BLOCKED: no Postgres started] Test count verified — 212 (brainstorm) vs 189 (ralph state) unresolved
- [BLOCKED: not run] Phase 5 deadweight sweep — every dependency checked against imports
- [BLOCKED: not run] Phase 6 misfit sweep, Phase 7 risk register, Phase 8 target architecture, Phase 9 task plan
- [x] Docs claims compared to code (`.env.example` drift found; brainstorm's process-count assumption found wrong)

## Open Questions / Decisions Needed

1. **Secret custody (blocking).** Bake keys / user-supplied keys / cloud broker? Resolved by an
   owner decision, not by more code reading.
2. **Is this installer a pilot vehicle or a customer product?** Resolved by owner intent. Determines
   whether the `QBO_ENV=sandbox` refusal is acceptable.
3. **Test count: 212 or 189?** Resolved by starting Postgres and running `npm test`.
4. **Three processes, not two.** The brainstorm's tray/watchdog design assumed Electron + Postgres.
   It must also supervise the Next.js server on 3000 and the pipeline service on 3001, or the two
   Node processes must be merged first. Resolved by an architecture decision before the spec.
