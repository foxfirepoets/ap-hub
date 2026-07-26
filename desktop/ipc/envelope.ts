/**
 * CHUNK_3_IPC — Request synthesis and Response decoding.
 *
 * Implements `docs/build/interfaces/ipc-envelope.md` §5 and §6.
 *
 * The design in one sentence: the dispatcher reuses the existing exported service wrappers
 * UNMODIFIED by handing each one a real `Request` and decoding the `Response` it returns, so
 * nothing under `src/**` is edited and the entire authorization funnel
 * (`tokenFromRequest` → `readContext` → `requireSession` → role gate) keeps firing exactly
 * where it fires today. Only the funnel's caller changes.
 *
 * No network call occurs. The `Request` is constructed in-process and consumed only by
 * `request.text()`, `request.json()` and `new URL(request.url)`. The origin `http://localhost`
 * is never dialed; it matches the precedent already in the suite
 * (`test/f5-cross-tenant-isolation.test.ts:41`).
 */

import type { SessionCookie } from './context.js';
import { normalizeCode, plainMessage, type IpcErrorCode } from './errors.js';

/** HTTP methods a channel may declare. Never inferred — see `synthesize`. */
export type IpcMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/**
 * The wire envelope. Structurally identical to `IpcResult` in `desktop/preload.ts:18-37`,
 * declared here rather than imported because `preload.ts` imports `electron` and this module
 * is loaded by the main process and by tests. `test/ipc-foundation.test.ts` asserts the two
 * declarations stay in step.
 */
export interface IpcResult<T = unknown> {
  ok: boolean;
  data?: T;
  code?: string;
  message?: string;
  status?: number;
}

/**
 * The part of a registry entry that synthesis needs. `RegistryEntry` satisfies it
 * structurally; keeping the shape minimal means this module never imports the registry and so
 * never drags zod into a graph that does not need it.
 */
export interface SynthesisSpec {
  readonly method: IpcMethod;
  /** e.g. `/api/proposals/:proposalId/approve`. `:name` keys are read from the payload. */
  readonly pathTemplate: string;
  /** Payload keys that become query-string params. */
  readonly queryParams?: readonly string[];
  /** Payload keys that become the JSON body. A key in neither list is never forwarded. */
  readonly bodyKeys?: readonly string[];
}

const PATH_PARAM = /:([A-Za-z][A-Za-z0-9]*)/g;

/** The `:name` parameters a path template declares, in order. */
export function pathParamsOf(pathTemplate: string): readonly string[] {
  return [...pathTemplate.matchAll(PATH_PARAM)].map((m) => m[1] as string);
}

/**
 * Build the `Request` the service wrapper will receive.
 *
 * Three rules here are not stylistic:
 *
 *  (a) `method` comes from the spec and is NEVER inferred from the payload shape, because
 *      `runOnboardingAction` branches on it: `if (request.method === 'POST')` parses a body
 *      (`src/services/action/onboarding.ts:43-49`). A `GET` sent as `POST` attempts a body
 *      parse the route never performs; a `POST` sent as `GET` silently delivers `{}` and
 *      loses `step` and `automationLevel`.
 *
 *  (b) A `GET` carries NO body — the WHATWG `Request` constructor throws `TypeError`
 *      otherwise. A non-GET ALWAYS carries a body string, minimum `'{}'`, because four
 *      wrappers call `request.json()` unconditionally and throw on an empty body
 *      (`src/statements/http.ts:30`, `src/reply-drafts/http.ts:40`,
 *      `src/accounting/write-gates-http.ts:9`, `src/accounting/document-review-http.ts:15`).
 *      `aphub:statements:file` takes no fields and must still be sent `'{}'`.
 *
 *  (c) Query params must reach the URL, because several wrappers read
 *      `new URL(request.url).searchParams` and are `src/**` code this chunk does not edit —
 *      `runReadReplyDraft` returns 400 without `messageId` (`src/reply-drafts/http.ts:65-69`),
 *      and the tax/dimension list and discover wrappers read their filters from there.
 *
 * The cookie is a branded `SessionCookie` that only `desktop/ipc/context.ts` can produce, so
 * no payload value can reach this header.
 */
export function synthesize(
  spec: SynthesisSpec,
  payload: Record<string, unknown>,
  cookie: SessionCookie | null,
): Request {
  const path = spec.pathTemplate.replace(PATH_PARAM, (_match, key: string) => {
    const value = payload[key];
    return encodeURIComponent(value === undefined || value === null ? '' : String(value));
  });
  const url = new URL(`http://localhost${path}`);
  for (const key of spec.queryParams ?? []) {
    const value = payload[key];
    // `.optional()` means omitted, not `''` and not `'null'`: `runListTaxMappings` branches on
    // `connectionIdRaw ? … : undefined` (src/services/action/taxMappings.ts:137), where an
    // empty string is falsy but the string "null" is not.
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }

  const headers = new Headers({ 'content-type': 'application/json' });
  // No token held ⇒ no cookie header at all. An empty one resolves to no session anyway and
  // costs a wasted round trip through requireSession.
  if (cookie !== null) headers.set('cookie', cookie);

  let body: string | undefined;
  if (spec.method !== 'GET') {
    const fields: Record<string, unknown> = {};
    for (const key of spec.bodyKeys ?? []) {
      if (payload[key] !== undefined) fields[key] = payload[key];
    }
    body = JSON.stringify(fields);
  }

  return new Request(url, { method: spec.method, headers, body });
}

interface DecodedBody {
  data?: unknown;
  error?: { code?: unknown; message?: unknown };
}

/**
 * Turn the wrapper's `Response` into the wire envelope.
 *
 * Three properties are deliberate, and each of them has a real call site behind it:
 *
 *  (a) `ok` comes from `res.ok`, NOT from "no code present".
 *      `errorResponse('QBO_RETRY', 'qbo post failed; safe to retry', 202)`
 *      (`src/services/action/index.ts:153`) is an existing, reachable `ok: true` response that
 *      also carries a code, and the retry screens depend on it. A decoder that set
 *      `ok = (code === undefined)` would flip that result to a failure.
 *
 *  (b) A code inside `data` stays inside `data`. The held branch returns
 *      `jsonResponse({ status: 'held', code: 'HELD_FOR_REVIEW', reason }, 202)`
 *      (`src/services/action/index.ts:141`); screens read it from the payload today, so it is
 *      never hoisted into the envelope's `code`.
 *
 *  (c) `message` is looked up from the normalized code and never copied from the body. See
 *      `desktop/ipc/errors.ts` for the reason, which is a specific line of service code that
 *      interpolates a raw driver error.
 */
export async function decode(res: Response): Promise<IpcResult> {
  const text = await res.text();
  let body: DecodedBody = {};
  if (text.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        body = parsed as DecodedBody;
      }
    } catch {
      // A wrapper that returned non-JSON tells the renderer nothing useful; the status and
      // `ok` still carry the outcome.
      body = {};
    }
  }

  const out: IpcResult = { ok: res.ok, status: res.status };
  if (body.data !== undefined) out.data = body.data;
  const rawCode = body.error?.code;
  if (rawCode !== undefined && rawCode !== null && rawCode !== '') {
    const code: IpcErrorCode = normalizeCode(rawCode);
    out.code = code;
    out.message = plainMessage(code);
  }
  return out;
}

/** A failure envelope built entirely from our own strings. The only way to author one. */
export function failure(code: IpcErrorCode, status: number, message?: string): IpcResult {
  return { ok: false, status, code, message: message ?? plainMessage(code) };
}
