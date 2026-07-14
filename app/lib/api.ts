// Thin browser fetch helpers. The API wraps success as `{ data }` and failure as
// `{ error: { code, message } }` (see src/services/read/http.ts). Reads throw on non-2xx;
// actions return the raw status so callers can branch on 201/202/409/400 explicitly.

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

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin', cache: 'no-store' });
  const body = (await res.json().catch(() => ({}))) as { data?: T; error?: { code?: string; message?: string } };
  if (!res.ok) {
    throw new ApiError(body?.error?.code ?? 'INTERNAL', body?.error?.message ?? res.statusText, res.status);
  }
  return body.data as T;
}

export interface ActionResult<T> {
  ok: boolean;
  status: number;
  data?: T;
  error?: { code: string; message: string };
}

export async function apiPost<T>(path: string, payload?: unknown): Promise<ActionResult<T>> {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: payload !== undefined ? JSON.stringify(payload) : undefined,
  });
  const body = (await res.json().catch(() => ({}))) as { data?: T; error?: { code: string; message: string } };
  return { ok: res.ok, status: res.status, data: body?.data, error: body?.error };
}

/** Extract a numeric proposal id from an exception's entity_ref (e.g. "proposal:501" → 501). */
export function proposalRefId(ref: string | null): number | null {
  if (!ref) return null;
  const m = /(\d+)\s*$/.exec(ref);
  return m ? Number(m[1]) : null;
}
