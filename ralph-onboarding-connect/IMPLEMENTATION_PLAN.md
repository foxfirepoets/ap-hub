# IMPLEMENTATION_PLAN.md

Project: onboarding-real-connect-redesign — real Gmail/QuickBooks OAuth wiring for ap-hub's
onboarding wizard, collapsing it to ~2 real required actions. FULL tier — touches real
auth/OAuth-adjacent surfaces.
Brownfield: DO NOT touch `src/qbo/write.ts`, `src/gatekeeper/forwarder.ts`, `src/pipeline/**`,
or the OAuth exchange logic itself (`exchangeGmailCode`, `exchangeQboCode`,
`assertExpectedCompany`, `saveToken` — reused unchanged). No schema/migration change anywhere.
Validation gate (every chunk): `npm run migrate:up && npm run lint && npm run typecheck && npm test && npm run web:build`
— must exit 0; `test/onboarding.test.ts` (11 tests) must pass unmodified throughout.

## Chunk Order

1. CHUNK_1_STATETOKEN — signed, time-boxed CSRF state token for the connect flow.
2. CHUNK_2_REDIRECT — redirect capability in the plain HTTP server; wire signed state + redirect into the OAuth callbacks.
3. CHUNK_3_CONFIG — fix the port collision between the pipeline HTTP server and Next.js.
4. CHUNK_4_STARTROUTES — session-gated Next.js routes that redirect into the real OAuth consent flow.
5. CHUNK_5_PAGEREDESIGN — collapse the wizard to one "Connect your accounts" screen; auto-complete the rest; final gate.

---

## Chunk 1: CHUNK_1_STATETOKEN
### Tasks (in order)
1. Create `src/auth/connect-state.ts` exporting `signConnectState(tenantId: number, now?: () => number): string` and `verifyConnectState(token: string, now?: () => number): { tenantId: number } | null`. Token = `base64url(tenantId + '.' + timestamp + '.' + nonce) + '.' + hmacSignature`, HMAC-SHA256 keyed by `config().SESSION_COOKIE_SECRET`. `verifyConnectState` recomputes the HMAC and checks it matches (constant-time compare, e.g. `crypto.timingSafeEqual`), then checks `timestamp` is within 5 minutes of `now()` (default `Date.now`), returning `null` on any failure (bad signature, expired, malformed). Accept an optional `now` function in both so tests can control the clock without real sleeps.
2. Create `test/connect-state.test.ts` (Vitest, no DB needed): happy path round-trip; tampered token → null; expired (inject a `now` 5min+1s later) → null; wrong-secret (mock `config()` to return a different `SESSION_COOKIE_SECRET` between sign and verify) → null.
### Validation
- Command: `npm run lint && npm run typecheck && npm test && npm run web:build`
- Expected: exit 0, all tests green (new connect-state tests + all pre-existing)
### Promise
<promise>CHUNK COMPLETE: CHUNK_1_STATETOKEN</promise>

---

## Chunk 2: CHUNK_2_REDIRECT
### Tasks (in order)
1. Extend `src/http.ts`'s `Route` type / the `respond` mechanism so a route can issue a 302 redirect (e.g. add a second parameter `redirect: (location: string) => void` alongside `respond`, implemented as `res.writeHead(302, { Location: location }); res.end();`) without changing the existing JSON-body behavior of `respond` or the `/health` handler.
2. In `src/auth/gmail-oauth.ts`'s `handleGmailCallback`: accept the new `redirect` callback; call `verifyConnectState(url.searchParams.get('state') ?? '')` FIRST — on `null`, call `respond(400, {...})` and return WITHOUT calling `exchangeGmailCode`. On a verified state, use its `tenantId` (not the raw query param) for `saveToken`/`writeAudit`. On success, call `redirect(\`${config().WEB_BASE_URL}/onboarding?connected=gmail\`)` instead of `respond(200, ...)`. On a handled failure (missing code, exchange throws), call `redirect(\`${config().WEB_BASE_URL}/onboarding?connect_error=gmail&reason=<code>\`)` instead of `respond(400, ...)`.
3. Same changes in `src/auth/qbo-oauth.ts`'s `handleQboCallback`, including the confirm-realm mismatch path (`assertExpectedCompany` throw) redirecting with `reason=wrong_company`.
4. Update `src/auth/routes.ts`'s route registration to pass the new `redirect` callback through from `src/http.ts`'s server to both handlers.
5. Extend or create integration tests (locate any existing test file covering `handleGmailCallback`/`handleQboCallback` first, prefer extending it) proving: valid state + valid code → token saved + redirect to `connected=gmail|qbo` observed; invalid state → 400, `exchangeGmailCode`/`exchangeQboCode` never called (spy/mock assertion), no token saved; QBO wrong-company → no token saved, redirect to `connect_error=qbo&reason=wrong_company`.
### Validation
- Command: `npm run lint && npm run typecheck && npm test && npm run web:build`
- Expected: exit 0, all tests green; `git diff` on `exchangeGmailCode`/`exchangeQboCode`/`assertExpectedCompany`/`saveToken`'s function bodies shows no behavioral change
### Promise
<promise>CHUNK COMPLETE: CHUNK_2_REDIRECT</promise>

---

## Chunk 3: CHUNK_3_CONFIG
### Tasks (in order)
1. In `src/config.ts`: change `PORT`'s default from `3000` to `3001`; change `GMAIL_REDIRECT_URI`'s default from `http://localhost:3000/oauth/gmail/callback` to `http://localhost:3001/oauth/gmail/callback`; change `QBO_SANDBOX_REDIRECT_URI`'s default from `http://localhost:3000/oauth/qbo/callback` to `http://localhost:3001/oauth/qbo/callback`. Do NOT change `WEB_BASE_URL`'s default (stays `http://localhost:3000` — that's the Next.js app's own port).
2. Check `test/config.test.ts` for any assertion of the old `3000`/`:3000` defaults for these three vars; update ONLY those specific assertions to the new values — no other change to that file.
3. Update `AGENTS.md` (repo root) and `ralph-onboarding-connect/AGENTS.md`/`README.ralph.md` (this workspace, if any port reference needs correcting after this chunk) to reflect `npm run dev` now defaulting to `:3001`.
### Validation
- Command: `npm run lint && npm run typecheck && npm test && npm run web:build`
- Expected: exit 0, all tests green (including the updated config default assertions)
### Promise
<promise>CHUNK COMPLETE: CHUNK_3_CONFIG</promise>

---

## Chunk 4: CHUNK_4_STARTROUTES
### Tasks (in order)
1. In `src/cli.ts` (or a new small shared module, e.g. `src/auth/connect-urls.ts`, imported by both `cli.ts` and the new routes — prefer the shared module to avoid duplicating URL-building), extract `buildGmailAuthorizeUrl(cfg: Config, state: string): string` and `buildQboAuthorizeUrl(cfg: Config, state: string): string` from the inline URL strings currently built in the `connect` command's action handler. Update `src/cli.ts`'s `connect` command to call these functions (passing a real signed state via `signConnectState` for a tenant id it already has via `--tenant`, replacing the currently-hardcoded `state=1` on the QBO branch).
2. Create `app/api/connections/gmail/start/route.ts`: resolve the session via the existing `requireSession`/session-cookie pattern used elsewhere in `app/api/**` (role: `owner_controller` only, 401/403 on failure), then `NextResponse.redirect(buildGmailAuthorizeUrl(config(), signConnectState(ctx.tenantId)))`.
3. Create `app/api/connections/qbo/start/route.ts` — same pattern, `buildQboAuthorizeUrl`.
4. Tests: session/role-gate tests for both routes (401 no session, 403 wrong role, 302 with correct `Location` shape for an owner — assert `client_id`/`redirect_uri`/`scope`/`state` are present and `state` round-trips via `verifyConnectState` to the right tenant id).
### Validation
- Command: `npm run lint && npm run typecheck && npm test && npm run web:build`
- Expected: exit 0, all tests green, `web:build` route count +2 versus the pre-CHUNK_4 baseline
### Promise
<promise>CHUNK COMPLETE: CHUNK_4_STARTROUTES</promise>

---

## Chunk 5: CHUNK_5_PAGEREDESIGN
### Tasks (in order)
1. In `app/(app)/onboarding/page.tsx`: replace the `connect_gmail`/`connect_qbo`/`select_company`/`configure_mode`/`automation_level`(intro) step bodies with ONE "Connect your accounts" screen rendering two `ConnectPrompt` blocks (Gmail, QuickBooks) — each linking to `/api/connections/gmail/start` / `/api/connections/qbo/start`, showing "Not connected" / "Connected ✓" from `state.connections.gmailConnected`/`qboConnected`.
2. Create `app/components/ConnectPrompt.tsx` — presentational, props for provider name/description/href/connected-state/error — the guided pop-up content (what will happen, why it's needed) shown inline per block.
3. On mount, read `?connected=gmail|qbo` and `?connect_error=gmail|qbo&reason=...` from the URL (Next.js `useSearchParams`); on `connected=`, immediately re-fetch `GET /api/onboarding` then strip the query param (`router.replace`); on `connect_error=`, surface a friendly message + retry link on the matching `ConnectPrompt` (extend or reuse the `friendlyOnboardingError` pattern from `app/lib/onboardingErrors.ts` if the reason codes fit, or add a small dedicated mapping for connect-specific reasons — do not touch `onboardingErrors.ts`'s existing behavior for the codes it already handles).
4. Add an effect: whenever `state.connections.gmailConnected && state.connections.qboConnected` are both true AND the step machine hasn't already progressed past them, automatically call `goStep` through the remaining intermediate values (`connect_qbo`, `select_company`, `configure_mode`, `automation_level` — all with no `automationLevel` argument, preserving the existing 'off' default) then `runDryRun()`, showing a brief "Setting up…" busy state meanwhile. This must run on every load where both are true (not only right after a `?connected=` redirect), covering a returning owner whose connections were already done.
5. Build the combined summary screen (shown once the automatic walk-through reaches `dry_run`'s completion): dry-run counts (reuse existing `DryRunSummary` rendering), inline `EvidencePanel` for a sample proposal, inline `RemapForm` (optional, not blocking), and a note "Automation is OFF — turn it on in Settings when you're ready" with a link. Do not add a separate screen requiring the user to explicitly choose an automation level.
6. Reconcile the existing `OnboardingStepper` (from the earlier guided-installer feature) with the new, shorter flow — adapt it to the new step set or remove it in favor of the simpler two-block screen if a 9-item stepper no longer makes sense; use judgment, favor simplicity over keeping a stepper that misrepresents the real flow.
7. Run the full gate: `npm run migrate:up && npm run lint && npm run typecheck && npm test && npm run web:build`. Confirm `web:build` route count is +2 versus the pre-CHUNK_4 baseline (no new page route added by this chunk itself). Confirm `git diff` on `src/qbo/write.ts`, `src/gatekeeper/forwarder.ts`, `src/pipeline/`, `migrations/` is empty for the WHOLE feature (all 5 chunks). Confirm `npx vitest run test/onboarding.test.ts` passes unmodified (11 tests).
### Validation
- Command: `npm run migrate:up && npm run lint && npm run typecheck && npm test && npm run web:build`
- Expected: exit 0, all tests green, route count +2, protected-file diff empty, test/onboarding.test.ts unmodified and green
### Promise
<promise>CHUNK COMPLETE: CHUNK_5_PAGEREDESIGN</promise>

---

## Build Complete
When all 5 chunks are done and validation is green, emit:
<promise>BUILD COMPLETE</promise>
Then run /HKO-truth-audit on the diff (FULL tier — take it seriously, this touches a real
auth/OAuth surface), fix any issues found, then push to GitHub (per operator instructions).
Explicitly disclose in the final report that no live Google/Intuit OAuth round-trip was executed
in this environment — code-level gates only.
