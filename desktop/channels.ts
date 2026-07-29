/**
 * CHUNK_1_SHELL — the enumerated IPC surface and the external-navigation allowlist.
 *
 * This module is intentionally pure (no Electron import) so the validation gate can assert
 * the security properties directly. `desktop/main.ts` and `desktop/preload.ts` are thin
 * wiring over the predicates defined here; nothing else may decide what is reachable.
 *
 * The renderer can never name a table, a file path or a SQL fragment: it names a channel
 * from this list and nothing else. Channels are added by the chunk that implements them —
 * CHUNK_3 adds the 52 migrated product operations, CHUNK_5 the connect flow, CHUNK_7 backup.
 */

// CHUNK_3_IPC — the product channel names. These modules have ZERO imports on purpose: this
// file is bundled into the sandboxed preload, so anything they import lands there too and
// reproduces the CHUNK_2 `Dynamic require of "events"` failure at the preload layer.
// `test/ipc-foundation.test.ts` asserts they stay import-free.
import { READ_CHANNELS } from './ipc/read/channels.js';
import { ACTION_CHANNELS } from './ipc/action/channels.js';

/** Shell-level channels. One entry per operation, named `aphub:<domain>:<action>`. */
export const SHELL_CHANNELS = [
  'aphub:shell:version',
  'aphub:shell:status',
] as const;

/**
 * Every channel the preload bridge will relay. CHUNK_3/5/7 append their own lists here.
 * Frozen so a later import cannot widen the surface at runtime.
 */
export const IPC_CHANNELS: readonly string[] = Object.freeze([
  ...SHELL_CHANNELS,
  ...READ_CHANNELS,
  ...ACTION_CHANNELS,
]);

const CHANNEL_SET: ReadonlySet<string> = new Set(IPC_CHANNELS);

/** Channel names must be exactly `aphub:<domain>:<action>` in lowercase-kebab segments. */
export const CHANNEL_PATTERN = /^aphub:[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/;

/**
 * The single gate on the IPC surface. A channel is reachable only if it is a literal member
 * of the enumerated list — the pattern is a shape check, never an admission rule, so a
 * well-formed name that nobody registered is still refused.
 */
export function isAllowedChannel(channel: unknown): channel is string {
  return typeof channel === 'string' && CHANNEL_SET.has(channel);
}

/**
 * Provider consent hosts. Login opens in the user's own browser (never an embedded webview),
 * and `shell.openExternal` refuses everything else.
 *
 * Xero's OAuth consent flow (CHUNK_10) reaches login.xero.com for real. Sage Intacct
 * (www.intacct.com) remains a capability-declaring stub with no live code path — it is listed
 * here only because the spec fixes the allowlist at these four provider domains up front.
 */
export const PROVIDER_HOSTS: readonly string[] = Object.freeze([
  'accounts.google.com',
  'appcenter.intuit.com',
  'login.xero.com',
  'www.intacct.com',
]);

const PROVIDER_HOST_SET: ReadonlySet<string> = new Set(PROVIDER_HOSTS);

/**
 * `shell.openExternal` guard. Requires https, an exact host match against the allowlist, and
 * no embedded credentials. Subdomains are NOT accepted: an exact match is the whole point,
 * because `accounts.google.com.evil.test` would otherwise pass a suffix check.
 */
export function isAllowedExternalUrl(raw: unknown): boolean {
  if (typeof raw !== 'string' || raw.length === 0) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (url.username !== '' || url.password !== '') return false;
  return PROVIDER_HOST_SET.has(url.hostname);
}

/**
 * In-window navigation guard. The renderer is loaded from disk and may never leave it —
 * a navigation to any remote origin inside the app window is blocked outright. Provider
 * consent is not an exception: it goes to the system browser via `isAllowedExternalUrl`.
 */
export function isAllowedNavigation(raw: unknown): boolean {
  if (typeof raw !== 'string' || raw.length === 0) return false;
  try {
    return new URL(raw).protocol === 'file:';
  } catch {
    return false;
  }
}
