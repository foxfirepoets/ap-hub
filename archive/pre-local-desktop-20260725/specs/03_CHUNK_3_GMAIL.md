# CHUNK_3_GMAIL: Authorize Gmail through a desktop PKCE loopback flow

## Summary

This chunk replaces web-client assumptions with Google Desktop OAuth using S256 PKCE, random
single-use state, and a temporary loopback callback. Gmail polling, attachments, classification,
statements, and draft-only behavior continue through the existing pipeline.

## Acceptance Criteria

- [ ] Authorization uses a Desktop client, S256 PKCE, random state, and an available loopback port.
- [ ] Callback accepts loopback only, matches exact redirect URI, expires after 10 minutes, and rejects replay.
- [ ] Gmail tokens are stored in Credential Manager with only references/metadata in PostgreSQL.
- [ ] Watched-label polling creates each supported document once or a typed visible exception.
- [ ] Draft create/update works in the source thread and no send operation is reachable.
- [ ] All tests pass with zero failures.

## Endpoints / Interfaces

| Method | Path | Description |
|---|---|---|
| POST | `/api/connections/gmail/start` | Start Desktop OAuth and return the provider URL |
| GET | `http://127.0.0.1:{port}/oauth/gmail/callback` | Temporary PKCE callback |

## Database Changes

No schema changes in this chunk.

## Test Scenarios

- **Happy path**: authorize, poll one labeled message, and create one source-thread draft.
- **Edge case**: occupied callback port causes selection of another loopback port.
- **Failure case**: wrong state/verifier, late callback, or missing compose scope fails visibly.
- **Integration**: Gmail tokens resolve through CHUNK_1 and UI authorization through CHUNK_2.

## Dependencies

- **Requires**: CHUNK_1_SECRETS, CHUNK_2_AUTH
- **Blocks**: CHUNK_7_CERTIFICATION

## Completion Promise

<promise>CHUNK COMPLETE: CHUNK_3_GMAIL</promise>
