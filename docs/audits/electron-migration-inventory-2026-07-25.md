# Route-by-Route Electron Migration Inventory

**Generated:** 2026-07-25 from `main` @ `fef9d43` · **Method:** every `app/api/**/route.ts` parsed for its exported HTTP methods and the `src/services/**` function it delegates to.

## Why this inventory exists

The architecture packet claimed the React tree moves into Electron without a rewrite. That claim
is only acceptable with a route-by-route accounting. This file is that accounting.

## Headline measurements

| Measurement | Value | How it was measured |
|---|---|---|
| Next.js pages | 14 | `git ls-files 'app/**/page.tsx'` |
| Pages that are `'use client'` | **14 of 14** | `head -1` on each page |
| Server components | **0** | no page lacks the `'use client'` directive |
| Server-side data fetching in a page | **0** | no page calls `src/` directly |
| API route files | 52 | `git ls-files 'app/api/**/route.ts'` |
| Total lines across all 52 route files | **528** | `wc -l` |
| Mean lines per route file | **~10** | 528 / 52 |
| Files in the renderer that perform network I/O | **2** | `app/lib/api.ts`, `app/lib/session.tsx:31` |
| Renderer files importing the transport | 19 | all import `app/lib/api` |

## What this means

Every route handler is a thin delegation of the same shape:

```ts
// app/api/today/route.ts — the entire file
import { runRead, getToday } from '../../../src/services/read/index.js';
export async function GET(request: Request): Promise<Response> {
  return runRead(request, (ctx) => getToday(ctx.tenantId));
}
```

Authentication, tenant scoping and RBAC live inside `runRead` / `runAction` / `runApprove` in
`src/services/**` — **not** in the route files. The routes contribute no business logic.

Therefore the migration is:

1. Replace the transport in **2 files** (`app/lib/api.ts`, `app/lib/session.tsx`) so `apiGet`/`apiPost` call `window.aphub.invoke(channel, payload)` instead of `fetch(path)`.
2. Add **one** IPC dispatcher that maps channel → the same `src/services/**` entry points, reusing `runRead`/`runAction`/`runApprove` with a synthesized context.
3. **Delete** the 528 lines of route files. They are not rewritten.
4. Change **0 of 14** page components.

## Fallback if any row below proves false during the build

If a route turns out to hold logic that is not in `src/services/**`, or a page turns out to need
server rendering, that route/page falls back to the **embedded-Next** approach: Electron starts the
existing Next.js server on a loopback port internally and loads it in the window. The user still
sees only a desktop window and never a browser or URL. This fallback is per-route, not all-or-nothing,
so a surprise cannot stall the phase.

## Inventory

| # | Route | Methods | Delegates to | Migration |
|---|---|---|---|---|
| 1 | `/api/accounting-documents/[id]/classify` | POST | runClassifyDocument src/accounting/document-review-http.js | IPC channel |
| 2 | `/api/accounting-documents/review` | GET | runClassificationReview src/accounting/document-review-http.js | IPC channel |
| 3 | `/api/audit` | GET | runRead src/services/read/index.js | IPC channel |
| 4 | `/api/auth/callback` | GET | src/auth/google-sso.js src/auth/session.js src/auth/sso-state.js src/config.js src/logger.js | IPC channel |
| 5 | `/api/auth/login` | GET | src/auth/google-sso.js src/auth/sso-state.js | IPC channel |
| 6 | `/api/auth/logout` | POST | src/auth/session.js | IPC channel |
| 7 | `/api/connections/gmail/start` | GET | runGmailConnectStart src/services/action/index.js | IPC channel |
| 8 | `/api/connections/qbo/start` | GET | runQboConnectStart src/services/action/index.js | IPC channel |
| 9 | `/api/corrections/learn` | POST | runLearn src/services/action/index.js | IPC channel |
| 10 | `/api/dimension-mappings/[id]/accept` | POST | runAcceptDimensionMapping src/services/action/index.js | IPC channel |
| 11 | `/api/dimension-mappings/[id]/correct` | POST | runCorrectDimensionMapping src/services/action/index.js | IPC channel |
| 12 | `/api/dimension-mappings/[id]/reject` | POST | runRejectDimensionMapping src/services/action/index.js | IPC channel |
| 13 | `/api/dimension-mappings/[id]/save-rule` | POST | runSaveRuleDimensionMapping src/services/action/index.js | IPC channel |
| 14 | `/api/dimension-mappings/[id]/select-alternate` | POST | runSelectAlternateDimensionMapping runs src/services/action/index.js | IPC channel |
| 15 | `/api/dimension-mappings` | GET | runListDimensionMappings src/services/action/index.js | IPC channel |
| 16 | `/api/exceptions/[id]` | GET | runRead src/services/read/index.js | IPC channel |
| 17 | `/api/exceptions` | GET | runRead src/services/read/index.js | IPC channel |
| 18 | `/api/items/[id]/evidence` | GET | runRead src/services/read/index.js | IPC channel |
| 19 | `/api/mappings/remap` | POST | runRemap src/services/action/index.js | IPC channel |
| 20 | `/api/me` | GET | runRead src/services/read/index.js | IPC channel |
| 21 | `/api/notifications/[id]/read` | POST | runMarkNotificationRead src/services/action/index.js | IPC channel |
| 22 | `/api/notifications` | GET | runRead src/services/read/index.js | IPC channel |
| 23 | `/api/onboarding/dry-run` | POST | runOnboardingDryRunAction src/services/action/index.js | IPC channel |
| 24 | `/api/onboarding` | GET | runOnboardingGet src/services/action/index.js | IPC channel |
| 25 | `/api/onboarding/step` | POST | runOnboardingStep src/services/action/index.js | IPC channel |
| 26 | `/api/proposals/[id]/approve` | POST | runApprove src/services/action/index.js | IPC channel |
| 27 | `/api/proposals/[id]/reject` | POST | runReject src/services/action/index.js | IPC channel |
| 28 | `/api/proposals/[id]/retry` | POST | runRetry src/services/action/index.js | IPC channel |
| 29 | `/api/provider-capabilities` | GET | runRead src/auth/guard.js src/services/read/index.js | IPC channel |
| 30 | `/api/provider-connections/[id]/write-gate` | POST | runSetOwnerWriteGate src/accounting/write-gates-http.js | IPC channel |
| 31 | `/api/provider-jobs/[id]/retry` | POST | src/auth/guard.js src/qbdesktop/durable-jobs.js src/services/read/http.js | IPC channel |
| 32 | `/api/provider-jobs` | GET | runRead src/services/read/index.js | IPC channel |
| 33 | `/api/replies/[id]/send` | POST | runSendReply src/services/action/index.js | IPC channel |
| 34 | `/api/reply-drafts/[id]` | DELETE,PATCH | runDiscardReplyDraft runUpdateReplyDraft src/reply-drafts/http.js | IPC channel |
| 35 | `/api/reply-drafts` | GET,POST | runCreateReplyDraft runReadReplyDraft src/reply-drafts/http.js | IPC channel |
| 36 | `/api/statements/[id]/correct` | POST | runCorrectStatement src/statements/http.js | IPC channel |
| 37 | `/api/statements/[id]/file` | POST | runFileStatement src/statements/http.js | IPC channel |
| 38 | `/api/statements/[id]/lines/[lineId]/exclude` | POST | runExcludeStatementLine src/statements/http.js | IPC channel |
| 39 | `/api/statements/[id]/lines/[lineId]/match` | POST | runMatchStatementLine src/statements/http.js | IPC channel |
| 40 | `/api/statements/[id]` | GET | runRead src/services/read/http.js src/statements/review.js | IPC channel |
| 41 | `/api/statements` | GET | runRead src/services/read/http.js src/statements/review.js | IPC channel |
| 42 | `/api/tax-mappings/[id]/audit` | GET | runGetTaxMappingAudit src/services/action/index.js | IPC channel |
| 43 | `/api/tax-mappings/[id]/disable` | POST | runDisableTaxMapping src/services/action/index.js | IPC channel |
| 44 | `/api/tax-mappings/[id]/edit` | POST | runEditTaxMapping src/services/action/index.js | IPC channel |
| 45 | `/api/tax-mappings/[id]/replace` | POST | runReplaceTaxMapping src/services/action/index.js | IPC channel |
| 46 | `/api/tax-mappings/[id]/revalidate` | POST | runRevalidateTaxMapping src/services/action/index.js | IPC channel |
| 47 | `/api/tax-mappings/[id]` | GET | runGetTaxMapping src/services/action/index.js | IPC channel |
| 48 | `/api/tax-mappings/discover` | GET | runDiscoverTaxCodes src/services/action/index.js | IPC channel |
| 49 | `/api/tax-mappings` | GET,POST | runCreateTaxMapping runListTaxMappings src/services/action/index.js | IPC channel |
| 50 | `/api/today` | GET | runRead src/services/read/index.js | IPC channel |
| 51 | `/api/transactions/[id]` | GET | runRead src/services/read/index.js | IPC channel |
| 52 | `/api/transactions` | GET | runRead src/services/read/index.js | IPC channel |
