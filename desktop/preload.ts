/**
 * CHUNK_1_SHELL — the ONLY bridge between the AP-Hub window and the program underneath.
 *
 * Runs sandboxed, so it is bundled into a single file by `scripts/build-desktop.mjs`:
 * a sandboxed preload cannot `require` a relative module, and the channel allowlist must
 * travel with it rather than being re-typed here and drifting.
 *
 * The exposed object is frozen and enumerates its operations. There is no generic escape
 * hatch: `invoke` refuses any channel that is not a literal member of IPC_CHANNELS, and the
 * main process refuses it a second time. Two independent checks, because this is the seam
 * where a renderer compromise would otherwise become a total one.
 */

import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS, isAllowedChannel } from './channels.js';

/** Shape every handler returns. Raw provider text never crosses this bridge. */
export interface IpcResult<T = unknown> {
  ok: boolean;
  data?: T;
  code?: string;
  message?: string;
  /**
   * CHUNK_3: the originating HTTP status, carried through so the renderer adapter can keep
   * `apiGet` throwing and `apiPost` NOT throwing on 201/202/409/400. That asymmetry is
   * load-bearing — screens branch on the status rather than on a thrown error — so dropping
   * it would silently change error handling in every mutation screen and force page edits.
   *
   * Optional and additive: the CHUNK_1 shell channels omit it and stay correct, and the
   * adapter defaults an absent value to `ok ? 200 : 500`.
   *
   * `ok` is NOT "no code present": `errorResponse('QBO_RETRY', …, 202)`
   * (`src/services/action/index.ts:153`) is a real `ok: true` response that also carries a
   * code, and the retry screens depend on it.
   */
  status?: number;
}

const CHANNEL_REFUSED: IpcResult = Object.freeze({
  ok: false,
  code: 'INTERNAL',
  // Plain language, no channel name echoed back — the renderer learns nothing from probing.
  message: 'AP-Hub could not complete that action.',
});

/** Status events the shell pushes to the renderer. Read-only; no payload from the renderer. */
const STATUS_EVENTS: readonly string[] = Object.freeze([
  'aphub:status:engine',
  'aphub:status:database',
  'aphub:status:backup',
]);

const api = Object.freeze({
  /** Every product operation. Refuses any channel outside the enumerated list. */
  invoke(channel: string, payload?: unknown): Promise<IpcResult> {
    if (!isAllowedChannel(channel)) return Promise.resolve(CHANNEL_REFUSED);
    return ipcRenderer.invoke(channel, payload) as Promise<IpcResult>;
  },

  /** Subscribe to a shell status event. Returns an unsubscribe function. */
  on(event: string, callback: (payload: unknown) => void): () => void {
    if (!STATUS_EVENTS.includes(event)) return () => {};
    const listener = (_e: unknown, payload: unknown): void => callback(payload);
    ipcRenderer.on(event, listener);
    return () => {
      ipcRenderer.removeListener(event, listener);
    };
  },

  /** Non-secret, read-only. Lets the renderer render platform-appropriate copy. */
  platform: process.platform === 'darwin' ? 'darwin' : 'win32',

  /** Introspection for the contract test. Copy, so a caller cannot mutate the source. */
  channels: Object.freeze([...IPC_CHANNELS]),
});

contextBridge.exposeInMainWorld('aphub', api);
