# IPC envelope contract

**Frozen 2026-07-26.** Owns: how an IPC call becomes a `Request`, how the returned `Response` becomes
the wire envelope, and how HTTP status survives the bridge.

An agent building the dispatcher needs this document and `ipc-schema-registry.md`. Nothing else.

---

## 1. The three hops

```
renderer                    preload bridge              main process
────────                    ──────────────              ────────────
app/lib/api.ts              desktop/preload.ts          dispatcher (NEW)
apiGet / apiPost      →     aphub.invoke(channel,  →    1 allowlist re-check
apiPatch / apiDelete        payload)                    2 zod validate payload
                                                        3 synthesize Request
                                                        4 call the existing run* wrapper
                                                        5 decode its Response
                            ← IpcResult                 ← IpcResult
```

`desktop/preload.ts:41-44` already refuses any channel outside `IPC_CHANNELS`
(`desktop/channels.ts:35-37`), and `desktop/main.ts:236-239` re-checks it. Both checks are CHUNK_1
work, verified complete, and are not redesigned here. The dispatcher registers on the same
`ipcMain.handle` surface and MUST perform the same `isAllowedChannel` assertion before registering a
channel, exactly as `desktop/main.ts:237` does.

---

## 2. The wire envelope

```ts
/** desktop/preload.ts:18-23, plus the one additive field CHUNK_3 needs. */
export interface IpcResult<T = unknown> {
  ok: boolean;
  data?: T;
  code?: string;
  message?: string;
  status?: number;   // ADDITIVE — see § 4
}
```

Field rules:

| Field | Set when | Source |
|---|---|---|
| `ok` | always | `response.ok` — true for HTTP 200-299 |
| `status` | always, by the CHUNK_3 dispatcher | `response.status` |
| `data` | the decoded body had a `data` key | `body.data` from `jsonResponse` (`src/services/read/http.ts:16`) |
| `code` | the decoded body had an `error.code` key | `body.error.code` from `errorResponse` (`src/services/read/http.ts:23`), **then normalized** per `ipc-error-contract.md` § 2 |
| `message` | `code` is set | **looked up from `code`**, never forwarded from the body — `ipc-error-contract.md` § 3 |

`ok` and `code` are **not mutually exclusive.** See § 5.3 — this is load-bearing and the naive
"2xx ⇒ `{ok:true,data}` / else ⇒ `{ok:false,code,message}`" rule silently drops a real case.

---

## 3. Session-token custody — HARD RULE

> **The session token is held in the main process. The dispatcher injects it. The renderer never
> supplies it, never sees it, and cannot override it.**

Concretely:

1. No channel's zod request schema may contain a token, session, user, tenant, role, or actor field.
   Every registry entry is `.strict()` (`ipc-schema-registry.md` § 3), so a renderer that adds one
   gets `VALIDATION` before the service is reached.
2. The dispatcher sets the `cookie` header from a main-process variable. There is no code path from
   the IPC payload to that header.
3. On sign-out the main process discards the variable. A renderer holding a stale channel call
   cannot re-authenticate itself.

**Why.** A renderer-supplied token would let a compromised renderer choose its own identity: it
could present any token it obtained (another OS user's, a replayed one, a token minted for a
different tenant) and `requireSession` would faithfully resolve it, because `requireSession`'s job is
to answer "who does this token belong to", not "was this caller entitled to hold it"
(`src/auth/guard.ts:80-103`). Tenant and role are derived entirely from the resolved session
(`src/auth/guard.ts:88-94`), so whoever controls the token controls the tenant. The renderer is the
one process in the system that runs untrusted-shaped content; it is therefore the one process that
must not be able to name its own identity. `desktop/preload.ts` already applies the same principle
to channels — the renderer names a channel from a fixed list and nothing else
(`desktop/channels.ts:9-11`).

### 3.1 Header format — exact

`tokenFromRequest` reads the signed cookie first, then falls back to `Authorization: Bearer`
(`src/services/read/http.ts:30-36`). The dispatcher uses the **cookie** branch, so the production
path is the same one the browser exercises today.

```ts
import { SESSION_COOKIE_NAME, signSessionValue } from '../src/auth/session.js';
// src/auth/session.ts:106 and :113

headers.set('cookie', `${SESSION_COOKIE_NAME}=${signSessionValue(rawToken)}`);
// → "aphub_session=<token>.<hmac-sha256-base64url>"
```

`signSessionValue` is required: `readSessionCookie` verifies the HMAC and returns `null` for an
unsigned value (`src/auth/session.ts:150-161`, via `verifySessionValue` at `:126-128`). Sending the
raw token as the cookie value resolves to no session and every channel returns `UNAUTHENTICATED`.

`SESSION_COOKIE_SECRET` is a required config value with a 32-character minimum
(`src/config.ts:110-112`), so signing cannot fail in a validly configured engine.

**When the main process holds no token**, the dispatcher sets no `cookie` header at all. Do not send
an empty cookie: `tokenFromRequest` returns `null`, `requireSession` throws
`AuthError(401,'UNAUTHENTICATED')` (`src/auth/guard.ts:84`), and the channel returns 401 — which is
exactly what `app/lib/session.tsx:36-39` already treats as "redirect to login".

The `Authorization: Bearer` branch stays valid and is what `test/ipc-contract.test.ts` may keep using
when it drives the wrappers directly, exactly as `test/f5-cross-tenant-isolation.test.ts:38-42`
does today. Both branches converge on the same `requireSession` call, so a test using Bearer proves
the same funnel.

---

## 4. HTTP status carriage — the mechanism

`status` is carried as a **top-level optional number on `IpcResult`**, alongside `ok`.

Rejected alternatives, for the record: putting status inside `data` breaks `apiGet`'s unwrap of
`body.data` (`app/lib/api.ts:22`) and pollutes every payload; putting it only inside the error object
loses it on success, where `apiPost` callers branch on 201 and 202
(`docs/build/route-to-service-map.md:81`).

### Absent-status default

`status` is **optional**, and the adapter MUST default it:

```ts
const status = result.status ?? (result.ok ? 200 : 500);
```

This is what keeps the field additive. The two CHUNK_1 shell channels return
`{ ok: true, data }` with no status (`desktop/main.ts:238`) and the frozen `CHANNEL_REFUSED` object
returns `{ ok:false, code:'INTERNAL', message }` with no status
(`desktop/preload.ts:25-30`). Neither needs to change, and neither is redesigned.

### Three shared-file edits the integration lead owns

CHUNK_3 needs three additive edits to shared files, and **the integration lead applies all three**
(`docs/build/file-ownership.md:9-22`, `:54`). No implementation agent edits them.

1. `desktop/channels.ts` — import `READ_CHANNELS` and `ACTION_CHANNELS` and spread them into
   `IPC_CHANNELS` (`desktop/channels.ts:20-23` already reserves this: "CHUNK_3/5/7 append their own
   lists here"). Those two modules must have **zero imports** — see
   `ipc-schema-registry.md` § 6.1 for why, and note that this rules out deriving the allowlist from
   the registry.
2. `desktop/preload.ts` — add `status?: number;` to the `IpcResult` interface
   (`desktop/preload.ts:18-23`). One line, additive, optional, no runtime behaviour change:
   `invoke` already relays whatever object the main process returned (`desktop/preload.ts:43`).
3. `desktop/main.ts` — one call to `registerProductHandlers()` beside the existing
   `registerShellHandlers()` (`desktop/main.ts:264`, inside `app.whenReady()` at `:261`).

No file under `src/**` changes at all.

---

## 5. Synthesizing the `Request`

Every registry entry supplies `method`, `pathTemplate`, and the split between path params, query
params and body (`ipc-schema-registry.md` § 2).

```ts
function synthesize(entry: RegistryEntry, payload: Record<string, unknown>, token: string | null): Request {
  const path = entry.pathTemplate.replace(/:([A-Za-z][A-Za-z0-9]*)/g, (_m, k) => String(payload[k]));
  const url = new URL(`http://localhost${path}`);
  for (const key of entry.queryParams ?? []) {
    const v = payload[key];
    if (v !== undefined && v !== null) url.searchParams.set(key, String(v));
  }

  const headers = new Headers({ 'content-type': 'application/json' });
  if (token) headers.set('cookie', `${SESSION_COOKIE_NAME}=${signSessionValue(token)}`);

  const bodyKeys = entry.bodyKeys ?? [];
  const body: Record<string, unknown> = {};
  for (const k of bodyKeys) if (payload[k] !== undefined) body[k] = payload[k];

  return new Request(url, {
    method: entry.method,
    headers,
    // GET/HEAD must carry NO body — see § 5.2.
    body: entry.method === 'GET' ? undefined : JSON.stringify(body),
  });
}
```

No network call occurs. The `Request` is constructed in-process and consumed only by
`request.text()` / `request.json()` / `new URL(request.url)`. The origin `http://localhost` is never
dialed; it is chosen to match the precedent already in the suite
(`test/f5-cross-tenant-isolation.test.ts:41`).

### 5.1 Method selection — why it is per-channel and not per-shape

`method` comes from the registry, never inferred, because **`runOnboardingAction` branches on it**:

```ts
if (request.method === 'POST') { body = await parseBody(request); }
// src/services/action/onboarding.ts:43-49
```

`aphub:onboarding:get` therefore MUST be `GET` (its route is `GET /api/onboarding`,
`app/api/onboarding/route.ts:4`) and `aphub:onboarding:step` MUST be `POST`
(`app/api/onboarding/step/route.ts:4`). Sending `POST` for the read would attempt a body parse the
route never performs; sending `GET` for the step would silently deliver `{}` and lose `step` and
`automationLevel`.

Method per channel (from the route files, `app/api/**/route.ts`):

- **`GET`** — every read channel, plus `aphub:onboarding:get`, `aphub:tax-mappings:list|get|audit|discover`, `aphub:dimension-mappings:list`, `aphub:reply-drafts:get`.
- **`PATCH`** — `aphub:reply-drafts:update` only (`app/api/reply-drafts/[id]/route.ts:6`).
- **`DELETE`** — `aphub:reply-drafts:discard` only (`app/api/reply-drafts/[id]/route.ts:13`).
- **`POST`** — everything else.

### 5.2 Body rules — two hard constraints

**(a) A `GET` must carry no body.** The WHATWG `Request` constructor throws `TypeError` when a
GET/HEAD is given a body. Pass `undefined`.

**(b) A non-GET must ALWAYS carry a body string, minimum `'{}'`.** Four wrappers call
`request.json()` unconditionally, which throws `SyntaxError` on an empty body:

| Wrapper | Line | Behaviour on empty body |
|---|---|---|
| `action()` in statements | `src/statements/http.ts:30` | `SyntaxError` → caught at `:35` → `VALIDATION` 400 |
| `body()` in reply-drafts | `src/reply-drafts/http.ts:40` | throws → `error()` at `:36` → `INTERNAL` 500 |
| `runSetOwnerWriteGate` | `src/accounting/write-gates-http.ts:9` | throws → `:21` → `INTERNAL` 500 |
| `runClassifyDocument` | `src/accounting/document-review-http.ts:15` | throws → `:28` → `INTERNAL` 500 |

The consequence is concrete: **`aphub:statements:file` takes no fields, but must still be sent
`'{}'`**, because `runFileStatement` goes through `action()`
(`src/statements/http.ts:86-88`) which parses a body it then ignores.

The other three body parsers tolerate an empty body and return `{}`
(`src/services/action/index.ts:70-78`, `src/services/action/onboarding.ts:20-28`,
`src/services/action/taxMappings.ts:38-46`, `src/services/action/dimensionMappings.ts:33-41`).
Always sending `'{}'` is correct for all of them, so the rule is uniform: **non-GET ⇒ always a JSON
object string**.

### 5.3 Query params must be carried

Several wrappers read `new URL(request.url).searchParams` and receive nothing if the synthetic URL
has no query string:

| Wrapper | Line | Params read |
|---|---|---|
| `runReadReplyDraft` | `src/reply-drafts/http.ts:65` | `messageId` — **required**, 400 if absent (`:67-69`) |
| `runListTaxMappings` | `src/services/action/taxMappings.ts:133-139` | `connectionId`, `filter`, `provider` |
| `runDiscoverTaxCodes` | `src/services/action/taxMappings.ts:238` | `code` (its presence switches validate-one vs discover-all, `:239-244`) |
| `runListDimensionMappings` | `src/services/action/dimensionMappings.ts:144-150` | `connectionId`, `dimensionType`, `reviewStatus`, `resolutionState`, `provider` |

Four route files read `searchParams` themselves before calling `runRead`, so the dispatcher must
reproduce that read in its own handler closure (the closure is dispatcher code, not `src/**` code):

| Route file | Line | Param |
|---|---|---|
| `app/api/audit/route.ts` | `:5-7` | `action`, `entity` |
| `app/api/exceptions/route.ts` | `:5` | `status` |
| `app/api/notifications/route.ts` | `:5` | `unread` — compared to the **string** `'true'` |
| `app/api/transactions/route.ts` | `:5` | `status` (cast to `UxStatus`) |
| `app/api/statements/route.ts` | `:5` | `status` |

Because the dispatcher owns the closure for `runRead` channels, it may pass the validated value
directly instead of round-tripping through the URL. **Either is acceptable for `runRead` channels
only** — the closure is new code. For every wrapper in the table above the query string is
mandatory, because that wrapper is `src/**` code and is not edited.

### 5.4 Path params

`pathTemplate` exists so the synthetic URL is realistic and so `:id` values are visible in one place.
No `src/**` wrapper parses the path — the route files do
(`Number(params.id)`, e.g. `app/api/proposals/[id]/approve/route.ts:5`) and the dispatcher passes the
validated id as a positional argument instead:

```ts
return runApprove(request, payload.proposalId);   // src/services/action/index.ts:156
```

`params: Promise<{id}>` is a route-file-only concern. `app/api/provider-jobs/[id]/retry/route.ts:8`
declares `context: { params: Promise<{ id: string }> }` and awaits it at `:11`, unlike every other
dynamic route which declares `{ params: { id: string } }` (e.g.
`app/api/exceptions/[id]/route.ts:6`). Once the route file is deleted the asymmetry disappears — but
note that this route has **no exported `run*` wrapper at all**: its handler is inline
(`app/api/provider-jobs/[id]/retry/route.ts:9-22`). See `ipc-schema-registry.md` § 6.3 for how the
dispatcher reproduces it without editing `src/**`.

---

## 6. Decoding the `Response`

```ts
async function decode(res: Response): Promise<IpcResult> {
  const text = await res.text();
  let body: { data?: unknown; error?: { code?: string; message?: string } } = {};
  if (text.trim() !== '') {
    try { body = JSON.parse(text); } catch { body = {}; }
  }
  const out: IpcResult = { ok: res.ok, status: res.status };
  if (body.data !== undefined) out.data = body.data;
  if (body.error?.code) {
    out.code = normalizeCode(body.error.code);        // ipc-error-contract.md § 2
    out.message = plainMessage(out.code);             // ipc-error-contract.md § 3
  }
  return out;
}
```

Three properties of this function are deliberate.

**(a) `ok` comes from `res.ok`, not from the presence of `error`.** `errorResponse` is called with a
2xx status in one place: `errorResponse('QBO_RETRY', 'qbo post failed; safe to retry', 202)`
(`src/services/action/index.ts:153`). Today `apiPost` returns
`{ ok: true, status: 202, data: undefined, error: { code: 'QBO_RETRY', … } }` for it
(`app/lib/api.ts:40`), so `ok:true` **with a `code`** is an existing, reachable state. A decoder that
sets `ok = (code === undefined)` would flip that result to a failure and change retry-screen
behaviour. `ok` and `code` are independent fields.

**(b) A 2xx `data` may itself carry a code.** The `held` branch returns
`jsonResponse({ status: 'held', code: 'HELD_FOR_REVIEW', reason }, 202)`
(`src/services/action/index.ts:141`) — that code lives **inside `data`** and passes through
untouched. Do not hoist it to the envelope's `code`; screens read it from the payload today.

**(c) `message` is never forwarded.** `plainMessage(code)` replaces it. The reason is in
`ipc-error-contract.md` § 3: at least one service interpolates raw driver text into its message
(`src/services/taxMappings.ts:259`), which would violate guardrails
(`.ralph/guardrails.md:96`) and acceptance criterion `specs/03_CHUNK_3_IPC.md:24`.

### 6.1 Bodyless responses are out of scope by construction

Three wrappers return a `Response` with a `null` body and a 302 status:
`runConnectStart` (`src/services/action/connections.ts:28`), `app/api/auth/login/route.ts:18-24`, and
`app/api/auth/callback/route.ts:50`. `decode` would produce `{ ok:false, status:302 }` with no code —
useless. These are **not CHUNK_3 channels**; see `ipc-schema-registry.md` § 6.1.

---

## 7. Renderer adapter — reproducing both call behaviours

`app/lib/api.ts` and `app/lib/session.tsx` are the only two renderer files that change
(`specs/03_CHUNK_3_IPC.md:19`). **Zero page components change** (`specs/03_CHUNK_3_IPC.md:23`), which
is achievable only because status survives the bridge.

The throw/no-throw asymmetry is load-bearing (`docs/build/route-to-service-map.md:88-90`):

```ts
// apiGet KEEPS throwing. app/lib/api.ts:16-23 today.
export async function apiGet<T>(channel: string, payload?: unknown): Promise<T> {
  const r = await window.aphub.invoke(channel, payload);
  const status = r.status ?? (r.ok ? 200 : 500);
  if (!r.ok) throw new ApiError(r.code ?? 'INTERNAL', r.message ?? 'AP-Hub could not load that.', status);
  return r.data as T;
}

// apiPost / apiPatch / apiDelete NEVER throw. app/lib/api.ts:32-41, :43-59 today.
export async function apiPost<T>(channel: string, payload?: unknown): Promise<ActionResult<T>> {
  const r = await window.aphub.invoke(channel, payload);
  return {
    ok: r.ok,
    status: r.status ?? (r.ok ? 200 : 500),
    data: r.data as T | undefined,
    error: r.code ? { code: r.code, message: r.message ?? '' } : undefined,
  };
}
```

`ActionResult<T>` keeps its exact shape (`app/lib/api.ts:25-30`), so every screen that branches on
`status === 201 | 202 | 409 | 400` keeps working unchanged. `ApiError` keeps its
`(code, message, status)` constructor (`app/lib/api.ts:5-14`).

`proposalRefId` (`app/lib/api.ts:69-74`) is pure and does not change.

### 7.1 `session.tsx`

`app/lib/session.tsx:31-40` fetches `/api/me` and branches on `res.status === 200`. It becomes an
`aphub:me:get` invoke and branches on the decoded status the same way. The redirect to `/login` on
any non-200 (`app/lib/session.tsx:39`) is preserved verbatim — it is what turns an expired session
into a login prompt rather than a blank screen.

### 7.2 `window.aphub` typing

There is **no `window.aphub` type declaration in `app/` today** (verified: no `.d.ts` under `app/`,
and no `aphub` reference in `app/lib/`). The renderer-adapter agent creates one. It must type
`invoke` as returning `Promise<IpcResult>` with `status?: number` and must not re-declare the channel
list — the renderer names channels as string constants it imports or inlines; the allowlist lives
only in `desktop/channels.ts` (`desktop/channels.ts:30-37`).

---

## 8. Dispatcher skeleton — compiles against the real signatures

Lives in `desktop/ipc/dispatcher.ts`, with `synthesize`/`decode` in `desktop/ipc/envelope.ts`,
`normalizeCode`/`plainMessage` in `desktop/ipc/errors.ts`, `currentSessionToken` in
`desktop/ipc/context.ts`, and `REGISTRY` in `desktop/ipc/registry.ts` — all owned by agent B2
(`docs/build/file-ownership.md:40`).

```ts
import { runApprove, runReject, runRetry, runRemap, runLearn, runSendReply,
         runOnboardingGet, runOnboardingStep, runOnboardingDryRunAction,
         runMarkNotificationRead, runListTaxMappings, /* … */ } from '../src/services/action/index.js';
import { runRead, listExceptions /* … */ } from '../src/services/read/index.js';
import { SESSION_COOKIE_NAME, signSessionValue } from '../src/auth/session.js';

type Invoker = (request: Request, payload: Record<string, unknown>) => Promise<Response>;

async function dispatch(channel: string, rawPayload: unknown): Promise<IpcResult> {
  const entry = REGISTRY[channel];
  if (!entry) return CHANNEL_REFUSED_EQUIVALENT;            // never echo the channel name back
  const parsed = entry.request.safeParse(rawPayload ?? {});
  if (!parsed.success) return { ok: false, status: 400, code: 'VALIDATION', message: plainMessage('VALIDATION') };
  const request = synthesize(entry, parsed.data, currentSessionToken());
  const response = await entry.invoke(request, parsed.data);
  return decode(response);
}
```

Signatures the `invoke` thunks must match exactly:

| Wrapper | Real signature | Source |
|---|---|---|
| `runRead<T>` | `(request, handler: (ctx: AuthContext) => Promise<T>, opts?: { role?: Role \| readonly Role[] }) => Promise<Response>` | `src/services/read/http.ts:48-52` |
| `runApprove` | `(request, proposalId: number, deps?: PostDeps) => Promise<Response>` | `src/services/action/index.ts:156` |
| `runRetry` | `(request, proposalId: number, deps?: PostDeps) => Promise<Response>` | `src/services/action/index.ts:166` |
| `runReject` | `(request, proposalId: number) => Promise<Response>` | `src/services/action/index.ts:178` |
| `runRemap` / `runLearn` | `(request) => Promise<Response>` | `src/services/action/index.ts:208`, `:225` |
| `runSendReply` | `(request, replyId: number, deps?: ReplyDeps) => Promise<Response>` | `src/services/action/index.ts:266` |
| `runMarkNotificationRead` | `(request, notificationId: number) => Promise<Response>` | `src/services/action/notifications.ts:19` |
| `runOnboardingGet` / `runOnboardingStep` | `(request) => Promise<Response>` | `src/services/action/onboarding.ts:60`, `:68` |
| `runOnboardingDryRunAction` | `(request, deps?: DryRunDeps) => Promise<Response>` | `src/services/action/onboarding.ts:78` |
| `runSetOwnerWriteGate` | `(request, connectionId: number) => Promise<Response>` | `src/accounting/write-gates-http.ts:6` |
| `runClassificationReview` | `(request) => Promise<Response>` | `src/accounting/document-review-http.ts:6` |
| `runClassifyDocument` | `(request, documentId: number) => Promise<Response>` | `src/accounting/document-review-http.ts:12` |
| `runMatchStatementLine` | `(request, statementId: number, lineId: number) => Promise<Response>` | `src/statements/http.ts:44-48` |
| `runExcludeStatementLine` | `(request, statementId: number, lineId: number) => Promise<Response>` | `src/statements/http.ts:61-65` |
| `runCorrectStatement` / `runFileStatement` | `(request, statementId: number) => Promise<Response>` | `src/statements/http.ts:72`, `:86` |
| `runReadReplyDraft` | `(request, deps?: ReplyDraftDependencies) => Promise<Response>` | `src/reply-drafts/http.ts:59-62` |
| `runCreateReplyDraft` | `(request, deps?: ReplyDraftDependencies) => Promise<Response>` | `src/reply-drafts/http.ts:78-81` |
| `runUpdateReplyDraft` / `runDiscardReplyDraft` | `(request, draftId: number, deps?: ReplyDraftDependencies) => Promise<Response>` | `src/reply-drafts/http.ts:98-102`, `:116-120` |
| tax-mapping `run*` | `(request)` for list/create/discover; `(request, id: number)` for get/audit/edit/disable/replace/revalidate | `src/services/action/taxMappings.ts:130-246` |
| dimension-mapping `run*` | `(request)` for list; `(request, id: number)` for the five actions | `src/services/action/dimensionMappings.ts:141-211` |

The optional `deps?` parameters exist for test injection. **The dispatcher passes nothing for them**,
so production takes the real adapters — the same thing the route files do today (e.g.
`app/api/proposals/[id]/approve/route.ts:5` calls `runApprove(request, Number(params.id))`).

---

## 9. What this contract forbids

1. Editing anything under `src/**`. The whole design exists so this is unnecessary.
2. Exporting or unifying `runAction` or any of its five clones (README § "The architectural
   decision", with each clone's differing role default cited).
3. Inferring `method` from anything other than the registry entry (§ 5.1).
4. Sending a body on a `GET`, or omitting one on a non-GET (§ 5.2).
5. Deriving `ok` from the presence of `code`, or hoisting `data.code` into the envelope (§ 6).
6. Forwarding a service `message` to the renderer (§ 6c).
7. Accepting a token, tenant, user, role, or actor field in any request payload (§ 3).
8. Echoing a channel name back in a `message` — `desktop/preload.ts:28` establishes the rule: "no
   channel name echoed back, the renderer learns nothing from probing".
