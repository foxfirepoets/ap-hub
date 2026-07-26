# IPC error contract

**Frozen 2026-07-26.** Owns: the closed envelope code set, how the open-ended service codes are
normalized onto it, and the plain-language message for each code.

Acceptance criterion: "Every response is `{ ok: true, data }` or `{ ok: false, code, message }` with
`message` already plain language — no raw provider text crosses the bridge"
(`specs/03_CHUNK_3_IPC.md:24`).

---

## 1. The code set

### 1.1 Declared by the chunk spec

`FORBIDDEN`, `NOT_FOUND`, `DB_STARTING`, `DB_FAILED`, `PROVIDER_OFFLINE`, `PROVIDER_REAUTH`,
`CONNECT_TIMEOUT`, `SECURE_STORE` (`specs/03_CHUNK_3_IPC.md:38-39`).

The spec's list is incomplete on its own: it omits the two 401 auth codes that `requireSession`
actually throws (`src/auth/guard.ts:49`) and every code the services return today. The closed set
below is the union, and it is the authority for CHUNK_3.

### 1.2 Existing codes actually returned today

Grepped, not guessed. Two families:

**Literal codes** passed to `errorResponse(code, …)`:

| Code | Status | Site |
|---|---|---|
| `INTERNAL` | 500 | `src/services/read/http.ts:58`, `:68`; `src/services/action/index.ts:107`, `:120`; and 12 more sites |
| `NOT_FOUND` | 404 | `src/services/read/http.ts:63`; `src/services/action/index.ts:143`; `src/services/action/taxMappings.ts:168`; `src/reply-drafts/http.ts:71`; `app/api/provider-jobs/[id]/retry/route.ts:15` |
| `VALIDATION` | 400 | `src/services/action/index.ts:113`, `:181`, `:212`, `:229`, `:270`; `src/statements/http.ts:31`, `:35`; `src/accounting/write-gates-http.ts:12`; `src/accounting/document-review-http.ts:17`; `src/reply-drafts/http.ts:68`; and 5 more |
| `ALREADY_POSTED` | **409** | `src/services/action/index.ts:138` |
| `QBO_RETRY` | **202** | `src/services/action/index.ts:153` |
| `GMAIL_RECONNECT_REQUIRED` | 401 | `src/reply-drafts/http.ts:25` |
| `GMAIL_COMPOSE_SCOPE_REQUIRED` | **428** | `src/reply-drafts/http.ts:22`, code at `src/gmail/drafts.ts:49` |
| `DRAFT_RETRY` | 503 | `src/reply-drafts/http.ts:28`, code at `src/gmail/drafts.ts:57` |
| `DRAFT_RESULT_UNKNOWN` | 503 | `src/reply-drafts/http.ts:28`, code at `src/gmail/drafts.ts:66` |
| `UNSAFE_RETRY` | 409 | `app/api/provider-jobs/[id]/retry/route.ts:19` |
| `INVALID_ID` | 400 | `app/api/provider-jobs/[id]/retry/route.ts:13` |
| `UNAUTHENTICATED` / `SESSION_EXPIRED` / `FORBIDDEN` | 401/401/403 | `src/auth/guard.ts:49`, mapped at every wrapper's `AuthError` branch |

**`HELD_FOR_REVIEW` is not an error code.** It is returned inside a **202 success** payload:
`jsonResponse({ status: 'held', code: 'HELD_FOR_REVIEW', reason }, 202)`
(`src/services/action/index.ts:141`). It travels in `data`, not in the envelope's `code`, and must not
be hoisted (`ipc-envelope.md` § 6b).

**Derived codes** — every wrapper uppercases a `ServiceError.code`:
`errorResponse(err.code.toUpperCase(), err.message, status)`
(`src/services/action/index.ts:89`, `src/services/action/onboarding.ts:17`,
`src/services/action/taxMappings.ts:35`, `src/services/action/dimensionMappings.ts:30`,
`src/statements/http.ts:38`, `src/reply-drafts/http.ts:34`, `src/accounting/write-gates-http.ts:20`,
`src/accounting/document-review-http.ts:26`, `src/services/action/notifications.ts:16`).

`ServiceError.code` is a free-form string (`src/services/index.ts:42-49`), so this family is **open**.
The ones reachable today:

| Uppercased code | Status logic | Declared at |
|---|---|---|
| `VALIDATION` | 400 | ~40 sites, e.g. `src/services/dimensionMappings.ts:36`, `src/services/taxMappings.ts:23` |
| `*_NOT_FOUND` — `TAX_MAPPING_NOT_FOUND`, `DIMENSION_MAPPING_NOT_FOUND`, `PROPOSAL_NOT_FOUND`, `NOTIFICATION_NOT_FOUND`, `REPLY_NOT_FOUND`, `REPLY_DRAFT_NOT_FOUND`, `MESSAGE_NOT_FOUND`, `STATEMENT_NOT_FOUND`, `STATEMENT_LINE_NOT_FOUND`, `CONNECTION_NOT_FOUND`, `ACCOUNTING_DOCUMENT_NOT_FOUND` | 404 via `err.code.endsWith('_not_found')` | `src/services/taxMappings.ts:143`, `src/services/dimensionMappings.ts:145`, `src/services/proposals.ts:36`, `src/services/notifications.ts:31`, `src/services/reply.ts:56`, `src/reply-drafts/service.ts:163`, `:103`, `src/statements/review.ts:276`, `:216`, `src/accounting/write-gates.ts:29`, `src/accounting/document-review.ts:124` |
| `SOURCE_MESSAGE_MISSING` | 422 | `src/services/action/index.ts:87`; thrown at `src/services/reply.ts:59`, `src/reply-drafts/service.ts:105` |
| `DRY_RUN_LOCKED` | 403 | `src/services/action/index.ts:86`, `src/services/action/onboarding.ts:16` |
| `READ_BACK_FAILED` | **500** | `src/services/action/taxMappings.ts:32`, `src/services/action/dimensionMappings.ts:27`; thrown at `src/services/taxMappings.ts:57`, `src/services/dimensionMappings.ts:75`, `:88` |
| `REPLY_DRAFT_EXISTS`, `REPLY_DRAFT_ALREADY_SENT`, `REPLY_DRAFT_DISCARDED`, `REPLY_DRAFT_CONFLICT` | 409 via `src/reply-drafts/http.ts:32-33` | `src/reply-drafts/service.ts:239`, `:277`, `:278`, `:310` |

### 1.3 New codes the shell owns

`DB_STARTING`, `DB_FAILED`, `PROVIDER_OFFLINE`, `PROVIDER_REAUTH`, `CONNECT_TIMEOUT`, `SECURE_STORE`
(`specs/03_CHUNK_3_IPC.md:38-39`). No service returns these today. They originate in the dispatcher
and shell:

- `DB_STARTING` / `DB_FAILED` — the dispatcher returns these **without calling the service** when the
  bundled PostgreSQL is not yet ready. `desktop/main.ts:247` already reduces database state to the
  words `'ready'` / `'unavailable'` for the renderer; the dispatcher uses the same source of truth.
- `PROVIDER_OFFLINE`, `PROVIDER_REAUTH`, `CONNECT_TIMEOUT` — normalization targets for the Gmail/QBO
  failure codes in § 2.
- `SECURE_STORE` — the OS credential store could not be read or written. Not reachable from any
  channel in CHUNK_3's set; reserved for CHUNK_4/CHUNK_5. Declared here so the renderer's code union
  is complete and no later chunk widens it.

---

## 2. `normalizeCode` — the closed set the renderer sees

The service families are open-ended. The renderer's union must not be. `normalizeCode` runs in the
dispatcher, on `body.error.code`, before the envelope is built (`ipc-envelope.md` § 6).

```ts
const PASS_THROUGH = new Set([
  'UNAUTHENTICATED', 'SESSION_EXPIRED', 'FORBIDDEN',
  'NOT_FOUND', 'VALIDATION', 'INTERNAL',
  'ALREADY_POSTED', 'QBO_RETRY',
  'DB_STARTING', 'DB_FAILED', 'PROVIDER_OFFLINE', 'PROVIDER_REAUTH',
  'CONNECT_TIMEOUT', 'SECURE_STORE', 'CONFLICT',
]);

const EXPLICIT: Record<string, string> = {
  // Gmail / provider reachability
  GMAIL_RECONNECT_REQUIRED: 'PROVIDER_REAUTH',      // src/reply-drafts/http.ts:25
  GMAIL_COMPOSE_SCOPE_REQUIRED: 'PROVIDER_REAUTH',  // src/gmail/drafts.ts:49
  DRAFT_RETRY: 'PROVIDER_OFFLINE',                  // src/gmail/drafts.ts:57
  DRAFT_RESULT_UNKNOWN: 'PROVIDER_OFFLINE',         // src/gmail/drafts.ts:66
  // Conflicts the screens branch on by status 409
  UNSAFE_RETRY: 'CONFLICT',                         // app/api/provider-jobs/[id]/retry/route.ts:19
  REPLY_DRAFT_EXISTS: 'CONFLICT',                   // src/reply-drafts/service.ts:239
  REPLY_DRAFT_ALREADY_SENT: 'CONFLICT',             // src/reply-drafts/service.ts:277
  REPLY_DRAFT_DISCARDED: 'CONFLICT',                // src/reply-drafts/service.ts:278
  REPLY_DRAFT_CONFLICT: 'CONFLICT',                 // src/reply-drafts/service.ts:310
  // Validation-shaped
  INVALID_ID: 'VALIDATION',                         // app/api/provider-jobs/[id]/retry/route.ts:13
  SOURCE_MESSAGE_MISSING: 'VALIDATION',             // src/services/action/index.ts:87 (422)
  DRY_RUN_LOCKED: 'FORBIDDEN',                      // src/services/action/index.ts:86 (403)
  READ_BACK_FAILED: 'INTERNAL',                     // src/services/action/taxMappings.ts:32 (500)
};

export function normalizeCode(raw: string): string {
  if (PASS_THROUGH.has(raw)) return raw;
  if (EXPLICIT[raw]) return EXPLICIT[raw];
  if (raw.endsWith('_NOT_FOUND')) return 'NOT_FOUND';   // the whole ServiceError *_not_found family
  return 'INTERNAL';                                     // fail closed: an unmapped code leaks nothing
}
```

Three rules govern this function:

1. **The status is unaffected.** `normalizeCode` maps the code only. `SOURCE_MESSAGE_MISSING` still
   arrives as 422 and `DRY_RUN_LOCKED` still as 403; the envelope carries both the normalized code and
   the original status. Screens that branch on status keep working
   (`ipc-envelope.md` § 4).
2. **`CONFLICT` is added to the set** because `specs/03_CHUNK_3_IPC.md:38-39` has no code for a 409
   and four reachable service errors plus `UNSAFE_RETRY` produce one. `ALREADY_POSTED` stays distinct
   rather than collapsing into `CONFLICT`: it is the visible face of guarantee 4 (no double-post,
   `CLAUDE.md`) and the comment at `src/services/action/index.ts:137` documents it as such.
3. **The default is `INTERNAL`, not the raw code.** A code the dispatcher has never heard of is a code
   whose text has not been reviewed for provider content. Falling through to `INTERNAL` is the
   fail-closed choice, and it is what `desktop/preload.ts:25-30` already does for a refused channel.

---

## 3. `message` is replaced, never forwarded — and why

> **Rule: the dispatcher looks the message up from the normalized code. It never copies
> `body.error.message` into the envelope.**

This is not defensive style, it is required. Service messages interpolate arbitrary text:

```ts
throw new ServiceError('VALIDATION', `replace failed: ${(err as Error).message}`);
// src/services/taxMappings.ts:259  — a raw driver/provider Error message, verbatim
```

Others interpolate user or provider values:
`` `unknown onboarding step "${input.step}"` `` (`src/services/onboarding.ts:183`),
`` `invalid dimensionType '${s}'` `` (`src/services/dimensionMappings.ts:50`),
`` `dimension mapping ${id} not found` `` (`src/services/dimensionMappings.ts:145`),
`result.detail ?? 'alternate provider value failed validation'`
(`src/services/dimensionMappings.ts:211`).

Forwarding any of these violates three separate rules:

- `.ralph/guardrails.md:96` — "DO NOT BUILD: raw provider errors, stack traces, or error codes in the
  UI."
- `CLAUDE.md`, Conventions — "never surface OAuth, API, key, token, port, environment variable,
  migration, worker, model, JSON or a stack trace in the UI."
- `specs/03_CHUNK_3_IPC.md:24` — "no raw provider text crosses the bridge."

**Where does the useful detail go, then?** Into validation, which happens *before* the service is
reached (`ipc-schema-registry.md` § 4). A schema-owned message such as "A reason is required." is
written by us, contains no provider text, and is more accurate than the service's string because it
names the field the user is looking at. The service-layer message becomes a log line only — `logger`
already redacts (`CLAUDE.md`, Conventions).

### 3.1 The message table

One string per code in the closed set. Plain language, no jargon, always a next action. No code name,
no channel name (`desktop/preload.ts:28`), no field name unless the schema supplied it.

| Code | Status(es) | `message` |
|---|---|---|
| `UNAUTHENTICATED` | 401 | `You are signed out. Sign in to continue.` |
| `SESSION_EXPIRED` | 401 | `Your sign-in has timed out. Sign in again to continue.` |
| `FORBIDDEN` | 403 | `Your account does not have permission to do that. Ask the account owner.` |
| `NOT_FOUND` | 404 | `AP-Hub could not find that item. It may have been removed.` |
| `VALIDATION` | 400, 422 | `Some required details are missing or not valid. Check the highlighted fields and try again.` |
| `CONFLICT` | 409 | `Someone else changed this item first. Reload it and try again.` |
| `ALREADY_POSTED` | 409 | `This has already been sent to your accounting system, so AP-Hub did not send it again.` |
| `QBO_RETRY` | 202 | `Your accounting system did not respond. Nothing was recorded, so you can safely try again.` |
| `DB_STARTING` | 503 | `AP-Hub is still starting up. This usually takes a few seconds — try again shortly.` |
| `DB_FAILED` | 503 | `AP-Hub cannot open your data right now. Restart AP-Hub, and if it happens again use Repair.` |
| `PROVIDER_OFFLINE` | 503 | `AP-Hub could not reach that service. Check your internet connection and try again.` |
| `PROVIDER_REAUTH` | 401, 428 | `AP-Hub needs your permission again before it can continue. Reconnect the account in Settings.` |
| `CONNECT_TIMEOUT` | 504 | `Connecting took too long and was stopped. Try connecting again.` |
| `SECURE_STORE` | 500 | `AP-Hub could not read your saved sign-in details on this computer. Restart AP-Hub and try again.` |
| `INTERNAL` | 500, and any unmapped code | `AP-Hub could not complete that action.` |

The `INTERNAL` string is taken verbatim from `desktop/preload.ts:29`, so the refused-channel path and
the dispatcher's fallback are indistinguishable to the renderer — a probing renderer learns nothing
from the difference between "this channel does not exist" and "this channel failed".

### 3.2 Codes that must NOT get a message

`HELD_FOR_REVIEW` (`src/services/action/index.ts:141`) is a 202 success carried in `data`. It is not in
the table because it never becomes an envelope `code`. The screen renders it from the payload's
`reason` field, as it does today.

---

## 4. Validation errors, before the service

A payload that fails its zod schema returns:

```ts
{ ok: false, status: 400, code: 'VALIDATION', message: <schema message or the table's VALIDATION string> }
```

and **the service is never called** (`specs/03_CHUNK_3_IPC.md:51`). The schema may supply a more
specific plain-language message than the table's generic one — see `ipc-schema-registry.md` § 5 for
the authoring rules (no field paths from `zod`'s default messages, no raw values echoed back).

---

## 5. What this contract forbids

1. Copying `body.error.message` into the envelope (§ 3).
2. Returning a code outside the closed set of § 2 to the renderer.
3. Collapsing `ALREADY_POSTED` into `CONFLICT` (§ 2 rule 3), or `SESSION_EXPIRED` into
   `UNAUTHENTICATED` (`ipc-auth-context.md` § 4.1).
4. Hoisting `data.code` (`HELD_FOR_REVIEW`) into the envelope's `code` (§ 3.2).
5. Changing a status to match a normalized code (§ 2 rule 1). Status comes from the `Response`.
6. Including a channel name, table name, file path, port, SQL fragment, stack frame, or provider
   string in any `message`.
