# IPC schema registry contract

**Frozen 2026-07-26.** Owns: the zod validation contract, what goes inside each CHUNK_3 file, and the
complete 50-channel registry. File *ownership* is `docs/build/file-ownership.md:39-45`.

**This is new work, not a port.** There is no zod anywhere in the route or HTTP-bridge layer today —
`zod` appears in exactly four files: `src/config.ts`, `src/extract/schema.ts`,
`src/install/install-file.ts`, `src/statements/ingest.ts`
(`docs/build/route-to-service-map.md:66-72`). Every request body is validated by hand-rolled `typeof`
checks inside the `run*` bridges (e.g. `src/services/action/index.ts:180-181`,
`src/reply-drafts/http.ts:84-88`, `src/accounting/write-gates-http.ts:10-13`).

Installed zod is **3.25.76** (`package.json` declares `^3.24.1`), so the v3 API applies:
`z.object({…}).strict()`, `z.enum([...])`, `.max(n)`, `.int().positive()`.

---

## 1. Relationship to the hand-rolled checks

The zod layer is **added in front of**, not instead of, the existing checks. Nothing in `src/**` is
edited, so every `typeof` check still runs. That is deliberate:

- zod rejects malformed input before the service is reached
  (`specs/03_CHUNK_3_IPC.md:51`), which is what makes "a payload that fails its schema never reaches
  the service" testable.
- The service-layer checks remain the authority on business validity. Where the two disagree, the
  service wins by construction — it runs second.
- Therefore **a schema must never be stricter than the service on a value the service accepts**, or a
  working screen breaks. Where the tables below cite a cap or enum, the citation is to the service
  code that already enforces it. An uncited constraint is a schema-owned addition and is flagged.

---

## 2. `RegistryEntry`

```ts
// desktop/ipc/registry.ts  (owned by B2 — see § 6)
import type { ZodTypeAny } from 'zod';
import type { Role } from '../../src/auth/guard.js';

export interface RegistryEntry {
  /** `aphub:<domain>:<action>`, matching CHANNEL_PATTERN — desktop/channels.ts:28. */
  readonly channel: string;
  /** The SAME role requirement the route had. Documentation + test fixture — ipc-auth-context.md § 5. */
  readonly role: readonly Role[] | 'any';
  readonly request: ZodTypeAny;
  readonly response: ZodTypeAny;
  /** Never inferred — runOnboardingAction branches on it (src/services/action/onboarding.ts:43). */
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** e.g. '/api/proposals/:proposalId/approve'. `:name` keys are read from the payload. */
  readonly pathTemplate: string;
  /** Payload keys that become query-string params (ipc-envelope.md § 5.3). */
  readonly queryParams?: readonly string[];
  /** Payload keys that become the JSON body. Omitted keys are never forwarded. */
  readonly bodyKeys?: readonly string[];
  /** Calls the real, unmodified src/services wrapper. */
  readonly invoke: (request: Request, payload: Record<string, unknown>) => Promise<Response>;
}
```

Every payload key belongs to exactly one of three destinations: a `:param` in `pathTemplate`,
`queryParams`, or `bodyKeys`. A key in none of the three is silently dropped — so the schema and these
three lists must agree, and `test/ipc-contract.test.ts` asserts that every schema key is routed
somewhere.

`role: 'any'` means `readContext` is called with no role argument — see `ipc-auth-context.md` § 5.1,
"Any authenticated role".

---

## 3. Validation rules — all mandatory

**(a) `.strict()` on every request object.** Unknown keys are rejected with `VALIDATION`. This is the
mechanism that enforces token custody (`ipc-auth-context.md` § 1) and the recipient deny-list (§ 7),
so it is not optional and not per-channel.

```ts
z.object({ proposalId: entityId }).strict()
```

Nested objects are `.strict()` too — `providerRef` on `aphub:statements:match-line` is an object
(`src/statements/http.ts:50`) and must not become a bag for arbitrary keys.

**(b) Ids are positive integers.** `isValidId` requires `Number.isInteger(n) && n > 0`
(`src/services/index.ts:58-61`), and `assertEntityId` throws `VALIDATION` otherwise
(`src/services/index.ts:64-66`).

```ts
export const entityId = z.number().int().positive();
```

Do **not** accept the numeric-string form at the IPC boundary. `isValidId` tolerates numeric strings
because pg returns `bigint` columns as strings (`src/services/index.ts:51-57`), but an IPC payload is
authored by our own renderer and has no reason to send `"501"`. A single accepted type removes a class
of coercion bug. Note that `runReadReplyDraft` re-parses `messageId` from the query string with
`Number(raw)` and requires `Number.isInteger(messageId) && messageId > 0`
(`src/reply-drafts/http.ts:66-69`), so the value survives the round-trip.

**(c) Strings are capped.** Every string has an explicit `.max()`. Caps that mirror a service check
carry its citation; the rest are schema-owned and marked as such:

| Field | Cap | Source |
|---|---|---|
| `reason` (statements) | 1000 | `src/statements/review.ts:160` |
| `reason` (document classify) | 1000 | `src/accounting/document-review.ts:109` |
| `subject` (reply drafts) | 998 | `src/reply-drafts/service.ts:224`, `:280` |
| `bodyText` (reply drafts) | 100000 | `src/reply-drafts/service.ts:225`, `:281` |
| every other `reason` | 1000 | schema-owned; consistent with the two cited caps |
| short identifiers/labels (`sourceKey`, `provider`, `providerTaxCode`, `providerId`, `providerLabel`, `targetQboId`, `targetQboType`, `normalizedValue`, `confirmedCompanyId`, `field`, `newValue`) | 255 | schema-owned |
| free-text filters (`status`, `action`, `entity`) | 64 | schema-owned |

**(d) Enums are enumerated.** Where the service validates against a fixed set, the schema uses
`z.enum` with **exactly** that set:

| Field | Values | Source |
|---|---|---|
| `taxMode` | `exclusive`, `inclusive` | `src/services/taxMappings.ts:18` |
| `appliesAt` | `invoice`, `line` | `src/services/taxMappings.ts:19` |
| `dimensionType` | `account`, `item`, `class`, `location`, `department`, `customer`, `project`, `job`, `tracking_category`, `entity`, `tax_code`, `currency` | `src/services/dimensionMappings.ts:25-28` |
| `reviewStatus` | `pending`, `accepted`, `corrected`, `rejected`, `held` | `src/services/dimensionMappings.ts:29` |
| `resolutionState` | `mapped`, `not_provided`, `not_mapped`, `unsupported_by_provider`, `intentionally_blank` | `src/services/dimensionMappings.ts:30-32` |
| `classification` | `invoice`, `bank_statement`, `irrelevant` | `src/accounting/document-review.ts:111` |
| statement `status` filter | `extracted`, `unbalanced`, `review`, `ready`, `filed`, `held` | `src/statements/review.ts:79` |
| transaction `status` filter (`UxStatus`) | `prepared`, `held`, `posted`, `reconciled`, `rejected`, `exception` | `src/services/read/transactions.ts:12` |
| statement correctable `field` | `institutionName`, `accountHint`, `currency`, `periodStart`, `periodEnd`, `openingBalance`, `closingBalance` | `src/statements/review.ts:252-260` |
| tax-mapping list `filter` | `active`, `exception`, `all` | `src/services/action/taxMappings.ts:135` |
| dimension reject `status` | `rejected`, `held` | `src/services/dimensionMappings.ts:351`; default `rejected` at `src/services/action/dimensionMappings.ts:207` |

Two filters are **not** enumerated in code and must therefore be capped strings, not enums:
`exceptions.status` (`src/services/read/exceptions.ts:53-59` accepts any string) and
`audit.action` / `audit.entity` (`src/services/read/audit.ts:30-40`). Inventing an enum here would
reject values the service accepts, which rule § 1 forbids.

**(e) Optional means optional.** Where a service treats a missing value as "no filter" or "default",
the schema uses `.optional()` and the dispatcher omits the key entirely rather than sending `null` or
`''` — `runListTaxMappings` branches on `connectionIdRaw ? … : undefined`
(`src/services/action/taxMappings.ts:137`), so an empty string would be falsy but a `"null"` string
would not.

**(f) Response schemas are `.passthrough()`, not `.strict()`.** The response schema documents the
shape and gives `test/ipc-contract.test.ts` something to assert. It must not reject an extra field, or
a service adding a column breaks the app at runtime. Response payloads are our own data, already
tenant-scoped; the risk that `.strict()` guards against does not exist on that side.

---

## 4. Validation runs before the service is reached

```
invoke(channel, payload)
  → isAllowedChannel(channel)            desktop/preload.ts:42, re-checked desktop/main.ts:237
  → REGISTRY[channel] exists             else INTERNAL, no channel name echoed (preload.ts:28)
  → entry.request.safeParse(payload)     ← HERE. Failure ⇒ VALIDATION 400, service NOT called
  → synthesize Request                   ipc-envelope.md § 5
  → entry.invoke(...)                    the first line of src/** code that runs
```

`specs/03_CHUNK_3_IPC.md:51` states the acceptance test: "a channel invoked with a payload that fails
its zod schema rejects with a typed code and never reaches the service." The dispatcher must make that
observable — `test/ipc-contract.test.ts` asserts it with a spy on `invoke`.

`safeParse` is required, not `parse`. A thrown `ZodError` escaping into `ipcMain.handle` would be
serialized by Electron into a rejected promise whose message is a zod dump — field paths, received
values, and all. That is precisely the raw text the bridge must not carry
(`ipc-error-contract.md` § 3).

---

## 5. Validation messages

A zod failure produces `{ ok:false, status:400, code:'VALIDATION', message }`. The message comes from
one of two places:

1. A schema-authored message, written in plain language: `z.string().max(1000, 'Add a short reason
   (up to 1000 characters).')`.
2. Failing that, the generic string from `ipc-error-contract.md` § 3.1.

Never derived from `ZodError.issues`. `issue.path` leaks internal field names, `issue.received` echoes
the user's value back, and neither is plain language (`CLAUDE.md`, Conventions — the user is
non-technical and must never see JSON).

Pick **one** message per schema, not per field, unless the screen can act on the difference.

---

## 6. File layout — how the agents compose without collision

**`docs/build/file-ownership.md:39-45` is the authority on who owns which file.** This section says
only what goes inside those files. Where the two disagree, file-ownership wins and this section is the
defect.

```
desktop/ipc/
  registry.ts     B2   RegistryEntry type + shared zod primitives + REGISTRY assembly
  envelope.ts     B2   synthesize() + decode()                    (ipc-envelope.md § 5, § 6)
  errors.ts       B2   normalizeCode() + plainMessage()            (ipc-error-contract.md § 2, § 3)
  context.ts      B2   session-token custody: currentSessionToken(), cookie header
  dispatcher.ts   B2   registerProductHandlers(): ipcMain.handle per channel
  read/           B3   every channel whose `method` is GET  — 21 channels (§ 8.1 + § 8.2)
    channels.ts        READ_CHANNELS — ZERO imports (see § 6.1)
    <domain>.ts        one module per domain, exporting one entries array
  action/         B4   every channel whose `method` is not GET — 29 channels (§ 8.3 – § 8.8)
    channels.ts        ACTION_CHANNELS — ZERO imports (see § 6.1)
    <domain>.ts        one module per domain, exporting one entries array
```

Rules that make parallel work safe:

1. **The read/action split follows the channel's `method`, not the `src/**` path it calls.**
   `aphub:tax-mappings:list` is a B3 read channel even though `runListTaxMappings` lives in
   `src/services/action/taxMappings.ts:130` — because it is a `GET` and the renderer reaches it with
   `apiGet`. Following the `src/` path instead would split one domain across two agents.
   21 GET + 29 non-GET = 50.
2. **One domain module per file, exporting exactly one `readonly RegistryEntry[]`** named
   `<domain>Entries` in camelCase, and nothing else. Suggested modules — B3: `today.ts`,
   `transactions.ts`, `exceptions.ts`, `items.ts`, `audit.ts`, `notifications.ts`, `me.ts`,
   `statements.ts`, `providers.ts`, `accountingDocuments.ts`, `onboarding.ts`, `replyDrafts.ts`,
   `taxMappings.ts`, `dimensionMappings.ts`. B4: `proposals.ts`, `mappings.ts`, `statements.ts`,
   `replyDrafts.ts`, `taxMappings.ts`, `dimensionMappings.ts`, `onboarding.ts`, `notifications.ts`,
   `accountingDocuments.ts`, `providers.ts`. The same domain name may appear in both directories —
   different files, different owners, no collision.
3. **`registry.ts` is written first by B2 and then frozen**, and is the only assembly point:

```ts
// desktop/ipc/registry.ts  (B2)
export interface RegistryEntry { /* § 2 */ }
export const entityId = z.number().int().positive();          // shared primitives live here too,
export const reason = z.string().trim().min(1).max(1000);     // because B2 owns this file and B3/B4 import it

const ALL: readonly RegistryEntry[] = [...READ_ENTRIES, ...ACTION_ENTRIES];

export const REGISTRY: Readonly<Record<string, RegistryEntry>> = Object.freeze(
  ALL.reduce<Record<string, RegistryEntry>>((acc, e) => {
    if (acc[e.channel]) throw new Error('DUPLICATE_CHANNEL');   // fails the build, not production
    if (!CHANNEL_PATTERN.test(e.channel)) throw new Error('MALFORMED_CHANNEL'); // desktop/channels.ts:28
    return Object.assign(acc, { [e.channel]: e });
  }, {}),
);
```

B3 and B4 each expose one barrel array (`READ_ENTRIES`, `ACTION_ENTRIES`) from inside their own
directory, so `registry.ts` never needs editing when a domain module is added. There is **no
`types.ts`** — it is not in B2's owned file list (`docs/build/file-ownership.md:40`), so the type and
the primitives live in `registry.ts`. An agent that wants a separate file requests it from the
integration lead first.

4. **B2's `context.ts` is the only file that touches the session token.** No file under `read/` or
   `action/` may read, store, or set it (`ipc-auth-context.md` § 1).

### 6.1 The channel-name modules must have ZERO imports

`desktop/channels.ts` is bundled into the sandboxed preload, because a sandboxed preload cannot
resolve modules at runtime (`desktop/preload.ts:5-8`; `docs/build/file-ownership.md:52-53`). Anything
`channels.ts` imports is dragged into that bundle.

Therefore `desktop/ipc/read/channels.ts` and `desktop/ipc/action/channels.ts` are **bare `as const`
arrays of string literals with no imports of any kind** — no zod, no Electron, no Node builtin, no
`src/**` import, and no type-only import that pulls in a runtime module
(`docs/build/file-ownership.md:67-73`).

```ts
// desktop/ipc/read/channels.ts   (B3) — nothing above this line
export const READ_CHANNELS = ['aphub:today:list', 'aphub:transactions:list', /* … */] as const;
```

**Consequence for this contract:** the channel names are therefore stated twice — once in the
zero-import list and once in the registry entries. Do **not** try to derive `channels.ts` from the
registry: the registry imports zod and `src/**`, and importing it into the preload bundle reproduces
the CHUNK_2 `Dynamic require of "events"` failure class at the preload layer
(`docs/build/file-ownership.md:70-72`).

The duplication is made safe by assertion, not by discipline. `test/ipc-contract.test.ts` (B6) must
assert set equality between `[...READ_CHANNELS, ...ACTION_CHANNELS]` and `Object.keys(REGISTRY)`, in
both directions. A channel in the allowlist with no registry entry is dead surface; a registry entry
with no allowlist name is unreachable and would fail silently at
`desktop/preload.ts:42`.

The integration lead applies the single import-and-spread edit to `desktop/channels.ts` once
(`docs/build/file-ownership.md:65`).

### 6.1 Not channels — the five operations that do not port

52 route files carry **55 HTTP operations** (three files export two methods each:
`app/api/reply-drafts/route.ts:6,10`; `app/api/reply-drafts/[id]/route.ts:6,13`;
`app/api/tax-mappings/route.ts:5,9`). 50 become channels. Five do not, and
`specs/03_CHUNK_3_IPC.md:20` requires each to be **reported**, not silently dropped:

| Operation | Why not | Cite |
|---|---|---|
| `GET /api/auth/callback` | **Must not become a channel.** CHUNK_5 replaces it with the loopback callback on an ephemeral port. Returns a 302 with two `Set-Cookie` headers and a `null` body — undecodable by the envelope. | `docs/build/route-to-service-map.md:156-157`; `app/api/auth/callback/route.ts:50` |
| `GET /api/auth/login` | Google SSO as the product entry point is a scope exclusion; CHUNK_4_IDENTITY replaces it with local sign-in. 302 + `Set-Cookie`, `null` body. | `.ralph/guardrails.md:93`; `app/api/auth/login/route.ts:18-24` |
| `POST /api/auth/logout` | Sign-out must also discard the main-process token (`ipc-envelope.md` § 3), which no `src/**` wrapper can do. CHUNK_4 owns it as `aphub:session:end`. | `app/api/auth/logout/route.ts:5-10` |
| `GET /api/connections/gmail/start` | Returns 302 with a `location` header and `null` body (`src/services/action/connections.ts:28`). In the desktop the consent URL opens in the **system browser** via `shell.openExternal`, guarded by `isAllowedExternalUrl` — that is CHUNK_5's channel, and `specs/03_CHUNK_3_IPC.md:35` already assigns it. | `src/services/action/connections.ts:28`; `desktop/channels.ts:61-72` |
| `GET /api/connections/qbo/start` | Same. | `src/services/action/connections.ts:41-43` |

**Flagged inconsistency in the chunk spec.** `specs/03_CHUNK_3_IPC.md:35` illustrates
`aphub:connections:start` as returning `{ ok: true, state: 'browser_opened' }` — a top-level `state`
field that contradicts its own acceptance criterion at `specs/03_CHUNK_3_IPC.md:24` ("Every response is
`{ ok: true, data }` or `{ ok: false, code, message }`"). Resolved in favour of the acceptance
criterion: when CHUNK_5 adds the channel it returns
`{ ok: true, status: 200, data: { state: 'browser_opened' } }`. Recorded here so CHUNK_5 does not
re-open it.

### 6.2 Channel naming

`CHANNEL_PATTERN = /^aphub:[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/` — exactly two lowercase-kebab segments
after `aphub:` (`desktop/channels.ts:28`). The pattern is a shape check, never an admission rule: a
well-formed name nobody registered is still refused (`desktop/channels.ts:30-37`).

Domain = the route's first path segment; action = the verb. Two ids force a compound action:
`aphub:statements:match-line` and `aphub:statements:exclude-line`, because
`/api/statements/:id/lines/:lineId/match` has no single-segment verb.

### 6.3 `provider-jobs:retry` has no `src/**` wrapper

`app/api/provider-jobs/[id]/retry/route.ts:9-22` is the one product operation implemented **inline in
the route file**: it calls `requireSession(tokenFromRequest(request), 'owner_controller')` directly at
`:10`, then `new DurableProviderJobs().retry(actor.tenantId, jobId)` at `:14`. It also uses
`context: { params: Promise<{ id: string }> }` (`:8`, awaited at `:11`), unlike every other dynamic
route, which declares `{ params: { id: string } }` (e.g. `app/api/exceptions/[id]/route.ts:6`).

The dispatcher reproduces this handler in `desktop/ipc/action/providers.ts` (B4) — **copying the body
verbatim** and
keeping the same imports (`requireSession`, `tokenFromRequest`, `errorResponse`, `jsonResponse`,
`DurableProviderJobs`, `UnsafeProviderJobRetryError`). It does **not** move the logic into `src/**`,
because that would be a new export in a file this chunk must not edit, and it must not "improve" the
role check while copying. The `params: Promise` asymmetry vanishes with the route file: the dispatcher
passes the validated `jobId` directly.

The same applies, more mildly, to the seven `runRead` channels whose route file reads `searchParams`
before calling `runRead` (`ipc-envelope.md` § 5.3) — that closure is dispatcher code and is copied,
not relocated.

---

## 7. The recipient deny-list — reproduced at the IPC layer

> **`aphub:replies:send` rejects any payload containing `to`, `recipient`, `recipients`, `cc`, `bcc`,
> `email`, `address`, `to_address`, `toAddress`, `from`, `replyTo`. Dropping this is a defect.**

The list is verbatim from `src/services/action/index.ts:252-264`, and the check is presence-based, not
value-based, at `src/services/action/index.ts:268-271`:

```ts
const offending = RECIPIENT_FIELDS.filter((f) => Object.prototype.hasOwnProperty.call(body, f));
if (offending.length > 0) {
  return errorResponse('VALIDATION', `recipient fields are not permitted: ${offending.join(', ')}`, 400);
}
```

### Why it must be reproduced rather than relied upon

`runSendReply` is unmodified, so its check still fires — the IPC-layer copy is redundant **today**.
It is required anyway, for three reasons:

1. **Depth.** This is guarantee 2, the send-lockdown (`CLAUDE.md`, guarantee 2;
   `.ralph/guardrails.md:5-27`). The one permitted send call site is `sendForward` in
   `src/gmail/adapter.ts`, reachable only through `createLockedForwarder`, which binds one recipient at
   construction and takes no recipient parameter. A control this important is not left with a single
   enforcement point at a new transport boundary.
2. **Position.** The IPC copy rejects before any `src/**` code runs (§ 4), so a recipient field never
   reaches a body parser, a log line, or an audit row.
3. **Message hygiene.** The service's message echoes the offending field names back
   (`src/services/action/index.ts:270`). The IPC layer returns the plain `VALIDATION` string instead
   (`ipc-error-contract.md` § 3.1), so nothing about the deny-list is disclosed to a probing renderer.

Implementation — `.strict()` alone is necessary but not sufficient, because `.strict()` would reject an
unknown field with the same generic error and no explicit record of intent. Both layers are present:

```ts
// desktop/ipc/action/replyDrafts.ts   (B4)
export const RECIPIENT_FIELDS = [
  'to', 'recipient', 'recipients', 'cc', 'bcc', 'email',
  'address', 'to_address', 'toAddress', 'from', 'replyTo',
] as const;   // verbatim from src/services/action/index.ts:252-264

const sendRequest = z.object({ replyId: entityId })
  .strict()
  .superRefine((value, ctx) => {
    for (const f of RECIPIENT_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(value, f)) {
        ctx.addIssue({ code: 'custom', message: 'AP-Hub cannot change who a reply goes to.' });
        return;
      }
    }
  });
```

`test/ipc-contract.test.ts` must assert all eleven field names individually, and must assert that
`RECIPIENT_FIELDS` here is set-equal to the array at `src/services/action/index.ts:252-264` — so
adding a twelfth field there without adding it here fails the gate. **A scan expecting zero
occurrences of the deny-list is a defect** — the same rule the send-lockdown scan follows
(`.ralph/guardrails.md:18-21`).

`aphub:replies:send` carries `{ replyId }` and nothing else. `sendReply` takes no recipient parameter
(`src/services/action/index.ts:272`), and the reply route "decides only WHICH held forward to release,
never WHERE it goes" (`src/services/action/index.ts:248-251`).

---

## 8. The registry — all 50 channels

`role` column: `any` = `readContext` with no role argument; `O` = `owner_controller`;
`B` = `bookkeeper`; `C` = `cpa`. Enforcement citations are in `ipc-auth-context.md` § 5.1.

`P` = path param, `Q` = query param, `B:` = body key. Fields marked `?` are optional.

### 8.1 Reads — `runRead` (`src/services/read/http.ts:48`)

The dispatcher supplies both the handler closure and `opts.role`. Query functions come from
`src/services/read/index.ts:6-15`.

| Channel | Role | Method | pathTemplate | Request | Handler |
|---|---|---|---|---|---|
| `aphub:today:list` | any | GET | `/api/today` | `{}` | `getToday(ctx.tenantId)` — `app/api/today/route.ts:5` |
| `aphub:transactions:list` | any | GET | `/api/transactions` | `Q status?` (UxStatus enum) | `listTransactions(ctx.tenantId,{status})` — `app/api/transactions/route.ts:6` |
| `aphub:transactions:get` | any | GET | `/api/transactions/:id` | `P id` | `getTransactionById(ctx.tenantId,id)` — `app/api/transactions/[id]/route.ts:9` |
| `aphub:exceptions:list` | any | GET | `/api/exceptions` | `Q status?` (string ≤64) | `listExceptions(ctx.tenantId,{status})` — `app/api/exceptions/route.ts:6` |
| `aphub:exceptions:get` | any | GET | `/api/exceptions/:id` | `P id` | `getExceptionById(ctx.tenantId,id)` — `app/api/exceptions/[id]/route.ts:9` |
| `aphub:items:evidence` | any | GET | `/api/items/:id/evidence` | `P id` | `getEvidence(ctx.tenantId,id)` — `app/api/items/[id]/evidence/route.ts:9` |
| `aphub:audit:list` | any | GET | `/api/audit` | `Q action?`, `Q entity?` (≤64) | `listAudit(ctx.tenantId,{action,entity})` — `app/api/audit/route.ts:8` |
| `aphub:notifications:list` | any | GET | `/api/notifications` | `Q unread?: boolean` | `listNotifications(ctx.tenantId,{unreadOnly})` — `app/api/notifications/route.ts:5-6`; note the route compares to the **string** `'true'` |
| `aphub:me:get` | any | GET | `/api/me` | `{}` | inline: `{ email, role, tenantId }` from ctx — `app/api/me/route.ts:7-11` |
| `aphub:provider-capabilities:list` | O,B,C (`ROLES`) | GET | `/api/provider-capabilities` | `{}` | `listProviderCapabilities(ctx.tenantId)`, `opts.role = ROLES` — `app/api/provider-capabilities/route.ts:9-13` |
| `aphub:provider-jobs:list` | O | GET | `/api/provider-jobs` | `{}` | `listProviderJobs(ctx.tenantId)`, `opts.role=['owner_controller']` — `app/api/provider-jobs/route.ts:4` |
| `aphub:statements:list` | O,B,C | GET | `/api/statements` | `Q status?` (statement enum) | `listStatements(ctx.tenantId,status)` — `app/api/statements/route.ts:6-8` |
| `aphub:statements:get` | O,B,C | GET | `/api/statements/:id` | `P id` | `getStatement(ctx.tenantId,id)` — `app/api/statements/[id]/route.ts:8-10` |

`null` from any handler ⇒ 404 `NOT_FOUND` (`src/services/read/http.ts:62-64`), which is also the
cross-tenant answer (`ipc-auth-context.md` § 6).

### 8.2 Reads through a domain bridge

| Channel | Role | Method | pathTemplate | Request | `invoke` |
|---|---|---|---|---|---|
| `aphub:accounting-documents:review` | O,B,C | GET | `/api/accounting-documents/review` | `{}` | `runClassificationReview(request)` — `src/accounting/document-review-http.ts:6` |
| `aphub:onboarding:get` | any | GET | `/api/onboarding` | `{}` | `runOnboardingGet(request)` — `src/services/action/onboarding.ts:60`; role is `undefined` at `:61` |
| `aphub:reply-drafts:get` | O,B,C | GET | `/api/reply-drafts` | `Q messageId` (**required**) | `runReadReplyDraft(request)` — `src/reply-drafts/http.ts:59`; 400 if absent (`:67-69`) |
| `aphub:tax-mappings:list` | O | GET | `/api/tax-mappings` | `Q connectionId?`, `Q filter?` (`active\|exception\|all`), `Q provider?` | `runListTaxMappings(request)` — `src/services/action/taxMappings.ts:130` |
| `aphub:tax-mappings:get` | O | GET | `/api/tax-mappings/:id` | `P id` | `runGetTaxMapping(request, id)` — `src/services/action/taxMappings.ts:165` |
| `aphub:tax-mappings:audit` | O | GET | `/api/tax-mappings/:id/audit` | `P id` | `runGetTaxMappingAudit(request, id)` — `src/services/action/taxMappings.ts:175` |
| `aphub:tax-mappings:discover` | O | GET | `/api/tax-mappings/discover` | `Q code?` | `runDiscoverTaxCodes(request)` — `src/services/action/taxMappings.ts:235`; presence of `code` switches validate-one vs discover-all (`:239-244`) |
| `aphub:dimension-mappings:list` | O | GET | `/api/dimension-mappings` | `Q connectionId?`, `Q dimensionType?`, `Q reviewStatus?`, `Q resolutionState?`, `Q provider?` | `runListDimensionMappings(request)` — `src/services/action/dimensionMappings.ts:141` |

### 8.3 Mutations — proposals, corrections, mappings

| Channel | Role | Method | pathTemplate | Request | `invoke` | Success statuses |
|---|---|---|---|---|---|---|
| `aphub:proposals:approve` | O | POST | `/api/proposals/:proposalId/approve` | `P proposalId` | `runApprove(request, proposalId)` — `src/services/action/index.ts:156` | 201 posted, 202 queued, 202 held; 409 `ALREADY_POSTED`, 404, 202 `QBO_RETRY` — `src/services/action/index.ts:127-154` |
| `aphub:proposals:reject` | O,B | POST | `/api/proposals/:proposalId/reject` | `P proposalId`, `B: reason` (required, ≤1000), `B: markDuplicate?` | `runReject(request, proposalId)` — `:178` | 200 — `:186` |
| `aphub:proposals:retry` | O | POST | `/api/proposals/:proposalId/retry` | `P proposalId` | `runRetry(request, proposalId)` — `:166` | same as approve |
| `aphub:corrections:learn` | O,B | POST | `/api/corrections/learn` | `B: field`, `B: newValue` (both required), `B: proposalId?`, `B: exceptionId?`, `B: remember?`, `B: mapping?` (strict object: `kind`, `sourceKey`, `targetQboType?`, `targetQboId?`, `targetName?`, `remember?`) | `runLearn(request)` — `:225` | 200 — `:238` |
| `aphub:mappings:remap` | O,B | POST | `/api/mappings/remap` | `B: kind`, `B: sourceKey` (both required), `B: targetQboType?`, `B: targetQboId?`, `B: targetName?`, `B: remember?` | `runRemap(request)` — `:208` | 200 — `:221` |

`reason` required at `src/services/action/index.ts:180-181`; `field`/`newValue` at `:228-229`;
`kind`/`sourceKey` at `:211-212`; the nested `mapping` shape at `:192-206`.

### 8.4 Mutations — notifications, onboarding, documents, write gate

| Channel | Role | Method | pathTemplate | Request | `invoke` | Success |
|---|---|---|---|---|---|---|
| `aphub:notifications:mark-read` | any | POST | `/api/notifications/:notificationId/read` | `P notificationId` | `runMarkNotificationRead(request, notificationId)` — `src/services/action/notifications.ts:19` | 200 — `:29` |
| `aphub:onboarding:step` | O | POST | `/api/onboarding/step` | `B: step?`, `B: automationLevel?` | `runOnboardingStep(request)` — `src/services/action/onboarding.ts:68` | 200 — `:73` |
| `aphub:onboarding:dry-run` | O | POST | `/api/onboarding/dry-run` | `{}` | `runOnboardingDryRunAction(request)` — `:78` | **201** — `:81` |
| `aphub:accounting-documents:classify` | O,B | POST | `/api/accounting-documents/:documentId/classify` | `P documentId`, `B: classification` (enum), `B: reason` (≤1000) | `runClassifyDocument(request, documentId)` — `src/accounting/document-review-http.ts:12` | 200 — `:22` |
| `aphub:provider-connections:write-gate` | O | POST | `/api/provider-connections/:connectionId/write-gate` | `P connectionId`, **all four required**: `B: enabled` (boolean), `B: confirmedCompanyId` (string), `B: backupConfirmed` (boolean), `B: confirmation` (string) | `runSetOwnerWriteGate(request, connectionId)` — `src/accounting/write-gates-http.ts:6` | 200 — `:14` |
| `aphub:provider-jobs:retry` | O | POST | `/api/provider-jobs/:jobId/retry` | `P jobId` | copied inline handler — § 6.3 | 200; 404; 409 `UNSAFE_RETRY` |

`onboarding:step` sends `POST` so `runOnboardingAction` parses the body
(`src/services/action/onboarding.ts:43`). `onboarding:dry-run` also sends `POST` and `'{}'` — the
handler ignores the body (`:79-82`) but the branch is method-driven.

The write-gate's four-field requirement is enforced at `src/accounting/write-gates-http.ts:10-13`, and
the service additionally requires the literal confirmation text and exact company identity
(`src/accounting/write-gates.ts:14-18`). The schema validates presence and type only — the exact
literal stays the service's business (rule § 1).

### 8.5 Mutations — statements (all `O,B` via `action()`, `src/statements/http.ts:24`)

All four send `'{}'` at minimum: `action()` calls `request.json()` unconditionally
(`src/statements/http.ts:30`) — see `ipc-envelope.md` § 5.2.

| Channel | Method | pathTemplate | Request | `invoke` |
|---|---|---|---|---|
| `aphub:statements:correct` | POST | `/api/statements/:statementId/correct` | `P statementId`, `B: field` (correctable enum), `B: value` (string ≤255 **or null**), `B: reason` (≤1000) | `runCorrectStatement(request, statementId)` — `src/statements/http.ts:72` |
| `aphub:statements:file` | POST | `/api/statements/:statementId/file` | `P statementId` only — **body still `'{}'`** | `runFileStatement(request, statementId)` — `:86` |
| `aphub:statements:match-line` | POST | `/api/statements/:statementId/lines/:lineId/match` | `P statementId`, `P lineId`, `B: providerRef` (strict object, required), `B: reason` (≤1000) | `runMatchStatementLine(request, statementId, lineId)` — `:44` |
| `aphub:statements:exclude-line` | POST | `/api/statements/:statementId/lines/:lineId/exclude` | `P statementId`, `P lineId`, `B: reason` (≤1000) | `runExcludeStatementLine(request, statementId, lineId)` — `:61` |

`field`/`value`/`reason` triple checked at `src/statements/http.ts:74-77`; `providerRef` + `reason` at
`:51-53`; `reason` alone at `:67`. `value` may be `null` — `src/statements/review.ts:328-330`.

### 8.6 Mutations — reply drafts and the locked send

| Channel | Role | Method | pathTemplate | Request | `invoke` |
|---|---|---|---|---|---|
| `aphub:reply-drafts:create` | O,B | POST | `/api/reply-drafts` | `B: messageId` (positive int), `B: subject` (≤998), `B: bodyText` (≤100000), `B: reason?` (nullable) | `runCreateReplyDraft(request)` — `src/reply-drafts/http.ts:78` |
| `aphub:reply-drafts:update` | O,B | **PATCH** | `/api/reply-drafts/:draftId` | `P draftId`, `B: subject`, `B: bodyText`, `B: reason?` | `runUpdateReplyDraft(request, draftId)` — `:98` |
| `aphub:reply-drafts:discard` | O,B | **DELETE** | `/api/reply-drafts/:draftId` | `P draftId` | `runDiscardReplyDraft(request, draftId)` — `:116` |
| `aphub:replies:send` | O | POST | `/api/replies/:replyId/send` | `P replyId` **+ the deny-list refinement, § 7** | `runSendReply(request, replyId)` — `src/services/action/index.ts:266` |

`create` field checks at `src/reply-drafts/http.ts:83-88`; `update` at `:104-107`. Caps at
`src/reply-drafts/service.ts:224-225`, `:280-281`.

`discard` is `DELETE` and goes through the **inline** path, not `mutation()`
(`src/reply-drafts/http.ts:121-123`) — it never reads a body. `update` goes through `mutation()`, which
calls `body(request)` → `request.json()` (`src/reply-drafts/http.ts:53`, `:40`), so PATCH must carry
`'{}'` at minimum. **DELETE must carry `'{}'` too** by the uniform non-GET rule; the handler simply
never reads it.

### 8.7 Mutations — tax mappings (all `O`, `runTaxMappingAction`, `src/services/action/taxMappings.ts:54`)

| Channel | Method | pathTemplate | Request | `invoke` | Success |
|---|---|---|---|---|---|
| `aphub:tax-mappings:create` | POST | `/api/tax-mappings` | `B: connectionId` (number), `B: provider`, `B: providerTaxCode`, `B: internalTaxTreatment`, `B: taxMode` (enum), `B: appliesAt?` (enum), `B: reason?` | `runCreateTaxMapping(request)` — `:147` | **201** — `:159` |
| `aphub:tax-mappings:edit` | POST | `/api/tax-mappings/:id/edit` | `P id`, `B: internalTaxTreatment?`, `B: taxMode?`, `B: appliesAt?`, `B: reason` | `runEditTaxMapping(request, id)` — `:184` | 200 |
| `aphub:tax-mappings:disable` | POST | `/api/tax-mappings/:id/disable` | `P id`, `B: reason` | `runDisableTaxMapping(request, id)` — `:199` | 200 |
| `aphub:tax-mappings:replace` | POST | `/api/tax-mappings/:id/replace` | `P id`, `B: providerTaxCode?`, `B: internalTaxTreatment`, `B: taxMode` (enum), `B: appliesAt?`, `B: reason` | `runReplaceTaxMapping(request, id)` — `:209` | **201** — `:219` |
| `aphub:tax-mappings:revalidate` | POST | `/api/tax-mappings/:id/revalidate` | `P id`, `B: reason?` | `runRevalidateTaxMapping(request, id)` — `:225` | 200 |

`reason` is required by the service for edit/disable/replace (`src/services/taxMappings.ts:43`) and
optional for revalidate (`src/services/action/taxMappings.ts:227`). The route map states the same
(`docs/build/route-to-service-map.md:141`).

### 8.8 Mutations — dimension mappings (all `O`, `runDimensionMappingAction`, `src/services/action/dimensionMappings.ts:49`)

| Channel | Method | pathTemplate | Request | `invoke` | Success |
|---|---|---|---|---|---|
| `aphub:dimension-mappings:accept` | POST | `/api/dimension-mappings/:id/accept` | `P id`, `B: reason?` | `runAcceptDimensionMapping(request, id)` — `:158` | 200 |
| `aphub:dimension-mappings:select-alternate` | POST | `/api/dimension-mappings/:id/select-alternate` | `P id`, `B: providerId?`, `B: providerLabel?`, `B: reason?` | `runSelectAlternateDimensionMapping(request, id)` — `:168` | 200 |
| `aphub:dimension-mappings:correct` | POST | `/api/dimension-mappings/:id/correct` | `P id`, `B: normalizedValue`, `B: reason?` | `runCorrectDimensionMapping(request, id)` — `:182` | 200 |
| `aphub:dimension-mappings:save-rule` | POST | `/api/dimension-mappings/:id/save-rule` | `P id`, `B: reason?` | `runSaveRuleDimensionMapping(request, id)` — `:194` | **201** — `:198` |
| `aphub:dimension-mappings:reject` | POST | `/api/dimension-mappings/:id/reject` | `P id`, `B: reason`, `B: status?` (`rejected\|held`) | `runRejectDimensionMapping(request, id)` — `:204` | 200 |

`select-alternate` requires at least one of `providerId` / `providerLabel`
(`src/services/dimensionMappings.ts:193`) — express that as a `.superRefine`, not as two required
fields.

### 8.9 Count

13 (§ 8.1) + 8 (§ 8.2) + 5 (§ 8.3) + 6 (§ 8.4) + 4 (§ 8.5) + 4 (§ 8.6) + 5 (§ 8.7) + 5 (§ 8.8) = **50
channels**. Plus the five non-ports of § 6.1 = 55 HTTP operations across the 52 route files.

---

## 9. What this contract forbids

1. A request schema without `.strict()` (§ 3a).
2. Accepting a numeric string where an id is expected (§ 3b).
3. An uncapped string (§ 3c), or an enum that differs from the service's set (§ 3d).
4. `.strict()` on a response schema (§ 3f).
5. `parse` instead of `safeParse`, or any message derived from `ZodError.issues` (§ 4, § 5).
6. Two agents editing one domain module, or a second assembly point beside `registry.ts` (§ 6).
   Any import at all in `read/channels.ts` or `action/channels.ts` (§ 6.1).
7. Omitting or weakening the `aphub:replies:send` deny-list (§ 7).
8. Registering `/api/auth/callback` as a channel (§ 6.1).
9. Moving the inline `provider-jobs:retry` handler into `src/**` (§ 6.3).
