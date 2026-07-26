# Frozen IPC interface contracts — CHUNK_3_IPC

**Frozen:** 2026-07-26 · **Branch:** `feat/local-desktop-p1` · **Status:** authoritative for CHUNK_3

These five documents are the contract that the CHUNK_3 implementation agents build against. They exist
so that the foundation, read-domain, action-domain, renderer, and test agents cannot drift apart while
working simultaneously.

**File ownership is `docs/build/file-ownership.md:39-45`** — agents B1 (these documents, frozen)
through B7. These documents say what goes *inside* each file; that table says who may *write* it.
Where the two disagree, file-ownership wins.

## Index

| Document | Owns | Read it if you are building |
|---|---|---|
| [`ipc-envelope.md`](./ipc-envelope.md) | Request synthesis, `Response` decoding, the wire envelope, HTTP-status carriage | the dispatcher, or the renderer adapter |
| [`ipc-auth-context.md`](./ipc-auth-context.md) | Session-token custody, the RBAC matrix, per-channel role requirements | the dispatcher |
| [`ipc-error-contract.md`](./ipc-error-contract.md) | The closed code set, code normalization, the plain-language message table | the dispatcher |
| [`ipc-schema-registry.md`](./ipc-schema-registry.md) | The zod registry, file layout, all 50 channel entries | the schema layer, or the dispatcher |

An implementation agent building the dispatcher needs only `ipc-envelope.md` +
`ipc-schema-registry.md` to compile against the real signatures in `src/services/read/http.ts` and
`src/services/action/index.ts`. The other two are consulted for the tables they own.

## The architectural decision these documents encode

The dispatcher **reuses the existing exported service wrappers unmodified** by synthesizing a
`Request` and decoding the returned `Response`. `src/services/**` is not edited at all in CHUNK_3.

The reason is authorization, not convenience. `runAction` is module-private
(`src/services/action/index.ts:97`) and has five near-identical private clones, **each with a
different role default**:

| Clone | Location | Role it enforces |
|---|---|---|
| `runAction` | `src/services/action/index.ts:97-122` | positional + required, per call site |
| `runOnboardingAction` | `src/services/action/onboarding.ts:30-57` | `Role \| readonly Role[] \| undefined` — **may be undefined** (`onboarding.ts:61`) |
| `runTaxMappingAction` | `src/services/action/taxMappings.ts:48-72` | hard-coded `'owner_controller'` (`taxMappings.ts:54`) |
| `runDimensionMappingAction` | `src/services/action/dimensionMappings.ts:43-67` | hard-coded `'owner_controller'` (`dimensionMappings.ts:49`) |
| `action()` | `src/statements/http.ts:18-42` | hard-coded `['owner_controller','bookkeeper']` (`statements/http.ts:24`) |
| `mutation()` | `src/reply-drafts/http.ts:47-57` | hard-coded `['owner_controller','bookkeeper']` (`reply-drafts/http.ts:52`) |

Exporting, unifying, or refactoring these is an authorization change disguised as a refactor and is
**FORBIDDEN in this chunk**. Because the dispatcher hands each wrapper a real `Request`, the entire
authorization funnel stays byte-identical and keeps firing:

```
tokenFromRequest(request)   src/services/read/http.ts:30
  → readContext(request, role)   src/services/read/http.ts:39
    → requireSession(token, role)   src/auth/guard.ts:80
      → role gate   src/auth/guard.ts:96-101
```

The transport changes. The check does not move house; only its caller does.

## Change control

These documents are frozen for the duration of CHUNK_3.

1. **No implementation agent may edit these files.** If you find a contract that cannot be
   implemented as written, STOP and return `BLOCKED` naming the document and section. The
   integration lead resolves it and re-freezes.
2. **A contradiction between a document and the code is resolved in favour of the code**, and is a
   defect in the document — report it, do not "restore" behaviour to match a stale claim
   (`CLAUDE.md`, "The guarantees" preamble).
3. **A contradiction between two of these documents is a stop-and-escalate**, not a judgement call.
4. Every claim about current behaviour in these documents carries a `file:line` citation. A claim
   without one is marked `[UNVERIFIED]` and must be verified before it is relied on.
5. `desktop/channels.ts`, `desktop/preload.ts` and `desktop/main.ts` are **shared files**
   (`docs/build/file-ownership.md:17-18`). CHUNK_3 requires three additive edits to them, and **the
   integration lead applies all three** (see `ipc-envelope.md` § "Three shared-file edits the
   integration lead owns"). No implementation agent edits those files.
6. The two channel-name modules that feed `desktop/channels.ts` must have **zero imports**, because
   `channels.ts` is bundled into the sandboxed preload (`docs/build/file-ownership.md:67-73`). This
   forbids deriving the allowlist from the registry — see `ipc-schema-registry.md` § 6.1.

## Non-negotiables restated (so no agent has to go looking)

- **The session token lives in the main process.** The renderer never supplies, sees, or can
  override it. See `ipc-envelope.md` § 3.
- **The `/api/replies/:id/send` recipient deny-list is reproduced at the IPC layer.** Dropping it is
  a defect, not a simplification. See `ipc-schema-registry.md` § 7 and
  `src/services/action/index.ts:252-271`.
- **`/api/auth/callback` must not become an IPC channel.** CHUNK_5 replaces it with the loopback
  callback (`docs/build/route-to-service-map.md:156-157`).
- **Validation runs before the service is reached.** See `ipc-schema-registry.md` § 4.
- **`message` is plain language, replaced by code — never forwarded from the service.**
  See `ipc-error-contract.md` § 3, which cites the one service that interpolates raw driver text.
