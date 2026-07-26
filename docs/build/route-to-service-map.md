# Route → service map (CHUNK_3_IPC input)

**Generated:** 2026-07-26 · **Branch:** `feat/local-desktop-p1` · **Method:** direct source inventory

The transport changes; the service layer does not. This records exactly what the 52 HTTP route
files call, so CHUNK_3 can replace the transport without re-deriving the mapping and without
quietly dropping an authorization check.

## Scale

> **Correction (2026-07-26, integration lead):** this document undercounts. `app/` contains
> **54** `route.ts` files, not 52. The two omitted are `app/oauth/gmail/callback/route.ts` and
> `app/oauth/qbo/callback/route.ts`, which sit outside `app/api/**` and also block
> `next build --output export`. They are redundant wrappers — `src/auth/routes.ts:21,26` already
> serves both paths on the engine's own listener — and neither becomes an IPC channel.
> See DEVIATIONS.md §5b. The 52-file figure below, and everything derived from it, refers to
> `app/api/**` only.
>
> This document also **omits two owner-only READ wrappers** — see §5.1 of
> `docs/build/interfaces/ipc-auth-context.md`. Treat the inventory below as a starting point to
> verify against the code, never as complete.

- **52 route files** under `app/api/**`, **528 lines total** (~10 lines each).
- Route files are pure wiring: import, then a 3–8 line handler forwarding to a `run*` function.
- Two exceptions carry inline logic: `app/api/auth/callback/route.ts` (58 lines, SSO) and
  `app/api/provider-jobs/[id]/retry/route.ts` (inline `requireSession` + try/catch).

## The authorization funnel — the thing CHUNK_3 must not break

Everything derives from **one** value taken off the HTTP request: the session token.

```ts
// src/services/read/http.ts:30
tokenFromRequest(request)        // session cookie first, then `Authorization: Bearer`
// src/services/read/http.ts:39
readContext(request, role?)      // → requireSession(token, role)
// src/auth/guard.ts:80
requireSession(rawToken, role?)  // DB session lookup + role gate → AuthContext
```

```ts
interface AuthContext { sessionId?: number; userId: number; tenantId: number; role: string; email: string }
interface ActorContext { userId: number; tenantId: number; role: string; email?: string; actor?: string }
toActorContext(ctx)  // src/services/index.ts:11
```

**Consequence for IPC:** replacing `readContext` with an IPC-side context resolver is sufficient
to cut the HTTP dependency. Two residual couplings must be handled explicitly:

1. `runOnboardingAction` branches on `request.method === 'POST'`.
2. Several bridges read `new URL(request.url).searchParams`.

### Wrappers

| Wrapper | Location | Signature note |
|---|---|---|
| `runRead<T>` | `src/services/read/http.ts:48` | `(request, handler, { role? })`; `null` → 404; never mutates or audits |
| `runAction` | `src/services/action/index.ts:97` | **module-private**; `role` is positional+required; handler returns a full `Response` |
| `runApprove` | `src/services/action/index.ts:156` | `(request, proposalId, deps?)`; wraps `runAction(request,'owner_controller',…)` |

Near-identical private clones exist: `runOnboardingAction`, `runTaxMappingAction`,
`runDimensionMappingAction`, `action()` (`src/statements/http.ts`), `mutation()`
(`src/reply-drafts/http.ts`). **CHUNK_3 must not unify these silently** — each has a different
role default, and collapsing them is an authorization change disguised as a refactor.

### RBAC matrix (`src/auth/guard.ts:16-39`)

`ROLES = ['owner_controller','bookkeeper','cpa']`

| Role | Permissions |
|---|---|
| `owner_controller` | all |
| `bookkeeper` | `read, reject, remap, learn, draft_reply` |
| `cpa` | `read` only |

`AuthError` codes: `UNAUTHENTICATED` (401), `SESSION_EXPIRED` (401), `FORBIDDEN` (403).

## Validation — a gap CHUNK_3 must close

**No zod anywhere in the route or HTTP-bridge layer.** `zod` appears in exactly four files:
`src/config.ts`, `src/extract/schema.ts`, `src/install/install-file.ts`, `src/statements/ingest.ts`.
Every request body is validated by hand-rolled `typeof` checks inside the `run*` bridges.

The chunk requires "validate every IPC input and output". That is **new work**, not a port.

## Renderer network I/O — the only two files that change

`app/lib/api.ts` (75 lines, 3 fetch sites) and `app/lib/session.tsx` (62 lines, 1 inline fetch).

| Export | Behaviour |
|---|---|
| `apiGet<T>(path)` | unwraps `body.data`; **throws** `ApiError(code, message, status)` on non-2xx |
| `apiPost<T>(path, payload?)` | returns `{ ok, status, data?, error? }`; **never throws** — callers branch on 201/202/409/400 |
| `apiPatch` / `apiDelete` | via private `apiMutation`; same `ActionResult<T>` shape |

Wire contract both directions: success `{ data: T }`, failure `{ error: { code, message } }`.

`session.tsx` calls `/api/me` once on `SessionGuard` mount; non-200 → `router.replace('/login')`.

**The throw/no-throw asymmetry is load-bearing** — screens depend on `apiPost` returning 409 rather
than throwing. An IPC adapter that throws uniformly will silently change error handling in every
mutation screen.

## Channel allowlist (`desktop/channels.ts`)

Naming: `aphub:<domain>:<action>`, lowercase-kebab segments.

```ts
export const CHANNEL_PATTERN = /^aphub:[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/;
export function isAllowedChannel(channel: unknown): channel is string {
  return typeof channel === 'string' && CHANNEL_SET.has(channel);
}
```

The pattern is a **shape check, never an admission rule** — a well-formed name nobody registered
is still refused. `IPC_CHANNELS` is frozen. CHUNK_3 appends its list here; the integration lead
applies that edit (shared file).

## Route inventory

Grouped by domain. `runRead` with no role means any authenticated role.

### Read-only, any role
`/api/today`, `/api/transactions`, `/api/transactions/:id`, `/api/exceptions`,
`/api/exceptions/:id`, `/api/items/:id/evidence`, `/api/audit`, `/api/notifications`, `/api/me`

### Read-only, role-restricted
| Route | Roles |
|---|---|
| `/api/accounting-documents/review` | owner, bookkeeper, cpa |
| `/api/statements`, `/api/statements/:id` | owner, bookkeeper, cpa |
| `/api/reply-drafts` (GET) | owner, bookkeeper, cpa |
| `/api/provider-capabilities` | all ROLES |
| `/api/provider-jobs` | owner only |
| `/api/dimension-mappings`, `/api/tax-mappings*` (GET) | owner only |

### Mutations
| Route | Roles | Body |
|---|---|---|
| `/api/proposals/:id/approve` | owner | none |
| `/api/proposals/:id/reject` | owner, bookkeeper | `reason` required; `markDuplicate?` |
| `/api/proposals/:id/retry` | owner | none |
| `/api/corrections/learn` | owner, bookkeeper | `field`, `newValue` required |
| `/api/mappings/remap` | owner, bookkeeper | `kind`, `sourceKey` required |
| `/api/accounting-documents/:id/classify` | owner, bookkeeper | `classification`, `reason` |
| `/api/notifications/:id/read` | any authenticated | none |
| `/api/onboarding/step`, `/dry-run` | owner | `step?`, `automationLevel?` |
| `/api/provider-connections/:id/write-gate` | owner | all 4 required: `enabled`, `confirmedCompanyId`, `backupConfirmed`, `confirmation` |
| `/api/replies/:id/send` | owner | **deny-list** (see below) |
| `/api/reply-drafts` (POST) | owner, bookkeeper | `messageId>0`, `subject`, `bodyText` |
| `/api/reply-drafts/:id` (PATCH/DELETE) | owner, bookkeeper | `subject`, `bodyText`, `reason?` |
| `/api/statements/:id/correct`, `/file`, `/lines/:lineId/match`, `/exclude` | owner, bookkeeper | varies; `reason` always required |
| `/api/tax-mappings/:id/{edit,disable,replace,revalidate}` | owner | `reason` required (except revalidate) |
| `/api/dimension-mappings/:id/{accept,correct,reject,save-rule,select-alternate}` | owner | varies |
| `/api/provider-jobs/:id/retry` | owner | inline `requireSession`; **async `params`** unlike every other route |

### Pre-auth (no session)
`/api/auth/login`, `/api/auth/callback`, `/api/auth/logout`, `/api/connections/{gmail,qbo}/start`

`connections/*/start` are pre-auth at the route but call `readContext(request,'owner_controller')`
inside `src/services/action/connections.ts`.

## Carry-forward warnings for CHUNK_3

1. **`/api/replies/:id/send` carries a recipient deny-list** — rejects a body containing any of
   `to, recipient, recipients, cc, bcc, email, address, to_address, toAddress, from, replyTo`
   with 400. This is part of the locked-forwarder guarantee. **The IPC handler must reproduce it.**
2. **`/api/auth/callback` is not a product operation.** CHUNK_5 replaces it with the loopback
   callback; it must not become an IPC channel.
3. `provider-jobs/[id]/retry` uses `params: Promise<{id}>`; every other dynamic route does not.
4. Deleting `app/api/**` is what unblocks `next build --output export` (DEVIATIONS.md #4).
