# CHUNK_5_CONNECT: Connect providers through the system browser with a single-use loopback callback.

## Summary

Opens provider consent in the user's own browser, receives the callback on an ephemeral loopback
port, exchanges the code, stores the token in the OS credential store, and pulls focus back to the
AP-Hub window. It comes after identity because tokens are stored under the OS account's namespace.
It hands the remaining chunks a connected provider to exercise.

An embedded webview is **forbidden** — it is both an Intuit/Google policy violation and a
credential-phishing pattern.

## Acceptance Criteria

- [ ] Provider consent opens in the **system browser** via `shell.openExternal`, restricted to the four provider domains. Never an embedded webview.
- [ ] The loopback callback binds `127.0.0.1` on an ephemeral port, with exact redirect-URI match, S256 PKCE, a random single-use state, and a ten-minute expiry.
- [ ] The listener is closed immediately after the exchange — it is not left running.
- [ ] A state mismatch or replay is refused as `CONNECT_TIMEOUT` and the attempt is **audited**.
- [ ] An expired callback surfaces `CONNECT_TIMEOUT` — *"That sign-in took too long. Let's try again."*
- [ ] The AP-Hub window is programmatically focused after consent; the browser tab shows "You can close this and return to AP-Hub."
- [ ] The user never copies a code back manually.
- [ ] Tokens are written through the existing credential store; PostgreSQL holds only references and non-secret metadata.
- [ ] Connecting Gmail end to end shows the connection as active in the UI.
- [ ] All tests pass with zero failures (`npm run verify` exits 0).

## Endpoints / Interfaces

| Channel | Auth | Request | Response |
|---|---|---|---|
| `aphub:connections:start` | owner | `{ provider: 'gmail' \| 'qbo' \| 'qbd' }` | `{ ok: true, state: 'browser_opened' }` |
| `aphub:connections:status` | any signed-in role | `{}` | `{ ok: true, data: ConnectionStatus[] }` |

Errors: `CONNECT_TIMEOUT` | `PROVIDER_OFFLINE` | `SECURE_STORE`.

**Loopback HTTP** (not reachable by the renderer): `GET http://127.0.0.1:{ephemeral}/callback` —
single-use, closed immediately after the code exchange.

## Database Changes

No new tables. Existing credential-reference rows (`migrations/013`) are written with non-secret
references only — the token value itself never reaches PostgreSQL.

## Test Scenarios

- **Happy path**: Connect Gmail → system browser opens → consent granted → callback received → token stored in the credential store → AP-Hub window focused → connection shown active.
- **Edge case**: the user takes longer than ten minutes, or closes the browser mid-flow; the listener expires and closes, and the UI offers to restart the flow in plain language.
- **Failure case**: a callback arriving with a mismatched or replayed `state` is refused, audited, and never exchanged; a credential store that will not open surfaces `SECURE_STORE`, not a raw Win32 error.
- **Integration**: the stored token is the one the existing pipeline's Gmail intake reads — no change to `src/gmail/**`.

## Dependencies

- **Requires**: CHUNK_3_IPC (channel dispatcher), CHUNK_4_IDENTITY (credential-store namespace).
- **Blocks**: CHUNK_9_PACKAGE (clean-machine certification connects a provider).

## Completion Promise

<promise>CHUNK COMPLETE: CHUNK_5_CONNECT</promise>
