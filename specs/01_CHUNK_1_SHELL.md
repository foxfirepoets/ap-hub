# CHUNK_1_SHELL: Stand up the Electron shell that owns the window, the tray and every child process.

## Summary

Creates the Electron main process, the frozen preload bridge and the hardened renderer that every
later chunk plugs into. It comes first because nothing else in the phase has anywhere to live until
a window opens from an icon. It hands the next chunk a supervised process model and a renderer that
can only reach the main process through an enumerated `contextBridge` API.

No product operation works yet — CHUNK_3 supplies the IPC channels. This chunk proves the container
is safe before anything valuable is put inside it.

## Acceptance Criteria

- [ ] `npm run dist:win` build configuration exists and an unpacked app launches a window from an icon on Windows. (macOS out of Version 1 scope.)
- [ ] The renderer runs with `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webSecurity: true`.
- [ ] `window.require`, `window.process` and `window.module` are all `undefined` when evaluated in renderer JavaScript.
- [ ] A CSP is applied that names no remote origin.
- [ ] Navigation to any non-`file://` origin inside the app window is blocked, and `shell.openExternal` is refused for any host outside the four provider domains.
- [ ] A second launch of AP-Hub focuses the existing window instead of starting a second instance.
- [ ] The tray icon exposes Open / Pause / Resume / Quit; closing the window leaves the engine running, Quit stops all children.
- [ ] The existing React tree is statically exported and loaded in the renderer with **zero** page components changed.
- [ ] All tests pass with zero failures (`npm run verify` exits 0).

## Endpoints / Interfaces

No HTTP endpoints. This chunk introduces the preload surface only:

| Interface | Shape | Notes |
|---|---|---|
| `window.aphub.invoke` | `(channel: string, payload?: unknown) => Promise<IpcResult>` | Frozen; channel must be on the enumerated allowlist |
| `window.aphub.on` | `(event: string, cb) => () => void` | Status events only (engine/db/connection health) |
| `window.aphub.platform` | `'win32' \| 'darwin'` | Non-secret, read-only |

The object returned by `contextBridge.exposeInMainWorld` is `Object.freeze`d and enumerates its
channels explicitly — no dynamic channel names, no pass-through of arbitrary strings.

## Database Changes

No schema changes in this chunk.

## Test Scenarios

- **Happy path**: the app launches, one window appears, the tray icon is present, the React tree renders.
- **Edge case**: launching AP-Hub twice focuses the first window; closing the window keeps the tray alive and Quit terminates cleanly with no orphaned child.
- **Failure case**: a renderer attempt to reach `window.require`, to navigate to `https://`, or to invoke an unlisted IPC channel is refused — the unlisted channel rejects rather than falling through.
- **Integration**: the preload API surface is the exact seam CHUNK_3 fills with the 52 migrated operations.

## Dependencies

- **Requires**: None — this is the first chunk.
- **Blocks**: CHUNK_2_DATABASE, CHUNK_3_IPC, CHUNK_4_IDENTITY, CHUNK_5_CONNECT, CHUNK_8_SUPERVISION, CHUNK_9_PACKAGE.

## Completion Promise

<promise>CHUNK COMPLETE: CHUNK_1_SHELL</promise>
