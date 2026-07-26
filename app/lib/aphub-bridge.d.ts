/**
 * CHUNK_3_IPC (B5) — the renderer-side shape of `window.aphub`.
 *
 * Mirrors `desktop/preload.ts`'s frozen `api` object and its `IpcResult` exactly. Declared here
 * rather than imported because `preload.ts` imports `electron`, which the static renderer
 * export never sees. Same reasoning `desktop/ipc/envelope.ts` uses for its own `IpcResult`
 * copy — this is a third parallel declaration of the same wire shape, not a new one.
 */

export interface IpcResult<T = unknown> {
  ok: boolean;
  data?: T;
  code?: string;
  message?: string;
  status?: number;
}

export interface AphubBridge {
  invoke(channel: string, payload?: unknown): Promise<IpcResult>;
  on(event: string, callback: (payload: unknown) => void): () => void;
  platform: 'darwin' | 'win32';
  channels: readonly string[];
}

declare global {
  interface Window {
    aphub?: AphubBridge;
  }
}
