# Archived 2026-07-25 — superseded by the local desktop direction

Everything in this folder is **historical**. Do not build from it, do not treat it as a plan, and do
not restore any of it without an explicit decision from the owner.

Authoritative documents now live at:

- `architecture-decision-packet-ap-hub-local-desktop-2026-07-25.md` (repo root)
- `specs/SPEC-local-desktop-shell.md`
- `specs/reference/**` — **not archived**; still the grounding evidence
- `docs/audits/architecture-map-2026-07-25.md` — the forensic map that justified this archive

## What is here and why it was archived

| Path | What it was | Why archived |
|---|---|---|
| `specs/SPEC-windows-local-only-runtime.md` | The in-flight build target as of 2026-07-25 | Kept the product in a browser at `127.0.0.1:3000`; the product is now a desktop application |
| `specs/01–07_CHUNK_*.md` | Chunk specs for the above | Superseded. CHUNK_1 (credential manager) and CHUNK_6 (watchdog/install) content is carried forward into the new plan; CHUNK_2 (loopback HTTP session) is dropped because IPC removes the need for it |
| `specs/SPEC-multi-edition-accounting-intake.md` | Multi-edition QuickBooks intake | **Built** — commits `5ee925d`…`ceee181`. Retained as a record, not a plan |
| `specs/SPEC-northstar-ux-v1.md`, `SPEC-guided-onboarding-installer.md`, `SPEC-onboarding-real-connect-redesign.md`, `SPEC-reviewer-dashboard.md` | UX and onboarding specs | **Built**. The onboarding flow they describe is replaced by the eight-screen discovery wizard in phase P3 |
| `specs/SPEC-pilot-harness-key-broker.md` | Pilot harness + hosted key broker | The hosted broker is removed from the product |
| `ralph-workspaces/*` | Four completed Ralph build workspaces | All four read `BUILD COMPLETE`. Historical logs an agent could mistake for live plans |
| `packets/*` | Two earlier architecture decision packets | Superseded by the 2026-07-25 packet |
| `IMPLEMENTATION_PLAN.md` | Plan for the Windows local-only runtime | Replaced by the P1 plan at the repo root |
| `broker/` | Hosted key broker (Render web service + Postgres) | The product has no public AP-Hub URL and no mandatory cloud service. `BROKER_BASE_URL` was already optional; local model detection and user-supplied keys replace it |
| `compose.yaml` | Docker Compose PostgreSQL for development | The product bundles a private PostgreSQL. For local development, point `DATABASE_URL` at any PostgreSQL 16 instance |

## Retained from this era (still live in the repo)

The commits `78c5522`, `eb150e0` and `fef9d43` (`cbv-loc001`) are **kept**. They implement Windows
Credential Manager secret storage (`src/host/windows.ts`), the credential-reference schema
(`migrations/013`), and legacy-secret migration (`src/host/secret-migration.ts`). All three carry
forward unchanged into the desktop architecture, which still stores provider tokens in the OS
credential store.
