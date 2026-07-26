/**
 * CHUNK_3_IPC — the ACTION channel names. Every mutation in the product, and nothing else.
 *
 * ┌──────────────────────────────────────────────────────────────────────────────────────┐
 * │ THIS FILE HAS ZERO IMPORTS. NOT EVEN A TYPE-ONLY ONE. DO NOT ADD ONE.                │
 * └──────────────────────────────────────────────────────────────────────────────────────┘
 *
 * `desktop/channels.ts` spreads this list, and `desktop/channels.ts` is BUNDLED into the
 * sandboxed preload (`scripts/build-desktop.mjs`), because a sandboxed preload has no module
 * resolution at runtime. Anything this file imports is therefore dragged into that bundle. A
 * zod or `src/**` import here reproduces the CHUNK_2 `Dynamic require of "events"` failure —
 * the app launches, shows a window, and dies on first use — except at the preload layer, where
 * `test/desktop-packaging.test.ts` does not look. `test/ipc-foundation.test.ts:851` asserts the
 * importlessness, and `test/ipc-action-domains.test.ts` asserts this list is set-equal to
 * `ACTION_ENTRIES`, so the duplication is guarded by assertion rather than by discipline.
 *
 * The names, and the HTTP route each one replaces, are tabulated in
 * `desktop/ipc/action/index.ts`. Nothing here may be a template literal, a concatenation or a
 * derived value: `test/ipc-foundation.test.ts:864` scrapes literals out of this file with a
 * regex to cross-check them against the allowlist.
 */

export const ACTION_CHANNELS = [
  // proposals — the post path (guarantee 4: no double-post)
  'aphub:proposals:approve',
  'aphub:proposals:reject',
  'aphub:proposals:retry',

  // learn-forever corrections and reusable mapping rules
  'aphub:corrections:learn',
  'aphub:mappings:remap',

  // held-document classification
  'aphub:accounting-documents:classify',

  // notification feed
  'aphub:notifications:read',

  // first-run wizard
  'aphub:onboarding:step',
  'aphub:onboarding:dry-run',

  // the production-write owner gate (guarantee 3)
  'aphub:provider-connections:write-gate',

  // release a held gatekeeper forward through the locked forwarder (guarantee 2)
  'aphub:replies:send',

  // Gmail reply drafts — create/update/discard only; Gmail is never modified otherwise
  'aphub:reply-drafts:create',
  'aphub:reply-drafts:update',
  'aphub:reply-drafts:discard',

  // bank-statement review
  'aphub:statements:correct',
  'aphub:statements:file',
  'aphub:statements:match-line',
  'aphub:statements:exclude-line',

  // tax mappings (owner only)
  'aphub:tax-mappings:create',
  'aphub:tax-mappings:edit',
  'aphub:tax-mappings:disable',
  'aphub:tax-mappings:replace',
  'aphub:tax-mappings:revalidate',

  // dimension-mapping review queue (owner only)
  'aphub:dimension-mappings:accept',
  'aphub:dimension-mappings:correct',
  'aphub:dimension-mappings:reject',
  'aphub:dimension-mappings:save-rule',
  'aphub:dimension-mappings:select-alternate',

  // QuickBooks Desktop durable job retry
  'aphub:provider-jobs:retry',
] as const;
