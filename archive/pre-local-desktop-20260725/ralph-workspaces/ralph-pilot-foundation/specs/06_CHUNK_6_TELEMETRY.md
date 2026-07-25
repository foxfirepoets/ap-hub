# CHUNK_6_TELEMETRY: Liveness telemetry and the pilot-report metrics — no business data ever

## Summary

Add the `/v1/heartbeat` route and the `pilot-report` CLI that turns heartbeats into the three numbers the pilot exists to produce (online-hours %, watchdog recovery rate, Postgres corruption count). The one hard rule: telemetry is liveness only — no invoice content, vendor names, amounts, or tokens may ever reach the broker. Enforced by a closed enum, a length cap, and a content-assertion test.

## Acceptance Criteria

- [ ] `POST /v1/heartbeat` accepts `{event, pg_ok?, detail?(≤200), tz_offset_minutes?}`; `event` is a closed enum (`alive|watchdog_restart|pg_health|shutdown`); rate-limited 5/min/install; returns 201.
- [ ] **Content-assertion test:** a heartbeat whose `detail` contains a vendor name, an amount, and an email → the stored row contains none of them (rejected or stripped).
- [ ] `pilot-report [--days 7] [--business-hours]` prints all three numbers + sample size + date range; online-hours computed broker-side from `observed_at` (server clock), business hours default Mon–Fri 08:00–18:00 in the install's local tz.
- [ ] Heartbeat send failure on the client is logged `warn` and dropped — **never** blocks or crashes the pipeline.
- [ ] `heartbeats` table holds no column/row with business data.
- [ ] Existing suite ≥ 212, zero existing tests modified.
- [ ] All tests pass with zero failures.

## Endpoints / Interfaces

| Method | Path | Description |
|--------|------|-------------|
| POST | /v1/heartbeat | Accept liveness telemetry (bearer, rate-limited) |

CLI: `pilot-report` (broker operator CLI).

## Database Changes

- `heartbeats`: written by the route; read by `pilot-report` (uses the CHUNK_2 index). No new tables.

## Test Scenarios

- **Happy path**: a `watchdog_restart` heartbeat lands; `pilot-report` counts it in the recovery-rate numerator.
- **Edge case**: `detail` at the 200-char boundary; an illegal `event` value → 400.
- **Failure case**: business data in `detail` → not stored; broker down → client drops the heartbeat silently, pipeline unaffected.
- **Integration**: CHUNK_7's supervisor emits these heartbeats; CHUNK_8 confirms real ones land from a real machine.

## Dependencies

- **Requires**: CHUNK_5_CONNECTOR
- **Blocks**: CHUNK_7_HARNESS

## Completion Promise

<promise>CHUNK COMPLETE: CHUNK_6_TELEMETRY</promise>
