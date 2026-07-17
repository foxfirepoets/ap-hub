# CHUNK_8_DEPLOY: Deploy the broker to Render and roll out to one real machine

## Summary

Ship the broker to its real host (Render, via a config-reproducible blueprint kept portable per `ARCHITECTURE-ap-hub-platform.md` §7) and install the harness on one real, non-dev Windows machine to confirm the whole chain works end-to-end with live evidence. This is the only chunk whose "done" requires the deployed environment, not local green. One machine first, 48 h, before any other tester.

## Acceptance Criteria

- [ ] `broker/render.yaml` blueprint deploys the broker; env vars (`ANTHROPIC_API_KEY`, `SWARMSYNC_API_KEY`, `SWARMSYNC_API_BASE`, `SWARMSYNC_WEB_BASE`, `LOG_LEVEL`) set in the Render dashboard — **never in git**. `DATABASE_URL`/`PORT` auto-injected.
- [ ] Live `curl https://<svc>.onrender.com/health` → **200** `{status:"ok",db:true}`.
- [ ] `issue-token` for one install; harness installs on one real Windows machine; an authed `/v1/heartbeat` lands (confirm the `heartbeats` row).
- [ ] `grep` for `sk-ant`/`ssk_live` on that machine → **zero**; keys exist only in Render env.
- [ ] Kill switch verified live: `revoke --all` → the install's next broker call is refused.
- [ ] Every SPEC §3 acceptance criterion observed live, each with its artifact (HTTP response, DB row, screenshot, or log line).
- [ ] Ran 48 h on the one machine before any expansion is attempted.
- [ ] Existing suite ≥ 212, zero existing tests modified.
- [ ] All tests pass with zero failures.

## Endpoints / Interfaces

Deployment of the existing broker routes to a live HTTPS host. No new endpoints.

## Database Changes

No schema changes (Render provisions the broker Postgres; broker migrations from CHUNK_2 run against it).

## Test Scenarios

- **Happy path**: broker live on HTTPS; one machine installed; heartbeats + an extraction round-trip succeed.
- **Edge case**: Render free-tier cold start after idle → slow first call, but a proof cold-start **holds** (not fail-open).
- **Failure case**: `revoke --all` mid-run → the install is cut off within one request.
- **Integration**: this is the terminal chunk — its live evidence is the Definition of Done for the whole Phase 1A pilot.

## Dependencies

- **Requires**: CHUNK_7_HARNESS
- **Blocks**: None (Phase 1A complete; Phase 1B/1C/2 are separate specs)

## Completion Promise

<promise>CHUNK COMPLETE: CHUNK_8_DEPLOY</promise>
