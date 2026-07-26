# Scope Decision — AP-Hub Version 1 is Windows-only

**Date:** 2026-07-25 · **Decided by:** the owner · **Status:** AUTHORITATIVE
**Supersedes:** every "both platforms" and "macOS ships in the same phase" statement in
`specs/SPEC-local-desktop-shell.md`, `architecture-decision-packet-ap-hub-local-desktop-2026-07-25.md`,
the chunk specs, `IMPLEMENTATION_PLAN.md`, `.ralph/guardrails.md` and `.ralph/state.md`.

> Where any other document still implies macOS is required for Version 1, **this document wins**
> and that document is the defect. Report it and fix it here-first.

## The decision

AP-Hub Version 1 is **Windows only**. macOS is removed from Version 1 development, packaging,
signing, notarization, testing, documentation and acceptance criteria. It may be reconsidered
**after** the Windows product is complete and proven.

This is a **scope reduction, not an architecture change.** The cross-platform abstractions
already written are preserved.

## What Version 1 is

- Windows only, a local desktop application.
- Installed through one normal graphical installer; opened from a desktop or Start-menu icon.
- No hosted AP-Hub application, no public AP-Hub URL, no browser-based product interface, no
  user-visible localhost address.
- No Docker, no command-line setup, no user-managed PostgreSQL, no user-facing environment
  variables.
- No requirement for the user to understand APIs, ports, tokens, models, databases, workers or
  services.
- Browser use only for unavoidable third-party login and permission screens.
- Local storage and local processing by default. Outside services only when the user knowingly
  connects or enables them.

## What this changes in the acceptance criteria

The spec's Definition of Done previously required every criterion to be observed on **a clean
Windows machine and a clean macOS machine**. Version 1 requires **a clean Windows machine only**.

Specifically retired from Version 1:
- macOS clean-machine validation, TCC privacy-prompt handling, Gatekeeper friction recording.
- Developer ID signing and Apple notarization.
- `.dmg` production and `npm run dist:mac`.
- LaunchAgent autostart validation.
- macOS Keychain validation.
- The `lsof -i` listener inspection (the Windows `Get-NetTCPConnection` inspection is retained).
- The Mac ↔ Windows QuickBooks Desktop bridge (was already P4).

## What is deliberately PRESERVED

Removing macOS from scope must not corrupt the codebase's platform seam, because that seam is
what makes a later macOS version a thin addition rather than a rewrite. Retained:

| Preserved | Why |
|---|---|
| `src/host/types.ts` — the OS-neutral `HostAdapter` interface | The seam itself. Deleting it would hard-code Windows assumptions into core. |
| `src/host/macos.ts` — the existing Keychain / LaunchAgent / `lsof` implementation | Already written and typechecked. It costs nothing to keep compiling and is the head start for a future macOS version. **Not maintained, not tested, not shipped.** |
| `scripts/lint-noleak.mjs` OS-token boundary | Keeps core OS-neutral. A Windows-only V1 is not a licence to leak `process.platform` through `src/**`. |
| `desktop/channels.ts` `platform` value | Already a two-value union; harmless. |
| macOS branches in `electron-builder.yml` | Inert without a `--mac` invocation. Retained, commented as out of scope. |

**Rule for the build:** macOS code must continue to *compile and typecheck*. It must never
appear in a Version 1 acceptance criterion, gate, Definition of Done, or completion claim.

## Status of `src/host/macos.ts`

Worth recording, because the architecture packet was wrong about it: packet §2 lists the macOS
host adapter as a **stub** to be built. It is not a stub — it is a real implementation
(Keychain via `security`, LaunchAgent via `launchctl`, port probing via `lsof`, `chmod 700`).
Per CLAUDE.md's "the code wins" rule, the packet was the defect.

One genuine defect **is** present in it and is now deferred rather than fixed: line 32 passes the
secret as a command-line argument to `security add-generic-password`, which spec §9 forbids
("never in … command lines"). It is unreachable on Windows. **This must be fixed before any
future macOS version ships.** Recorded here so the deferral is explicit rather than lost.

## Consequence for the PostgreSQL bundling decision

`docs/audits/postgres-bundling-spike-2026-07-25.md` chose the official binaries over
`embedded-postgres`, and recorded one counter-argument: `embedded-postgres` is better on macOS
because it resolves platform binaries for free. **That counter-argument is now void for Version
1.** The decision is strengthened, not weakened — the only dimension on which the rejected
candidate won no longer applies, and the owner has separately directed that a stable, officially
supported PostgreSQL Windows distribution be used rather than a beta package.

## Future-version note (not Version 1 work)

When macOS is reconsidered, the following is what Version 1 knowingly left undone:
1. Fix the `security` command-line secret exposure in `src/host/macos.ts`.
2. Source and trim a relocatable macOS PostgreSQL 16 build.
3. Developer ID signing + notarization pipeline.
4. TCC privacy-prompt handling as resolvable user states.
5. LaunchAgent plist generation (nothing writes the plist today; `registerAutostart` expects a
   path to one).
6. macOS clean-machine certification.
7. The Mac ↔ Windows QuickBooks Desktop bridge.
