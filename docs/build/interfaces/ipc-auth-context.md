# IPC auth-context contract

**Frozen 2026-07-26.** Owns: token custody, the RBAC matrix, `AuthError` → status mapping, and the
rule that each channel declares the same role requirement its route had.

This is the document `.ralph/guardrails.md:60-63` exists to protect:

> **SIGN: Authorization lost while moving routes to IPC.** The 52 route handlers are thin; auth and
> RBAC live in `src/services/**` behind `runRead`/`runAction`/`runApprove`. Mitigation: every IPC
> channel replays the cross-tenant and role matrices before the chunk closes.

---

## 1. Token custody

Restated from `ipc-envelope.md` § 3 because it is the premise of everything below:

> **The session token is held in the main process and injected by the dispatcher. The renderer never
> supplies, sees, or can override it.**

No zod request schema may contain `token`, `session`, `sessionId`, `userId`, `tenantId`, `role`,
`actor`, or `email`. All entries are `.strict()`, so such a field is rejected with `VALIDATION`
before any service is reached (`ipc-schema-registry.md` § 3).

Tenant and role are derived **only** from the resolved session
(`src/auth/guard.ts:88-94`), and every read is tenant-scoped through the resolved
`ctx.tenantId` (`src/services/read/http.ts:10-12`). There is no second source of tenant identity, and
CHUNK_3 does not create one.

---

## 2. The authorization funnel — unchanged, byte for byte

```
tokenFromRequest(request)              src/services/read/http.ts:30
  signed cookie first (readSessionCookie), then Authorization: Bearer   :31-35
    → readContext(request, role?)      src/services/read/http.ts:39-41
      → requireSession(rawToken, role?) src/auth/guard.ts:80-103
          no token                     → AuthError(401,'UNAUTHENTICATED')  :84
          invalid/revoked/disabled     → AuthError(401,'UNAUTHENTICATED')  :73 via reasonToError
          expired                      → AuthError(401,'SESSION_EXPIRED')  :72
          role not in allowed set      → AuthError(403,'FORBIDDEN')        :96-101
        → AuthContext { sessionId?, userId, tenantId, role, email }        src/auth/guard.ts:62-69
          → toActorContext(ctx)        src/services/index.ts:22-24
```

CHUNK_3 does not replace, wrap, re-implement, or bypass any line of this. The dispatcher hands each
wrapper a real `Request`; the wrapper calls `readContext` itself, as it does today.

### 2.1 There is a second, independent check inside the services

`ensurePermission(ctx, permission)` → `requirePermission` → `can(role, permission)`
(`src/services/index.ts:32-40`, `src/auth/guard.ts:106-108`). This is defence in depth and it also
survives untouched, because the service functions are called with a `ActorContext` derived from the
session-resolved `AuthContext`.

---

## 3. RBAC matrix

`ROLES = ['owner_controller', 'bookkeeper', 'cpa']` (`src/auth/guard.ts:16`).

| Role | Permissions | Source |
|---|---|---|
| `owner_controller` | `read, approve, reject, remap, learn, retry, reply, draft_reply, onboard, tax_mapping, dimension_mapping` — all of them | `src/auth/guard.ts:34-36` |
| `bookkeeper` | `read, reject, remap, learn, draft_reply` | `src/auth/guard.ts:37` |
| `cpa` | `read` only | `src/auth/guard.ts:38` |

The full permission union is declared at `src/auth/guard.ts:19-30`.

Two consequences worth stating plainly, because they are the ones a channel is most likely to get
wrong:

- **A bookkeeper may reject but never approve.** `approve` is absent from the bookkeeper set
  (`src/auth/guard.ts:37`), which is why `runApprove` and `runRetry` pass `'owner_controller'`
  positionally (`src/services/action/index.ts:157`, `:167`) while `runReject` passes
  `['owner_controller','bookkeeper']` (`src/services/action/index.ts:179`).
- **A cpa may read and nothing else.** Any channel that admits `cpa` must be a read.

---

## 4. `AuthError` → status → envelope

| `AuthErrorCode` | HTTP status | Envelope `code` | Thrown at |
|---|---|---|---|
| `UNAUTHENTICATED` | 401 | `UNAUTHENTICATED` | `src/auth/guard.ts:84`, `:73` |
| `SESSION_EXPIRED` | 401 | `SESSION_EXPIRED` | `src/auth/guard.ts:72` |
| `FORBIDDEN` | 403 | `FORBIDDEN` | `src/auth/guard.ts:99` |

The code set is closed by the type `AuthErrorCode` (`src/auth/guard.ts:49`) and the status travels on
the error object itself (`src/auth/guard.ts:52-59`). Every wrapper maps it identically —
`errorResponse(err.code, err.message, err.status)` — at
`src/services/read/http.ts:57`, `src/services/action/index.ts:106`,
`src/services/action/onboarding.ts:39`, `src/services/action/taxMappings.ts:56`,
`src/services/action/dimensionMappings.ts:51`, `src/statements/http.ts:26`,
`src/reply-drafts/http.ts:20`, `src/accounting/write-gates-http.ts:19`,
`src/accounting/document-review-http.ts:24`, `src/services/action/connections.ts:30`.

These three codes pass through `normalizeCode` unchanged (`ipc-error-contract.md` § 2). All three
carry a plain-language message from the code table, not from the `AuthError` — note that
`AuthError`'s default message is the code string itself (`src/auth/guard.ts:55`), which is exactly the
kind of raw token the UI must never show (`.ralph/guardrails.md:96`).

### 4.1 Both 401s are treated identically by the renderer

`app/lib/session.tsx:36-39` redirects to `/login` on any non-200. `SESSION_EXPIRED` and
`UNAUTHENTICATED` therefore produce the same user-visible outcome, and CHUNK_3 must not collapse them
in the envelope anyway — the distinction is in the audit trail and in
`ipc-contract.test.ts`'s assertions.

---

## 5. The declaration rule

> **Each channel declares the SAME role requirement its route had. Not a stricter one, not a looser
> one, not a unified one.**

The registry's `role` field is the machine-readable record of that requirement
(`ipc-schema-registry.md` § 2). It is **documentation and test fixture, not a second gate** — the
real gate is the `role` argument that reaches `readContext`, which for most channels is baked into the
wrapper the dispatcher calls and is not the dispatcher's to choose. Where the dispatcher does choose
(the `runRead` channels, where it supplies `opts.role`), the value MUST equal the registry's `role`.

`test/ipc-contract.test.ts` asserts, for every channel, that each role outside `registry[channel].role`
receives `FORBIDDEN` and each role inside it does not
(`specs/03_CHUNK_3_IPC.md:21`, `:52`).

### 5.1 Where the role requirement is stated, per channel

Each row cites the *code* that enforces it, since the code wins over any document
(`CLAUDE.md`, "The guarantees"). The route map's inventory
(`docs/build/route-to-service-map.md:111-149`) is the cross-check.

#### Any authenticated role (`readContext` called with **no** role argument)

| Channel | Enforcement site |
|---|---|
| `aphub:today:list` | `runRead(request, …)` with no `opts.role` — `app/api/today/route.ts:5`; funnel at `src/services/read/http.ts:55` |
| `aphub:transactions:list` | `app/api/transactions/route.ts:6` |
| `aphub:transactions:get` | `app/api/transactions/[id]/route.ts:9` |
| `aphub:exceptions:list` | `app/api/exceptions/route.ts:6` |
| `aphub:exceptions:get` | `app/api/exceptions/[id]/route.ts:9` |
| `aphub:items:evidence` | `app/api/items/[id]/evidence/route.ts:9` |
| `aphub:audit:list` | `app/api/audit/route.ts:8` |
| `aphub:notifications:list` | `app/api/notifications/route.ts:6` |
| `aphub:me:get` | `app/api/me/route.ts:7` |
| `aphub:notifications:mark-read` | `readContext(request)` — no role — `src/services/action/notifications.ts:22` |
| `aphub:onboarding:get` | `runOnboardingAction(request, undefined, …)` — `src/services/action/onboarding.ts:61` |

Route-map cross-check: `docs/build/route-to-service-map.md:112-113` (reads),
`:134` (`notifications/:id/read` — "any authenticated"), and `:109` ("`runRead` with no role means any
authenticated role").

The last two are the ones a careless unification would break: `aphub:notifications:mark-read` is a
**mutation open to every role including `cpa`**, and `aphub:onboarding:get` passes `undefined`
explicitly through a wrapper whose sibling calls pass `'owner_controller'`.

#### `owner_controller`, `bookkeeper`, `cpa` (all three, stated explicitly)

| Channel | Enforcement site |
|---|---|
| `aphub:accounting-documents:review` | `src/accounting/document-review-http.ts:7-9` |
| `aphub:statements:list` | `app/api/statements/route.ts:6-8` |
| `aphub:statements:get` | `app/api/statements/[id]/route.ts:8-10` |
| `aphub:reply-drafts:get` | `src/reply-drafts/http.ts:64` |
| `aphub:provider-capabilities:list` | `app/api/provider-capabilities/route.ts:12` — passes `ROLES` itself |

Route-map cross-check: `docs/build/route-to-service-map.md:118-122`.

Functionally identical to "any authenticated role" today, since `ROLES` has exactly three members —
but the registry records the enumerated form, because that is what the code says, and a fourth role
added later must not silently gain access to these five while the nine above stay open by design.

#### `owner_controller` + `bookkeeper`

| Channel | Enforcement site |
|---|---|
| `aphub:proposals:reject` | `src/services/action/index.ts:179` |
| `aphub:corrections:learn` | `src/services/action/index.ts:226` |
| `aphub:mappings:remap` | `src/services/action/index.ts:209` |
| `aphub:accounting-documents:classify` | `src/accounting/document-review-http.ts:14` |
| `aphub:reply-drafts:create` | `mutation()` — `src/reply-drafts/http.ts:52` |
| `aphub:reply-drafts:update` | `mutation()` — `src/reply-drafts/http.ts:52` |
| `aphub:reply-drafts:discard` | `src/reply-drafts/http.ts:122` (inline, not via `mutation()`) |
| `aphub:statements:correct` | `action()` — `src/statements/http.ts:24` |
| `aphub:statements:file` | `action()` — `src/statements/http.ts:24` |
| `aphub:statements:match-line` | `action()` — `src/statements/http.ts:24` |
| `aphub:statements:exclude-line` | `action()` — `src/statements/http.ts:24` |

Route-map cross-check: `docs/build/route-to-service-map.md:129`, `:131-133`, `:138-140`.

#### `owner_controller` only

| Channel | Enforcement site |
|---|---|
| `aphub:proposals:approve` | `src/services/action/index.ts:157` |
| `aphub:proposals:retry` | `src/services/action/index.ts:167` |
| `aphub:replies:send` | `src/services/action/index.ts:267` |
| `aphub:onboarding:step` | `src/services/action/onboarding.ts:69` |
| `aphub:onboarding:dry-run` | `src/services/action/onboarding.ts:79` |
| `aphub:provider-connections:write-gate` | `src/accounting/write-gates-http.ts:8` |
| `aphub:provider-jobs:list` | `app/api/provider-jobs/route.ts:4` |
| `aphub:provider-jobs:retry` | `app/api/provider-jobs/[id]/retry/route.ts:10` — inline `requireSession(tokenFromRequest(request), 'owner_controller')` |
| `aphub:tax-mappings:list` | `runTaxMappingRead` — `src/services/action/taxMappings.ts:77` |
| `aphub:tax-mappings:get` | `runTaxMappingRead` — `src/services/action/taxMappings.ts:77` |
| `aphub:tax-mappings:audit` | `runTaxMappingRead` — `src/services/action/taxMappings.ts:77` |
| `aphub:tax-mappings:discover` | `runTaxMappingRead` — `src/services/action/taxMappings.ts:77` |
| `aphub:tax-mappings:create` | `runTaxMappingAction` — `src/services/action/taxMappings.ts:54` |
| `aphub:tax-mappings:edit` | `runTaxMappingAction` — `src/services/action/taxMappings.ts:54` |
| `aphub:tax-mappings:disable` | `runTaxMappingAction` — `src/services/action/taxMappings.ts:54` |
| `aphub:tax-mappings:replace` | `runTaxMappingAction` — `src/services/action/taxMappings.ts:54` |
| `aphub:tax-mappings:revalidate` | `runTaxMappingAction` — `src/services/action/taxMappings.ts:54` |
| `aphub:dimension-mappings:list` | `runDimensionMappingRead` — `src/services/action/dimensionMappings.ts:75` |
| `aphub:dimension-mappings:accept` | `runDimensionMappingAction` — `src/services/action/dimensionMappings.ts:49` |
| `aphub:dimension-mappings:select-alternate` | `src/services/action/dimensionMappings.ts:49` |
| `aphub:dimension-mappings:correct` | `src/services/action/dimensionMappings.ts:49` |
| `aphub:dimension-mappings:save-rule` | `src/services/action/dimensionMappings.ts:49` |
| `aphub:dimension-mappings:reject` | `src/services/action/dimensionMappings.ts:49` |

Route-map cross-check: `docs/build/route-to-service-map.md:123`, `:128`, `:130`, `:135-137`,
`:141-143`.

Note that the tax-mapping and dimension-mapping **reads** are owner-only, unlike every other read in
the system. `runTaxMappingRead` and `runDimensionMappingRead` hard-code `'owner_controller'`
(`src/services/action/taxMappings.ts:77`, `src/services/action/dimensionMappings.ts:75`), and the
bridge comments state the intent (`src/services/action/taxMappings.ts:25-26`,
`src/services/action/dimensionMappings.ts:21`). Routing them through the generic `runRead` would
widen them to every role — that is the exact failure this document exists to prevent.

---

## 6. Cross-tenant isolation is a `null` → 404, not a filter

`runRead`'s handler returns the row or `null`; `null` becomes 404 `NOT_FOUND`
(`src/services/read/http.ts:62-64`). The comment at `src/services/read/http.ts:10-12` states the
property: a tenant-scoped query returns no row → handler returns `null` → 404, so foreign rows can
never be returned.

The IPC contract preserves this because the dispatcher passes `ctx.tenantId` from the resolved
context into the same query functions, exactly as the route files do (e.g.
`app/api/exceptions/[id]/route.ts:9`). The dispatcher never accepts a tenant id from the payload
(§ 1), so there is no way to ask for another tenant's row in the first place.

`specs/03_CHUNK_3_IPC.md:52` requires this replayed for **every** channel, not a sample.
`test/f5-cross-tenant-isolation.test.ts` is the existing pattern to extend; it builds requests with
`Authorization: Bearer` and a `http://localhost/api/...` URL
(`test/f5-cross-tenant-isolation.test.ts:38-42`), which the synthetic-`Request` design keeps valid.
