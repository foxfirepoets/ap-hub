# Open Question 1 — which PostgreSQL distribution to bundle

**Date:** 2026-07-25 · **Chunk:** CHUNK_2_DATABASE · **Status:** resolved, with a caveat
**Question (spec §14):** the official PostgreSQL zip on Windows and a relocatable build on
macOS, versus `embedded-postgres`. Resolution basis fixed by the spec: **measured installer size
and cold-start time.**

All numbers below were measured on this machine (Windows Server 2025, Node 24.11.1), not
estimated. Each candidate was initialised into a scratch data directory on a free port so the
two PostgreSQL instances already running on this host (a scoop install on 5432, and the archived
`cbv-loc001` build's bundled instance on 55432) were not disturbed.

## Measurements

| Metric | A — official binaries | B — `embedded-postgres` |
|---|---|---|
| PostgreSQL version measured | 16.4 | 16.14 |
| Release channel | **stable** | **beta only** (see below) |
| Full distribution on disk | 919.8 MB / 20,851 files | 99 MB |
| — of which `pgAdmin 4` | 615.9 MB | n/a |
| — of which debug `symbols` | 155.6 MB | n/a |
| — of which `doc` + `include` | 27.9 MB | n/a |
| **Shippable server subset** (`bin`+`lib`+`share`) | **119.6 MB** | **99 MB** |
| `initdb` (first launch only) | **11,820 ms** | **14,455 ms** |
| start → first successful query | 935 ms | 382 ms |
| **Total first launch** | **12,755 ms** | **14,838 ms** |
| **Warm start → first query** | **726 ms** | **691 ms** |

Candidate A's subset breakdown: `bin` 71.3 MB (71 files), `lib` 25.3 MB (144 files),
`share` 23.0 MB (1,412 files). `pgAdmin 4`, `symbols`, `doc`, `include` and `StackBuilder` are
all excluded — none is needed by a bundled server, and together they are 87% of the download.

## Decision: **Candidate A — official binaries, trimmed to `bin` + `lib` + `share`.**

Reasoning, in the order the reasons actually carried weight:

1. **Release channel is decisive.** `embedded-postgres` has never shipped a stable release.
   Every published version — across the 16.x, 17.x *and* 18.x lines — is a beta
   (`16.14.0-beta.17` is the newest on the PG16 line; `18.4.0-beta.17` is the newest overall).
   This component holds the user's entire AP history, and the phase's own P0 risk is
   "local-only storage destroyed by a drive or database failure." A 20.6 MB saving does not
   justify a perpetual-beta dependency for the storage layer.
2. **First launch is 2.1 s faster**, and that is the launch that matters. `initdb` dominates
   cold start and runs exactly once, on first launch. Against the spec's ≤ 15 s cold-launch
   budget, A leaves 2.2 s of headroom and B leaves 0.2 s — before Electron, the engine and the
   migrations have taken their share. B does not have room for the rest of the boot sequence.
3. **Direct control of the shipped binaries.** CHUNK_7 needs `pg_dump`/`pg_restore` for the
   backup and destroy-and-restore drill, and CHUNK_9 must sign what it ships. Owning the
   binary set makes both explicit rather than inherited from a transitive npm package.
4. Size and warm start are effectively ties: 119.6 vs 99 MB against a 200 MB budget, and
   726 vs 691 ms against a ≤ 4 s budget. Neither decides anything.

### The honest counter-argument

Candidate B is genuinely simpler on macOS. It resolves platform binaries through
`optionalDependencies`, so `darwin-arm64` and `darwin-x64` come for free. With candidate A we
must source and trim a relocatable macOS build ourselves, and **that work cannot be validated in
this environment — there is no macOS machine here.** This is the one dimension where the
rejected candidate is clearly better, and it is being traded away for release-channel stability.
If sourcing a relocatable macOS PostgreSQL proves harder than expected in CHUNK_9, revisit this
decision for the macOS target specifically rather than re-litigating both platforms.

### Caveats on these numbers

- Both were measured on one machine, once each. Disk speed dominates `initdb`; a slower drive
  moves both numbers up together, so the ~2 s gap is the durable finding, not the absolutes.
- Version skew: A was measured at 16.4 (the binaries already on this host from the archived
  build) and B at 16.14. The shipped build should use the current 16.x patch release for both
  security and parity; this is not expected to move `initdb` materially.
- The 200 MB budget in spec §8 is stated for the **installer**, which NSIS compresses. 119.6 MB
  of binaries will compress substantially. Installed size will exceed 200 MB; installer size is
  the constraint that was set, and it is the one being tracked.

## Follow-on work this creates for CHUNK_2 / CHUNK_9

- Trim script that produces the `bin`+`lib`+`share` subset from an official download, so the
  120 MB is reproducible rather than a hand-curated directory.
- A relocatable macOS PostgreSQL 16 source must be chosen in CHUNK_9. Unvalidated here.
- `share/` still carries full locale and timezone data; a further trim is available if the
  installer budget gets tight once Electron and the engine are packaged.
