# SPEC: Onboarding Redesign — Real Connect Buttons, Collapsed to 1-2 Required Actions

## Metadata
- Version: 1.0 | Date: 2026-07-15 | Tier: FULL | Greenfield/Brownfield: Brownfield (replaces most of CHUNK_6_ONBOARDING's step flow; reuses its backend almost entirely)
- Status: Ready for Build
- Success measure: A first-time owner opens `/onboarding`, does exactly two real actions (click "Connect Gmail", click "Connect QuickBooks" — each completing a real OAuth grant), and lands on a finished setup summary with zero additional required clicks. No screen asks them to do anything that isn't one of those two actions.
- Architecture grounding: fallback preflight (this session's own repo research, cited by file:line throughout) + `architecture-decision-packet-ap-hub-northstar-ux-2026-07-14.md` (verdict READY_FOR_SPEC, covers the broader northstar-ux-v1 initiative this feature extends) + `CLAUDE.md`'s documented architecture ("`src/index.ts` boots an HTTP server (`/health` + OAuth callbacks) and pg-boss workers" — OAuth callbacks are INTENTIONALLY on the pipeline process, not the Next.js web app; this spec follows that existing decision rather than relitigating it).
- Open questions: 2

## Tech Stack
Next.js App Router (existing `app/` tree, adds 2 new thin redirect routes) + the existing plain Node HTTP server (`src/http.ts`/`src/auth/routes.ts`, adds a redirect capability + reuses its existing OAuth exchange logic unchanged) + PostgreSQL (`oauth_tokens` table, no schema change) + TypeScript ESM + Vitest. No new runtime dependency.

## Architecture Grounding Summary

**Systems touched (new/modified):**
- `src/config.ts` — `PORT` default changes from `3000` to a distinct dev port (`3001`) to stop colliding with Next.js's `npm run web:dev` (:3000); `GMAIL_REDIRECT_URI`/`QBO_SANDBOX_REDIRECT_URI` defaults updated to match.
- `src/http.ts` — extend the `respond` capability with a redirect option (currently hardcodes JSON; confirmed by reading the file — `respond(status, body)` always writes `content-type: application/json`, no `Location` header path exists).
- `src/auth/gmail-oauth.ts` / `src/auth/qbo-oauth.ts` — after a successful token save, redirect the browser back to `${WEB_BASE_URL}/onboarding?connected=gmail|qbo` instead of returning a bare JSON body. The token-exchange logic itself (`exchangeGmailCode`, `exchangeQboCode`, `assertExpectedCompany`, `saveToken`) is **reused unchanged**.
- **New:** `app/api/connections/gmail/start/route.ts`, `app/api/connections/qbo/start/route.ts` — thin, session-gated Next.js routes that build the Google/Intuit authorize URL (following the exact pattern already inline in `src/cli.ts`'s `connect` command, extracted into a shared helper) and 302-redirect to it. These mint a signed `state` param (see §9) instead of the current bare `tenantId`.
- `app/(app)/onboarding/page.tsx` — collapse `connect_gmail`/`connect_qbo`/`select_company`/`configure_mode`/`automation_level` (intro) into ONE "Connect your accounts" screen with two real buttons; auto-run dry-run once both connections are confirmed; auto-default `automation_level` to `'off'`; land on one combined summary screen.
- **New:** `app/components/ConnectPrompt.tsx` — the guided pop-up shown per connect action.

**Systems explicitly NOT touched:** `src/qbo/write.ts`, `src/gatekeeper/forwarder.ts`, `src/pipeline/**`, `migrations/**` (no schema change), the OAuth token-exchange logic itself, the `oauth_tokens` table, `src/services/onboarding.ts`'s `runOnboardingDryRun`/`assertNotDryRunLocked`/`isDryRunLocked` (called exactly as before, just triggered automatically instead of by a button), `app/api/onboarding/dry-run|step` (reused as-is; `step` is called with fewer distinct values, not a changed contract).

**Source of truth (fallback preflight, point 2):** `oauth_tokens` (one row per tenant+provider) remains the single source of truth for connection status — `state.connections.gmailConnected`/`qboConnected` already derive from it (`src/services/onboarding.ts`, confirmed unchanged). No second claimant introduced. `qboCompanySelected` was already derived automatically from the same row (research finding: `Boolean(tenants.qbo_realm_id ?? oauth_tokens.realm)`, true the instant the QBO token is saved with a realm) — this spec removes the now-redundant "Select company" SCREEN, not any data or logic; nothing new to reconcile.

**State machines (fallback preflight, point 3):** the wizard's `onboarding_state.step` enum (`connect_gmail | connect_qbo | select_company | configure_mode | automation_level | dry_run | review_sample | approve_rules | complete`) is UNCHANGED at the backend/database level — no migration, no new step value. This spec changes ONLY how many of those step values the UI stops on and shows a screen for; the client will programmatically walk through `connect_qbo`, `select_company`, `configure_mode`, `automation_level` without user interaction once both OAuth connections succeed (see §5, Flow A). This preserves full backward compatibility with `test/onboarding.test.ts`'s existing state-machine assertions (they operate on the API, not the removed screens).

**Money / auth / customer-data boundaries (fallback preflight, point 4) — why this is FULL tier:** this feature adds two new **auth-adjacent** surfaces (`app/api/connections/gmail/start`, `app/api/connections/qbo/start`) that redirect an authenticated session into a third-party OAuth consent flow, and modifies the callback side of that flow to add a signed CSRF `state` token (closing a pre-existing gap — see §9). No money movement, no QBO write, no new customer PII collected beyond what the existing OAuth scopes already grant (Gmail read-only, QBO accounting read/write scope already used for posting downstream — unchanged).

**Reuse decisions (fallback preflight, point 5) — the two things this spec does NOT rebuild:**
1. Gmail/QBO OAuth token exchange (`exchangeGmailCode`, `exchangeQboCode`, `assertExpectedCompany`, `saveToken`) — fully built, reused unchanged.
2. "Company selection" — confirmed NOT a real missing feature; it was already fully automatic. This spec removes a screen that was asking about something already decided, not implementing new logic.

**Must not break (fallback preflight, point 6 → regression tests, §10):**
- `test/onboarding.test.ts` (11 tests) — the state/discovery, step-persistence, dry-run, and DRY_RUN_LOCKED-guard tests must all still pass calling the SAME API surface (`GET /api/onboarding`, `POST /api/onboarding/step`, `POST /api/onboarding/dry-run`) exactly as before.
- The six repo-wide guarantees (`src/qbo/write.ts`/`src/gatekeeper/forwarder.ts`/`src/pipeline/**` untouched; sandbox-only; no double-post/forward; proof-gating; white-label).
- `QBO_ENV=sandbox` hard-refusal at config load (`src/config.ts`, unchanged).
- The existing `assertExpectedCompany` confirm-realm check (a wrong-company QBO connection must still be refused and stored nowhere — unchanged, just now surfaced via a redirect-with-error instead of a bare JSON error).

## Risks
- **Cross-process CSRF on the OAuth `state` param.** Today `state` is just the raw tenant id (`Number(url.searchParams.get('state') ?? '1')`, `gmail-oauth.ts:38`, `qbo-oauth.ts:61`) — trivially forgeable, and the CLI's `connect qbo` even hardcodes `state=1`. Because the "start" redirect (Next.js, session-gated) and the callback (plain HTTP server, different port) are two different processes, the existing same-origin-cookie CSRF pattern used by the login SSO flow (`sso_state` HttpOnly cookie, `src/auth/google-sso.ts`) cannot be reused directly. Mitigation: the "start" route mints a signed token (`HMAC-SHA256(tenantId + timestamp + nonce, SESSION_COOKIE_SECRET)`), passed as `state`; the callback verifies the signature and a short expiry window (5 minutes) before trusting `tenantId` from it — stateless, works across the two processes, no shared cookie needed. Test: a forged/expired/unsigned `state` is refused, connects nothing.
- **Port collision breaking existing dev workflows.** Changing `PORT`'s default to 3001 could break any existing script, README, or muscle-memory that assumes the pipeline HTTP server is on :3000. Mitigation: `AGENTS.md` and `README.ralph.md` updated; `/health` still reachable, just on the new port; this is a dev-time default only, production deploys already set `PORT` explicitly per environment (standard platform practice) and are unaffected.
- **Auto-triggering the dry-run removes the moment where a user consciously chooses to scan.** Mitigation: the dry-run is safe-by-construction (never posts, `proposeOnce` with no `enqueuePost`, already proven in CHUNK_6) — auto-running it is not a guarantee risk, only a UX choice, and the summary screen still shows exactly what it found before anything is "approved" (approve_rules stays available, just inline rather than gated).
- **Silently defaulting `automation_level` to `'off'` forever, with no wizard reminder to turn it on.** Mitigation: the summary screen includes a visible "Automation is OFF — turn it on in Settings when you're ready" link; this is explicitly the safer failure mode (nothing posts) versus the alternative (silently defaulting to `'assisted'`/`'auto'`, which this spec explicitly rejects in §2 Do Not Build).
- **`respond()`'s new redirect capability being misused elsewhere to leak an open redirect.** Mitigation: the redirect target is server-constructed from `config().WEB_BASE_URL` + a fixed path, never built from user-supplied input — no open-redirect surface. Test: attempt to smuggle a `?redirect=` or similar into the callback URL and confirm it has no effect on the redirect target.

---

## 1. Executive Summary

The current onboarding wizard (already reviewed and found lacking — see this session's earlier assessment) has "Connect Gmail" and "Connect QuickBooks" buttons that don't actually connect anything, plus 5 more screens for things that are either already automatic (company selection) or don't need to be separate clicks (mode/date range, an automation-level intro screen, a dry-run trigger, a review screen, an approve-rules screen). Meanwhile, real, tested Gmail/QBO OAuth exchange code already exists in the codebase — it's just running on a different server process than the wizard, disconnected from the UI. This spec wires them together: the wizard collapses to ONE screen with two real "Connect" buttons, each showing a guided pop-up explaining exactly what's about to happen; "Continue" only appears once both connections genuinely succeed (verified by re-fetching real state after each OAuth redirect completes); and everything after that — company confirmation (already automatic), a dry-run scan, and the initial safe (`off`) automation default — happens without further required clicks, landing the owner on one finished summary screen. Estimated build: 3-4 days of agent work (real OAuth wiring + a cross-process CSRF fix + a redesigned UI, more than the LEAN wrapper built earlier this session).

## 2. Scope & Do Not Build

**In scope:**
- `src/config.ts`: change `PORT` default to `3001`; change `GMAIL_REDIRECT_URI`/`QBO_SANDBOX_REDIRECT_URI` defaults to `http://localhost:3001/oauth/{gmail,qbo}/callback`.
- `src/http.ts`: extend `respond`/`Route` to support an HTTP redirect (302 + `Location` header) alongside the existing JSON-body path.
- `src/auth/gmail-oauth.ts` / `src/auth/qbo-oauth.ts`: on success, redirect to `${WEB_BASE_URL}/onboarding?connected=gmail|qbo`; on failure (including a confirm-realm mismatch), redirect to `${WEB_BASE_URL}/onboarding?connect_error=gmail|qbo&reason=<code>` instead of a bare JSON error. Verify (sign/expire) the new `state` token before trusting `tenantId` from it (§9).
- **New** `src/auth/connect-state.ts` (or similar): `signConnectState(tenantId)` / `verifyConnectState(token)` — the HMAC state helper shared by the two new "start" routes and the two callback handlers.
- **New** `app/api/connections/gmail/start/route.ts`, `app/api/connections/qbo/start/route.ts`: session-gated (owner only), build the authorize URL (extracting/reusing the logic already inline in `src/cli.ts`'s `connect` command into one shared helper both the CLI and these routes call — no duplicated URL-building), sign the `state`, 302-redirect.
- `app/(app)/onboarding/page.tsx`: replace the `connect_gmail`/`connect_qbo`/`select_company`/`configure_mode`/`automation_level`(intro) screens with ONE "Connect your accounts" screen. On mount, if the URL has `?connected=gmail|qbo`, re-fetch state immediately (strip the query param after). Once BOTH `state.connections.gmailConnected` and `qboConnected` are true, automatically: walk the step machine to `dry_run` (calling the existing `POST /api/onboarding/step` for each intermediate value — no new endpoint), auto-run the dry-run (`POST /api/onboarding/dry-run`, reusing `runDryRun` unchanged), then land on ONE combined summary screen showing: the dry-run counts (existing `DryRunSummary` rendering), an inline "Review a sample" (existing `EvidencePanel`), an inline "Approve initial rules" (existing `RemapForm`), and a note that automation is off with a Settings link — no further required clicks; approve-rules stays optional (the user can leave it and it's still safely `off`).
- **New** `app/components/ConnectPrompt.tsx` — the guided pop-up: shown inline within the "Connect your accounts" screen, one block per connection (not a separate click-through modal-before-the-button — Open Question #1 resolves this as inline, not modal-over-modal, to avoid one extra click per connection), each block showing what will happen ("You'll sign in with Google and grant AP Hub read-only access to one mailbox — you'll land right back here") and the real Connect button/link (`<a href="/api/connections/gmail/start">Connect Gmail</a>`), with a live status chip (Not connected / Connecting… / Connected ✓) once the redirect returns.
- Small helper extraction: `buildGmailAuthorizeUrl(cfg)` / `buildQboAuthorizeUrl(cfg, state)` shared by `src/cli.ts` and the two new "start" routes (single source of truth for the URL shape — currently duplicated informally between the CLI's inline string and what a route would need).

### Do Not Build
- **No change to `src/qbo/write.ts`, `src/gatekeeper/forwarder.ts`, or `src/pipeline/**`** — out of scope; none of the six guarantees are touched by this feature.
- **No change to the OAuth token-exchange logic itself** (`exchangeGmailCode`, `exchangeQboCode`, `assertExpectedCompany`, `saveToken`) — reused exactly as-is; this spec only changes what happens to the HTTP response after a call that already succeeds/fails today.
- **No new "select company" picker UI** — confirmed unnecessary; company selection was already fully automatic via the confirm-realm check.
- **No schema/migration change** — `oauth_tokens`/`onboarding_state` unchanged.
- **No automatic `automation_level` default other than `'off'`** — silently enabling auto-posting without an explicit later choice would weaken the existing DRY_RUN_LOCKED safety guarantee; explicitly rejected.
- **No "recovery key" step** — still N/A, per the owner's earlier decision; no such concept exists in this app.
- **No removal of the CLI `connect` command** — kept as an operator diagnostic/fallback path, now sharing its URL-building logic with the new routes rather than duplicating it.
- **No change to `test/onboarding.test.ts`'s existing assertions about the step-machine API contract** — those tests exercise `POST /api/onboarding/step` directly and must keep passing unmodified; this feature only changes what the BROWSER does automatically, not the API's shape.

## 3. Business Context & Acceptance Criteria

**Goal:** a first-time owner does exactly 2 real actions (Connect Gmail, Connect QuickBooks) and nothing else is required to reach a working, safely-configured (automation off) setup.

**Success target:** every acceptance criterion below observably holds; there is no live analytics system to instrument a usage metric (same honest limitation as the earlier LEAN spec — see §16).

**Acceptance criteria (machine-verifiable):**
- [ ] The onboarding page shows exactly ONE screen requiring user action before automatic completion: "Connect your accounts", with two real, distinct Connect actions — FAIL if a third required click (other than the two connects) exists before the summary screen.
- [ ] Clicking "Connect Gmail" navigates to a real Google OAuth consent URL built from `GMAIL_CLIENT_ID`/`GMAIL_REDIRECT_URI` with a signed `state` — FAIL if the link is inert/decorative or points at nothing.
- [ ] Completing the Google consent flow redirects back to `/onboarding?connected=gmail`, and `state.connections.gmailConnected` becomes `true` in the very next `GET /api/onboarding` — FAIL if the connection isn't reflected without a manual page refresh initiated by the user beyond what the redirect itself causes.
- [ ] Same for "Connect QuickBooks" / `connected=qbo` / `qboConnected`.
- [ ] An invalid/expired/forged `state` on either callback is refused (no token saved, `connected: false` in the redirect's error state) — FAIL if a forged tenant id can connect another tenant's account.
- [ ] A QBO connection to the wrong company (confirm-realm mismatch) redirects with an error and connects nothing — FAIL if a mismatched company's token is ever saved (regression test for the EXISTING `assertExpectedCompany` behavior, now reached via redirect instead of bare JSON).
- [ ] Once both connections are `true`, the dry-run runs automatically with zero additional required clicks, landing on one summary screen — FAIL if the user must click anything else to reach it.
- [ ] The summary screen shows the dry-run's real counts (emails/invoices/vendors/proposals), matching what `POST /api/onboarding/dry-run` actually returned — FAIL if any count is hardcoded/fabricated.
- [ ] `automation_level` is `'off'` on the summary screen with no separate choice screen having been shown — FAIL if the wizard ever silently sets it to `'assisted'`/`'auto'` without an explicit later action outside this flow.
- [ ] `npm run web:build` compiles; route count increases by exactly 2 (`app/api/connections/gmail/start`, `app/api/connections/qbo/start`) — FAIL on any other route-count delta.
- [ ] `test/onboarding.test.ts` (11 tests) passes unmodified — FAIL if any needed a change (would mean the API contract broke).
- [ ] The pre-existing `assertExpectedCompany`/OAuth-exchange unit tests (wherever they currently live — locate and confirm during build) pass unmodified.

## 4. Architecture & System Integration

```
[browser, session-gated] click "Connect Gmail"
  -> GET /api/connections/gmail/start  (Next.js, :3000)
       - verifies owner session
       - signs state = HMAC(tenantId + ts + nonce, SESSION_COOKIE_SECRET)
       - 302 -> https://accounts.google.com/o/oauth2/v2/auth?...&state=<signed>

[Google consent screen, external]
  -> 302 -> http://localhost:3001/oauth/gmail/callback?code=...&state=<signed>
       (plain HTTP server, src/http.ts / src/auth/routes.ts)

[plain HTTP server, :3001]
  handleGmailCallback:
    - verifyConnectState(state) -> tenantId, or refuse (400, no redirect target trusted)
    - exchangeGmailCode(code)      [UNCHANGED]
    - saveToken(tenantId, 'gmail', ...)  [UNCHANGED]
    - writeAudit(...)               [UNCHANGED]
    - 302 -> ${WEB_BASE_URL}/onboarding?connected=gmail   [NEW]

[browser] lands back on /onboarding?connected=gmail
    -> page.tsx detects the query param, re-fetches GET /api/onboarding [EXISTING endpoint, unchanged]
    -> state.connections.gmailConnected === true
    -> (same flow, independently, for QuickBooks)
    -> once BOTH true: walk step machine + auto-run dry-run [EXISTING service calls, unchanged]
    -> summary screen
```

Two processes remain, per the existing documented architecture (`CLAUDE.md`): `npm run dev` (pipeline + OAuth callbacks + pg-boss workers, now on :3001 by default) and `npm run web:dev` (the human UX, :3000). New infra: none (no new DB table, no new external service).

## 5. User Flows & Happy Path

**Flow A — First-time owner, both connections succeed.** Actor: `owner_controller`. Precondition: session valid, no `onboarding_state` row (or one at `connect_gmail`). Steps: 1) Land on `/onboarding` → welcome overlay (from the earlier LEAN feature, unchanged) → "Get Started" → the single "Connect your accounts" screen, two `ConnectPrompt` blocks, both "Not connected". 2) Click "Connect Gmail" → real Google OAuth → redirected back with `?connected=gmail` → block shows "Connected ✓". 3) Click "Connect QuickBooks" → real Intuit OAuth → confirm-realm passes → redirected back with `?connected=qbo` → block shows "Connected ✓". 4) The instant both are true, the page automatically calls `POST /api/onboarding/step` through the remaining intermediate values and `POST /api/onboarding/dry-run`, showing a brief "Setting up…" state, then the summary screen. Postcondition: `automationLevel === 'off'`, ≥1 proposal exists, 0 postings.

**Flow B — QBO connects to the wrong sandbox company.** Actor: `owner_controller`. Precondition: Gmail already connected. Steps: click "Connect QuickBooks" → picks a company in the Intuit consent screen that doesn't match `QBO_SANDBOX_COMPANY_NAME` → `assertExpectedCompany` throws (existing, unchanged) → callback redirects to `/onboarding?connect_error=qbo&reason=wrong_company` instead of `connected=qbo`. Postcondition: no QBO token saved (existing behavior); the QuickBooks `ConnectPrompt` block shows a friendly error (reusing `friendlyOnboardingError`-style copy from the earlier LEAN feature) naming the mismatch and offering "Try again".

**Flow C — Forged/expired `state`.** Actor: attacker (no valid session, or replaying an old link). Steps: hits `/oauth/gmail/callback?code=x&state=<garbage-or-expired>` directly. `verifyConnectState` fails the signature or expiry check → callback refuses (400, no token saved, no redirect to a "connected" state — redirects to a generic error page/state instead, never implying success). Postcondition: no `oauth_tokens` row created or modified for any tenant.

**Flow D — Returning owner, one connection already done from a prior session.** Actor: `owner_controller`. Precondition: `gmailConnected === true` already (e.g. connected yesterday), `qboConnected === false`. Steps: land on `/onboarding` → welcome overlay → "Connect your accounts" screen shows Gmail already "Connected ✓" (no action needed), QuickBooks still "Not connected". Only one real action remains. Postcondition: same auto-completion once the second connection lands.

## 6. Data Models & Schema
No schema changes. `oauth_tokens` (existing, `migrations/001_init.sql`) already has everything needed (`tenant_id`, `provider`, encrypted tokens, `realm`). The new signed `state` token is NOT persisted anywhere — it's a stateless, short-lived (5 minute expiry embedded in the signature payload) value that exists only in the URL round-trip between the "start" route and the callback.

`state` token shape (not DB — a URL query value): `base64url(tenantId + '.' + timestamp + '.' + nonce) + '.' + hmacSignature`, verified by recomputing the HMAC with `SESSION_COOKIE_SECRET` and checking `timestamp` is within 5 minutes of now.

## 7. Error Handling & Edge Cases

| Scenario | Status/Redirect | Response / Recovery |
|---|---|---|
| Owner clicks Connect while not signed in / session expired | 401 at `/api/connections/*/start` | Redirects to `/login` (existing session-guard pattern) before ever reaching Google/Intuit. |
| Non-owner (`bookkeeper`/`cpa`) hits `/api/connections/*/start` directly | 403 | No redirect to the OAuth provider; existing non-owner onboarding gate copy shown if they land on `/onboarding` itself. |
| Google/Intuit consent denied by the user | Provider-specific `error=access_denied` on the redirect back to the callback | Callback detects no `code`, redirects to `/onboarding?connect_error=gmail\|qbo&reason=denied`; `ConnectPrompt` shows "You'll need to allow access to continue" + retry link. |
| Forged/expired `state` | Callback refuses before touching `code`/token exchange | 400 to the browser at the callback origin (no useful redirect target can be trusted); `oauth_tokens` untouched. See Flow C. |
| QBO confirm-realm mismatch | Existing `assertExpectedCompany` throw, now redirected | `/onboarding?connect_error=qbo&reason=wrong_company`; existing `raiseException({reasonCode:'auth_failure',...})` call unchanged. |
| Token exchange itself fails (network/provider outage) | Existing catch block, now redirected | `/onboarding?connect_error=gmail\|qbo&reason=exchange_failed`; retryable — same "Try again" pattern as the earlier LEAN feature's `friendlyOnboardingError`. |
| User re-clicks "Connect Gmail" after already connected | No guard needed — re-running the OAuth flow just overwrites the same `oauth_tokens` row (existing `saveToken` upsert behavior, unchanged) | Harmless; `ConnectPrompt` already shows "Connected ✓" so there's no reason to click again, but nothing breaks if they do. |
| Both connections already true on page load (Flow D) | — | The auto-advance logic runs immediately on mount, not gated on a fresh `?connected=` param — checked from `state.connections` directly. |

**Edge cases:** the `?connected=`/`?connect_error=` query params are read once on mount and stripped from the URL (via `history.replaceState` or a Next.js router replace) so a page refresh doesn't re-trigger the same branch spuriously.

## 8. Performance & Scalability
N/A — a single-tenant, single-user redirect flow; no new query load beyond the existing `GET /api/onboarding` re-fetch (already happens today on every `load()` call). OAuth round-trips are bounded by Google/Intuit's own latency, not this code.

## 9. Security & Compliance
- **CSRF on `state` (the core hardening this spec adds):** see §"Risks" above — a signed, time-boxed token replaces the bare tenant id. Verification happens server-side on the callback before any token exchange is attempted; an invalid token never reaches `exchangeGmailCode`/`exchangeQboCode`.
- **No open redirect:** the post-callback redirect target is always `${WEB_BASE_URL}/onboarding` + a fixed, code-controlled query shape (`connected=gmail|qbo` or `connect_error=...&reason=...`) — never built from attacker-supplied input.
- **Secrets:** `SESSION_COOKIE_SECRET` (already exists, reused as the HMAC key — no new secret introduced) stays server-side only, never sent to the browser. `GMAIL_CLIENT_SECRET`/`QBO_SANDBOX_CLIENT_SECRET` remain used only in the plain HTTP server's existing exchange functions, unchanged, never exposed client-side (the "start" routes build the authorize URL with only the public `client_id`, which is not a secret).
- **Access control:** both new "start" routes require an authenticated `owner_controller` session (mirrors the existing onboarding page's role gate) — a bookkeeper/CPA cannot even reach the OAuth redirect.
- **Compliance:** none formal (sandbox data, no real payments) — same honesty note as the LEAN spec.

## 10. Testing Strategy

- **Unit (Vitest, no DB):** `signConnectState`/`verifyConnectState` — valid round-trip, tampered signature rejected, expired timestamp rejected, wrong-secret rejected. `buildGmailAuthorizeUrl`/`buildQboAuthorizeUrl` — correct client_id/redirect_uri/scope/state present in the output URL.
- **Integration (Vitest + real DB, extending the existing test infra):** `handleGmailCallback`/`handleQboCallback` with a valid signed state → token saved, redirect target asserted (`respond`'s new redirect path, mocked/inspected). With a forged/expired state → no token saved, no success redirect. QBO confirm-realm mismatch → no token saved, error redirect. These exercise the SAME functions already covered by whatever existing tests cover `gmail-oauth.ts`/`qbo-oauth.ts` today (builder must locate and extend those, not create a parallel suite).
- **Regression (must-not-break, existing suite unchanged):** `test/onboarding.test.ts` (11 tests) — run unmodified. Full gate `npm run lint && npm run typecheck && npm test && npm run web:build` green.
- **Manual/visual verification (documented, honest limit, same as the LEAN spec):** run `npm run dev` (now on :3001) AND `npm run web:dev` (:3000) together, visit `/onboarding`, click through a real (test-mode) Google/Intuit consent flow if credentials are available in this environment; if not, this step is explicitly disclosed as NOT executable in this sandbox and must be verified by the owner before shipping (see §14 residual risk).

## 11. Deployment & Rollout
Two processes, as today: `npm run dev` (now `PORT=3001` by default in dev; production sets `PORT` explicitly per the hosting platform, unaffected) and `npm run web:dev`/`npm run build && npm start` for the Next.js app. Env changes required before this ships: `GMAIL_REDIRECT_URI`, `QBO_SANDBOX_REDIRECT_URI`, and (if not already set) `SESSION_COOKIE_SECRET`, `WEB_BASE_URL` must be correct for the target environment — same variables that already exist, values updated for the new port. Rollback = revert the commit; no migration to undo.

## 12. API Documentation

```
GET /api/connections/gmail/start — Auth: session, owner_controller only
  302 -> Google OAuth consent URL (state signed server-side)
  401 UNAUTHENTICATED | 403 FORBIDDEN (non-owner)

GET /api/connections/qbo/start — Auth: session, owner_controller only
  302 -> Intuit OAuth consent URL (state signed server-side)
  401 UNAUTHENTICATED | 403 FORBIDDEN (non-owner)

GET /oauth/gmail/callback (plain HTTP server, :3001, existing path — behavior extended)
  Req: ?code=<...>&state=<signed>
  302 -> {WEB_BASE_URL}/onboarding?connected=gmail  (success)
  302 -> {WEB_BASE_URL}/onboarding?connect_error=gmail&reason=<code>  (failure)
  400 (state verification failure only — no trusted redirect target)

GET /oauth/qbo/callback (plain HTTP server, :3001, existing path — behavior extended)
  Req: ?code=<...>&state=<signed>&realmId=<...>
  302 -> {WEB_BASE_URL}/onboarding?connected=qbo  (success)
  302 -> {WEB_BASE_URL}/onboarding?connect_error=qbo&reason=<code>  (failure, incl. wrong_company)
  400 (state verification failure only)
```
`GET /api/onboarding`, `POST /api/onboarding/step`, `POST /api/onboarding/dry-run` — all EXISTING, unchanged contract, called by the client automatically instead of by button clicks for the intermediate steps.

## 13. Database Migrations
N/A — no schema change anywhere in this feature. Verification: `git diff` touches no file under `migrations/`.

## 14. Known Limitations, Open Questions & Future Work

**Limitations:** the "guided pop-up" is inline on the single connect screen, not a separate click-through modal per action (see Open Question #1) — if the owner wants a literal modal that appears only after clicking, that's a small follow-up change, not a rebuild. This environment cannot execute a real Google/Intuit OAuth consent round-trip during automated verification (no live test credentials in this sandbox) — the OAuth-adjacent code paths are proven via unit/integration tests against the exchange functions and the state-signing logic, but the true end-to-end browser flow needs manual verification by the owner (or in a staging environment with real OAuth app credentials) before this is considered launch-ready. This is a testing-strategy honesty limit, not a design gap — flagged explicitly per spec-superstar's rules rather than glossed over.

**Open Questions (2):**
1. **Inline vs. modal-per-click "guided pop-up."** This spec defaults to inline blocks on one screen (fewer clicks, matches "1-2 things" framing tightly). Resolution action: if a literal modal-that-appears-on-click is wanted instead, it's a small follow-up to `ConnectPrompt.tsx`, not a scope change. Not blocking — safe default chosen.
2. **Dev-port change to 3001.** Resolution action: if a different port is preferred (e.g. because something else on the team's machines already uses 3001), change the one config default before build — trivial to adjust, flagged here so it's a conscious choice rather than a silent pick.

**Future work:** a real component-level/Playwright test that can mock the Google/Intuit OAuth redirect end-to-end (would close the manual-verification gap in §10); extending the same "guided connect" pattern to re-authing an expired token from Settings, not just first-time onboarding.

## 15. Glossary
- **"start" route:** the new thin Next.js route that redirects the browser to the real OAuth provider.
- **callback:** the existing plain-HTTP-server route that receives the OAuth provider's redirect-back and completes the token exchange (unchanged logic, extended response).
- **state (OAuth param):** not React state — the signed CSRF token round-tripped through the OAuth provider, distinct from React's `useState`.

## 16. Monitoring & Metrics
N/A — no analytics system exists in this repo for UI interactions, same as the LEAN spec. `writeAudit` calls (`gmail.connect`, `qbo.connect`, already existing) remain the durable record of a successful connection, queryable via the existing Audit Trail page.

## 17. Alternative Designs Considered
1. **Move Gmail/QBO OAuth entirely into the Next.js process** (own the callback there too) — considered, rejected: contradicts `CLAUDE.md`'s already-documented architecture ("`src/index.ts` boots an HTTP server (`/health` + OAuth callbacks)..."), and would mean duplicating/relocating already-tested exchange logic for no functional gain — this spec's cross-process signed-state approach solves the actual problem (CSRF, port collision, dead-end callback) without moving working code.
2. **A separate "select company" screen with a real picker**, in case a QBO account has multiple companies — rejected: the existing `assertExpectedCompany` design intentionally hard-fails on any company but the one configured in `QBO_SANDBOX_COMPANY_NAME`; there is nothing to "pick" in this build's model (config-driven, white-label §6 guarantee), so a picker UI would be decorative.
3. **A literal per-click modal for the guided pop-up** — considered for Open Question #1; deferred to a smaller follow-up rather than blocking this spec on a UX preference.

## 18. Build Phases & Final Checklist

### Build Phases
1. **CSRF-safe state token** — `src/auth/connect-state.ts` (`signConnectState`/`verifyConnectState`) + unit tests. Verifiable: round-trip + tamper/expiry rejection tests green.
2. **Redirect capability in the plain HTTP server** — extend `src/http.ts`'s `Route`/`respond` to support a 302 redirect; update `src/auth/gmail-oauth.ts`/`qbo-oauth.ts` to verify `state` via phase 1 and redirect on success/failure instead of returning bare JSON. Verifiable: integration tests confirm the exchange logic is untouched, only the response path changed; existing gmail/qbo-oauth tests (wherever they live) still pass.
3. **Config port/redirect-URI fix** — `src/config.ts` defaults (`PORT=3001`, updated `GMAIL_REDIRECT_URI`/`QBO_SANDBOX_REDIRECT_URI`); `AGENTS.md`/`README.ralph.md` updated. Verifiable: `npm run migrate:up && npm run lint && npm run typecheck && npm test` still green with the new defaults; `src/config.test.ts` (existing) extended if it asserts the old default.
4. **New Next.js "start" routes** — `app/api/connections/gmail/start/route.ts`, `.../qbo/start/route.ts`, plus the shared `buildGmailAuthorizeUrl`/`buildQboAuthorizeUrl` helpers (also wired into `src/cli.ts`'s existing `connect` command so there's one source of truth for the URL shape). Verifiable: session/role-gate tests (401/403), URL-shape unit tests.
5. **Onboarding page redesign** — collapse the 5 screens into one "Connect your accounts" screen + `ConnectPrompt.tsx`; wire `?connected=`/`?connect_error=` handling; auto-walk the step machine + auto-run dry-run once both connections are true; combined summary screen (dry-run counts + inline EvidencePanel + inline RemapForm + automation-off notice). Verifiable: every §3 acceptance criterion; `web:build` route count +2; `test/onboarding.test.ts` unmodified and green.
6. **Full gate + guarantee check** — `npm run migrate:up && npm run lint && npm run typecheck && npm test && npm run web:build`; `git diff` empty on `src/qbo/write.ts`/`src/gatekeeper/forwarder.ts`/`src/pipeline/**`/`migrations/**`.

### Build Checklist
- [ ] Signed `state` token: valid/tamper/expiry all correctly handled
- [ ] Redirect capability added to `src/http.ts` without breaking `/health` or existing JSON responses
- [ ] `PORT`/redirect-URI defaults updated consistently across config, docs, and any script that assumes :3000 for the pipeline server
- [ ] Two new "start" routes, owner-gated, sharing URL-building logic with the CLI (no duplication)
- [ ] Onboarding page: exactly 2 required actions before auto-completion
- [ ] `assertExpectedCompany` mismatch still refuses/stores nothing (regression-tested via the new redirect path)
- [ ] `automation_level` defaults to `'off'` with no separate choice screen
- [ ] No file outside this spec's listed scope touched (`git diff` clean on the six-guarantee files + migrations)
- [ ] `npm run lint && npm run typecheck && npm test && npm run web:build` green; `test/onboarding.test.ts` unmodified

```markdown
DONE means ALL true, with an artifact per item (redirect observed, DB row, test output, git diff):
1. Each §3 acceptance criterion, observed via the test suite (§10) plus, where the sandbox
   cannot execute a real OAuth round-trip, an explicit owner sign-off after manual verification
   in an environment with real Google/Intuit test credentials.
NOT done if:
- Verified only by reading the component/route code ("looks right")
- Any of the six guarantee-bearing files show a diff
- test/onboarding.test.ts needed a change to keep passing
- The manual OAuth round-trip was never actually attempted by a human before calling this shipped
```

```markdown
The building agent must:
- [ ] Read this spec + the Architecture Grounding Summary before writing code
- [ ] Produce a plan/file-tree first — not code
- [ ] Test every "must not break" item before marking any phase complete
- [ ] Treat the Definition of Done above as the ONLY completion signal
- [ ] Stop and escalate if backend/guarantee scope creep is at risk — never build around it
- [ ] Attach a concrete artifact per done condition (test output, web:build output, git diff)
- [ ] Explicitly disclose that the true end-to-end OAuth round-trip needs human verification with
      real provider credentials — never claim that gap is closed by unit/integration tests alone
```
