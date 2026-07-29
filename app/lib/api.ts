// Renderer transport. Resolves the caller's HTTP-shaped path into an IPC channel + payload
// (app/lib/ipc-routes.ts) and calls it through the sandboxed bridge (desktop/preload.ts) via
// `window.aphub.invoke`. No network call, no `fetch` — CHUNK_3_IPC (B5).
//
// The throw/no-throw asymmetry from the old fetch-based helpers is preserved exactly: `apiGet`
// throws `ApiError` on a non-ok envelope; the mutation helpers never throw and return an
// `ActionResult` the caller branches on (201/202/409/400 — see
// docs/build/interfaces/ipc-envelope.md). `ok` comes from the envelope's own `ok` field, never
// from "no code present": a 202 carrying `QBO_RETRY` is `ok: true` with `error` still populated,
// exactly as it was over HTTP.

import { resolveRoute, type IpcMethod } from './ipc-routes';
import type { AphubBridge, IpcResult } from './aphub-bridge';

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

// Plain language only — never "IPC", "channel", "invoke", a channel name, or a code. The user
// is non-technical (CLAUDE.md).
const BRIDGE_UNAVAILABLE_MESSAGE =
  'BookScout OS could not reach the program running on this computer. Restart BookScout OS and try again.';
const ROUTE_UNAVAILABLE_MESSAGE = 'BookScout OS could not complete that action.';

// Accessed through `globalThis` rather than the bare `window` identifier: this module is
// imported by `test/ipc-renderer-transport.test.ts`, which compiles under the repo's root
// tsconfig (no DOM lib, unlike `tsconfig.web.json`) — a bare `window` reference would not
// resolve there even though the runtime behavior is identical in the renderer.
function getBridge(): AphubBridge | null {
  const globalWindow = (globalThis as { window?: { aphub?: AphubBridge } }).window;
  return globalWindow?.aphub ?? null;
}

async function callChannel(
  method: IpcMethod,
  path: string,
  body?: Record<string, unknown>,
): Promise<IpcResult> {
  const resolved = resolveRoute(method, path, body);
  if (resolved === null) {
    return { ok: false, status: 500, code: 'INTERNAL', message: ROUTE_UNAVAILABLE_MESSAGE };
  }
  const bridge = getBridge();
  if (!bridge) {
    return { ok: false, status: 500, code: 'INTERNAL', message: BRIDGE_UNAVAILABLE_MESSAGE };
  }
  return bridge.invoke(resolved.channel, resolved.payload);
}

export async function apiGet<T>(path: string): Promise<T> {
  const result = await callChannel('GET', path);
  const status = result.status ?? (result.ok ? 200 : 500);
  if (!result.ok) {
    throw new ApiError(result.code ?? 'INTERNAL', result.message ?? ROUTE_UNAVAILABLE_MESSAGE, status);
  }
  return result.data as T;
}

export interface ActionResult<T> {
  ok: boolean;
  status: number;
  data?: T;
  error?: { code: string; message: string };
}

function toActionResult<T>(result: IpcResult): ActionResult<T> {
  const status = result.status ?? (result.ok ? 200 : 500);
  const error = result.code !== undefined ? { code: result.code, message: result.message ?? '' } : undefined;
  return { ok: result.ok, status, data: result.data as T | undefined, error };
}

export async function apiPost<T>(path: string, payload?: unknown): Promise<ActionResult<T>> {
  const result = await callChannel('POST', path, (payload as Record<string, unknown> | undefined) ?? {});
  return toActionResult<T>(result);
}

export async function apiPatch<T>(path: string, payload: unknown): Promise<ActionResult<T>> {
  const result = await callChannel('PATCH', path, (payload as Record<string, unknown> | undefined) ?? {});
  return toActionResult<T>(result);
}

export async function apiDelete<T>(path: string): Promise<ActionResult<T>> {
  const result = await callChannel('DELETE', path, {});
  return toActionResult<T>(result);
}

/** Extract a numeric proposal id from an exception's entity_ref (e.g. "proposal:501" → 501). */
export function proposalRefId(ref: string | null): number | null {
  if (!ref) return null;
  const m = /(\d+)\s*$/.exec(ref);
  return m ? Number(m[1]) : null;
}
