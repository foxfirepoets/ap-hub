# CHUNK_7_CERTIFICATION: Prove the installed Windows product against the frozen specification

## Summary

This chunk performs full regression, hostile boundary checks, and disposable-provider
certification on a clean standard-user Windows installation. It updates product claims so only
observed local behavior and certified transports are represented as complete.

## Acceptance Criteria

- [ ] Full lint, no-leak, typecheck, unit/integration, production build, and Playwright gates pass.
- [ ] Installed listener evidence proves no non-loopback binding or public AP Hub dependency.
- [ ] Reboot, child-kill, network-loss, secret-migration rollback, and backup/restore drills pass.
- [ ] Disposable Gmail poll/draft and every configured QBO/QBD transport produce auditable live evidence.
- [ ] Static and runtime checks prove AP Hub cannot send email or bypass accounting write gates.
- [ ] README, installer, configuration, and UI claims match executable local-only behavior.
- [ ] All tests pass with zero failures.

## Endpoints / Interfaces

No new endpoints — certification exercises all prior interfaces.

## Database Changes

No schema changes in this chunk.

## Test Scenarios

- **Happy path**: clean install completes Gmail-to-review-to-disposable-QB posting.
- **Edge case**: reboot and backup/restore preserve state and credential references.
- **Failure case**: hostile Host/OAuth/MCP/company/replay probes produce specified safe failures.
- **Integration**: every frozen-spec acceptance item receives an artifact or remains explicitly unverified.

## Dependencies

- **Requires**: CHUNK_1_SECRETS through CHUNK_6_WATCHDOG
- **Blocks**: None

## Completion Promise

<promise>CHUNK COMPLETE: CHUNK_7_CERTIFICATION</promise>
