/**
 * CHUNK_3_IPC — B3's read-domain channel names.
 *
 * ZERO IMPORTS. This module is bundled into the sandboxed preload
 * (`scripts/build-desktop.mjs`), which cannot resolve modules at runtime — an import here
 * (even type-only) drags zod/`src/**` into that bundle and reproduces the CHUNK_2
 * `Dynamic require of "events"` crash at the preload layer. `test/ipc-foundation.test.ts`
 * asserts this file has no `import`/`require`; keep it a plain literal array.
 *
 * The integration lead spreads this into `desktop/channels.ts`'s `IPC_CHANNELS` — this file
 * does not wire itself in.
 */
export const READ_CHANNELS = [
  'aphub:today:get',
  'aphub:transactions:list',
  'aphub:transactions:get',
  'aphub:exceptions:list',
  'aphub:exceptions:get',
  'aphub:evidence:get',
  'aphub:audit:list',
  'aphub:notifications:list',
  'aphub:me:get',
  'aphub:accounting-documents:review',
  'aphub:statements:list',
  'aphub:statements:get',
  'aphub:reply-drafts:get',
  'aphub:provider-capabilities:list',
  'aphub:provider-jobs:list',
  'aphub:dimension-mappings:list',
  'aphub:tax-mappings:list',
  'aphub:tax-mappings:get',
  'aphub:tax-mappings:discover',
  'aphub:tax-mappings:audit',
  'aphub:onboarding:get',
  'aphub:connections:status',
] as const;
