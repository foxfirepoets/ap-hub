# CHUNK_4_TRANSPORTS: Route QBO through one capability-verified transport contract

## Summary

This chunk adds direct localhost OAuth, authenticated API-adapter, and constrained MCP-adapter
modes behind the existing QuickBooks posting boundary. Every mode must satisfy identical company,
approval, proof, idempotency, read-back, reconciliation, and audit gates.

## Acceptance Criteria

- [ ] `QuickBooksTransport` supports direct local OAuth, API adapter, and MCP adapter modes.
- [ ] Each mode reports live company identity and exact capabilities before writes.
- [ ] MCP tools and schemas are fixed and allowlisted; arbitrary tools, oversized output, and malformed responses fail closed.
- [ ] API/MCP mode needs no inbound public AP Hub URL and never claims authorization is bypassed.
- [ ] Timeout-after-create is held and adopted by idempotency/read-back rather than blindly replayed.
- [ ] Shared transport contract tests prove parity across all QBO modes.
- [ ] All tests pass with zero failures.

## Endpoints / Interfaces

| Method | Path | Description |
|---|---|---|
| POST | `/api/connections/quickbooks` | Create a transport-scoped connection |
| POST | `/api/connections/quickbooks/{id}/authorize` | Authorize or verify the transport |
| GET | `/api/connections/quickbooks/{id}/capabilities` | Return verified company capabilities |

## Database Changes

No schema changes in this chunk; uses `connections.transport_mode/transport_config`.

## Test Scenarios

- **Happy path**: each transport posts and reconciles the same approved sandbox fixture.
- **Edge case**: direct localhost redirect unsupported returns adapter recovery guidance.
- **Failure case**: wrong company, unknown MCP tool, timeout, or ambiguous result holds without mutation replay.
- **Integration**: existing proposal approval calls the registry rather than a provider-specific bypass.

## Dependencies

- **Requires**: CHUNK_1_SECRETS, CHUNK_2_AUTH
- **Blocks**: CHUNK_7_CERTIFICATION

## Completion Promise

<promise>CHUNK COMPLETE: CHUNK_4_TRANSPORTS</promise>
