# CHUNK_6_CLEANUP: Remove every hosted dependency and technical surface the user could ever see.

## Summary

Deletes the hosted key broker, defaults SwarmSync off, and replaces the error surface with
exhaustive plain-language mapping that has **no raw-message fallback**. It comes after the
functional chunks because it removes the paths they replaced, and it must not run before there is
something to fall back to. It hands the final chunks a product with no hosted dependency and no
technical vocabulary in the UI.

## Acceptance Criteria

- [ ] `BROKER_BASE_URL` and `BROKER_INSTALL_TOKEN` are removed from `src/config.ts` and `.env.example`; broker branches are deleted from `src/extract/model.ts`, `src/services.ts` and `src/telemetry.ts`, keeping the direct and local-runtime paths.
- [ ] `grep -rn "BROKER_" src/ app/` returns **zero** results.
- [ ] No runtime path contacts a hosted AP-Hub URL — proven by `test/no-hosted-dependency.test.ts`.
- [ ] `SWARMSYNC_ENABLED` defaults to **false**; a fresh install makes zero outbound SwarmSync requests.
- [ ] The three disabled/unavailable rules are implemented: optional-for-this-company → `noop`; required-by-policy → **review** plus a typed exception; and an unscanned item is **never** labelled "independently verified".
- [ ] `proof_fail_safe` is extended with the required-by-policy case and the never-label-verified case.
- [ ] `app/lib/onboardingErrors.ts` maps every reachable error to plain language, and the `Details: ${fallbackMessage}` raw fallback at line 34 is **deleted**.
- [ ] `test/error-mapping.test.ts` asserts that **no raw fallback path exists** — not merely that the mapping is populated.
- [ ] No provider message, stack trace, error code, port number, environment-variable name or SQL text can reach the UI.
- [ ] Telemetry is local-only; the support export is explicit and redacted.
- [ ] All tests pass with zero failures (`npm run verify` exits 0).

## Endpoints / Interfaces

No new interfaces. This chunk **removes** surfaces:

| Removed | Replaced by |
|---|---|
| Hosted key broker (`BROKER_*`) | Local credential store + the user's own key under Advanced, or a detected local runtime |
| Broker telemetry path | Local rotating JSON logs + explicit redacted support export |
| Raw error fallback | Exhaustive mapped plain language |

Every mapped code from spec §7 must resolve: `PROVIDER_REAUTH`, `PROVIDER_OFFLINE`, `DB_STARTING`,
`DB_FAILED`, `ENGINE_UNSTABLE`, `CONNECT_TIMEOUT`, `SECURE_STORE`, `DISK_FULL`, `BACKUP_FAILED`,
`BACKUP_KEY_MISSING`, `RESTORE_FAILED`.

## Database Changes

No schema changes in this chunk.

## Test Scenarios

- **Happy path**: a default install runs extraction with no broker, no key and no network beyond the connected providers, and makes zero SwarmSync calls.
- **Edge case**: a company whose policy *requires* SwarmSync, with SwarmSync unavailable, sends the item to review with a typed exception — it never proceeds silently and never shows a verification badge.
- **Failure case**: an unmapped error code is a **test failure**, not a passthrough — there is no code path that renders an unmapped provider string.
- **Integration**: the mapped codes are the same ones CHUNK_3's IPC responses return and CHUNK_7's backup failures raise.

## Dependencies

- **Requires**: CHUNK_3_IPC (the error surface is the IPC response shape).
- **Blocks**: CHUNK_9_PACKAGE.

## Completion Promise

<promise>CHUNK COMPLETE: CHUNK_6_CLEANUP</promise>
