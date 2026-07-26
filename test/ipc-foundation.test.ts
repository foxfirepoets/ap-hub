import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

import { IPC_CHANNELS, SHELL_CHANNELS } from '../desktop/channels.js';
import {
  buildRegistry,
  defineChannel,
  entityId,
  filterText,
  passthrough,
  persistedId,
  reason,
  RegistryDefect,
  strict,
  type ChannelContribution,
  type RegistryEntry,
} from '../desktop/ipc/registry.js';
import { createDispatcher, registerProductHandlers, type IpcMainLike } from '../desktop/ipc/dispatcher.js';
import { clearSessionToken, setSessionToken } from '../desktop/ipc/context.js';
import { decode, synthesize } from '../desktop/ipc/envelope.js';
import { IPC_ERROR_CODES, normalizeCode, plainMessage } from '../desktop/ipc/errors.js';

import { errorResponse, jsonResponse, runRead, tokenFromRequest } from '../src/services/read/http.js';
import { readSessionCookie, createSession, SESSION_COOKIE_NAME } from '../src/auth/session.js';
import { closeAll, createTenant, createUser, resetTables } from './helpers.js';

/**
 * CHUNK_3_IPC — the IPC foundation.
 *
 * These are tests over the MACHINERY, not over the 50 channels: request synthesis, response
 * decoding, code normalization, message hygiene, token custody, and the registry/allowlist
 * symmetry that keeps three agents' channel lists honest.
 *
 * The load-bearing ones, in order of what they would cost if they regressed:
 *
 *  - a payload that fails its schema must never touch a service (asserted with a call spy,
 *    not by inspecting the envelope, because an envelope can be right while the service was
 *    still reached and still audited);
 *  - a renderer-supplied token-like field must never influence the resolved identity;
 *  - no message crossing the bridge may contain a channel name, a stack trace, or the
 *    caller's own interpolated input.
 */

const ROOT = join(__dirname, '..');

// --- fixtures ------------------------------------------------------------------------------

interface Call {
  readonly request: Request;
  readonly payload: Record<string, unknown>;
}

/** Records every service call so a test can assert the service was NOT reached. */
class ServiceSpy {
  readonly calls: Call[] = [];
  respond: (call: Call) => Response | Promise<Response> = () => jsonResponse({ ok: true });

  get called(): boolean {
    return this.calls.length > 0;
  }

  readonly invoke = async (request: Request, payload: Record<string, unknown>): Promise<Response> => {
    const call: Call = { request, payload };
    this.calls.push(call);
    return this.respond(call);
  };
}

const ready = (): 'ready' => 'ready';

/** A channel that exercises path params, a query param and body keys all at once. */
function fixtureEntry(spy: ServiceSpy, overrides: Partial<RegistryEntry> = {}): RegistryEntry {
  return defineChannel({
    channel: 'aphub:shell:version',
    role: ['owner_controller'],
    method: 'POST',
    pathTemplate: '/api/proposals/:proposalId/reject',
    bodyKeys: ['reason', 'markDuplicate'],
    request: strict({
      proposalId: entityId,
      reason,
      markDuplicate: z.boolean().optional(),
    }),
    response: passthrough({}),
    invoke: spy.invoke,
    ...overrides,
  });
}

/**
 * A dispatcher over one entry. The channel name is borrowed from `SHELL_CHANNELS` so the
 * allowlist check passes without editing `desktop/channels.ts`, which this agent does not own.
 */
function dispatcherFor(
  entry: RegistryEntry,
  databaseState: () => 'ready' | 'starting' | 'failed' = ready,
): (payload?: unknown) => Promise<Awaited<ReturnType<ReturnType<typeof createDispatcher>['dispatch']>>> {
  const contribution: ChannelContribution = { channels: [entry.channel], entries: [entry] };
  const { dispatch } = createDispatcher({ contributions: [contribution], databaseState });
  return (payload?: unknown) => dispatch(entry.channel, payload);
}

// --- registry guards ----------------------------------------------------------------------

describe('registry rejects an unsafe channel definition at import time', () => {
  const spy = new ServiceSpy();
  const base = {
    channel: 'aphub:shell:version',
    role: 'any' as const,
    method: 'POST' as const,
    pathTemplate: '/api/things',
    response: passthrough({}),
    invoke: spy.invoke,
  };

  it('refuses a request schema that is not .strict()', () => {
    // Without strictness an identity field would be silently STRIPPED rather than rejected,
    // and the "never merged" guarantee would rest on nothing.
    expect(() =>
      defineChannel({ ...base, request: z.object({ note: filterText }), bodyKeys: ['note'] }),
    ).toThrow(RegistryDefect);
  });

  it.each(['token', 'sessionId', 'tenantId', 'role', 'userId', 'email', 'actor', 'tenant_id'])(
    'refuses a schema that declares the identity field %s',
    (field) => {
      expect(() =>
        defineChannel({
          ...base,
          request: strict({ [field]: filterText }),
          bodyKeys: [field],
        }),
      ).toThrow(/IDENTITY_FIELD_IN_SCHEMA/);
    },
  );

  it('refuses a payload key that is routed nowhere, because it would be silently dropped', () => {
    expect(() => defineChannel({ ...base, request: strict({ note: filterText }) })).toThrow(
      /UNROUTED_PAYLOAD_KEY/,
    );
  });

  it('refuses a path param the schema does not require', () => {
    expect(() =>
      defineChannel({
        ...base,
        pathTemplate: '/api/things/:thingId',
        request: strict({ thingId: entityId.optional() }),
      }),
    ).toThrow(/PATH_PARAM_OPTIONAL/);
    expect(() =>
      defineChannel({ ...base, pathTemplate: '/api/things/:thingId', request: strict({}) }),
    ).toThrow(/PATH_PARAM_NOT_IN_SCHEMA/);
  });

  it('refuses body keys on a GET, which the Request constructor would throw on', () => {
    expect(() =>
      defineChannel({
        ...base,
        method: 'GET',
        request: strict({ note: filterText }),
        bodyKeys: ['note'],
      }),
    ).toThrow(/BODY_ON_GET/);
  });

  it('refuses a .strict() response schema, so a new service column cannot break the app', () => {
    expect(() =>
      defineChannel({ ...base, request: strict({}), response: z.object({ a: z.string() }).strict() }),
    ).toThrow(/RESPONSE_SCHEMA_STRICT/);
  });

  it('refuses a malformed channel name even when it looks plausible', () => {
    for (const channel of ['aphub:Shell:version', 'shell:version', 'aphub:shell', 'aphub:shell:a:b']) {
      expect(() => defineChannel({ ...base, channel, request: strict({}) })).toThrow(
        /MALFORMED_CHANNEL/,
      );
    }
  });

  it('accepts a .superRefine() wrapper over a strict object', () => {
    // The reply-drafts recipient deny-list and the dimension-mapping "at least one of"
    // refinement are both authored this way, so the strictness check must see through
    // ZodEffects rather than give up on it.
    expect(() =>
      defineChannel({
        ...base,
        request: strict({ replyId: entityId }).superRefine((value, ctx) => {
          if (Object.prototype.hasOwnProperty.call(value, 'to')) {
            ctx.addIssue({ code: 'custom', message: 'AP-Hub cannot change who a reply goes to.' });
          }
        }),
        bodyKeys: ['replyId'],
      }),
    ).not.toThrow();
  });

  it('refuses a validation message that is not plain language', () => {
    expect(() =>
      defineChannel({
        ...base,
        request: strict({}),
        validationMessage: 'aphub:shell:version failed',
      }),
    ).toThrow(/VALIDATION_MESSAGE_NOT_PLAIN/);
  });
});

describe('registry and allowlist symmetry is enforced in both directions', () => {
  const spy = new ServiceSpy();

  it('refuses a channel name with no registry entry', () => {
    expect(() =>
      buildRegistry([{ channels: ['aphub:shell:version', 'aphub:shell:status'], entries: [fixtureEntry(spy)] }]),
    ).toThrow(/CHANNEL_WITHOUT_ENTRY: aphub:shell:status/);
  });

  it('refuses a registry entry with no channel name', () => {
    expect(() => buildRegistry([{ channels: [], entries: [fixtureEntry(spy)] }])).toThrow(
      /ENTRY_WITHOUT_CHANNEL: aphub:shell:version/,
    );
  });

  it('refuses two entries claiming the same channel', () => {
    const entry = fixtureEntry(spy);
    expect(() =>
      buildRegistry([
        { channels: ['aphub:shell:version'], entries: [entry] },
        { channels: [], entries: [entry] },
      ]),
    ).toThrow(/DUPLICATE_CHANNEL/);
  });

  it('refuses to register a channel that is absent from the preload allowlist', () => {
    const entry = fixtureEntry(spy, { channel: 'aphub:ghost:list' });
    expect(() =>
      registerProductHandlers({
        ipcMain: { handle: () => {} },
        databaseState: ready,
        contributions: [{ channels: ['aphub:ghost:list'], entries: [entry] }],
      }),
    ).toThrow('UNREGISTERED_CHANNEL');
  });

  it('refuses to leave an allowlisted, non-reserved channel without a handler', () => {
    // `aphub:shell:status` is in IPC_CHANNELS; declaring only `aphub:shell:version` as
    // reserved leaves it dead surface the bridge would relay into nothing.
    expect(() =>
      registerProductHandlers({
        ipcMain: { handle: () => {} },
        databaseState: ready,
        contributions: [],
        reservedChannels: ['aphub:shell:version'],
      }),
    ).toThrow('CHANNEL_WITHOUT_HANDLER');
  });

  it('registers one ipcMain handler per channel and nothing else', () => {
    const registered: string[] = [];
    const ipcMain: IpcMainLike = { handle: (channel) => registered.push(channel) };
    registerProductHandlers({
      ipcMain,
      databaseState: ready,
      contributions: [{ channels: ['aphub:shell:version'], entries: [fixtureEntry(spy)] }],
      reservedChannels: SHELL_CHANNELS,
    });
    expect(registered).toEqual(['aphub:shell:version']);
  });
});

// --- validation runs before the service ----------------------------------------------------

describe('a payload that fails its schema never reaches the service', () => {
  it('rejects a malformed payload with a typed code and does NOT invoke the service', async () => {
    const spy = new ServiceSpy();
    const dispatch = dispatcherFor(fixtureEntry(spy));

    const result = await dispatch({ proposalId: 'not-a-number', reason: 'because' });

    expect(result).toEqual({
      ok: false,
      status: 400,
      code: 'VALIDATION',
      message: plainMessage('VALIDATION'),
    });
    // The assertion that matters: the service layer was never entered, so no body was parsed,
    // no audit row was written and no provider was contacted.
    expect(spy.called).toBe(false);
    expect(spy.calls).toHaveLength(0);
  });

  it('rejects an unknown extra field without invoking the service', async () => {
    const spy = new ServiceSpy();
    const dispatch = dispatcherFor(fixtureEntry(spy));
    const result = await dispatch({ proposalId: 7, reason: 'ok', surprise: 'extra' });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('VALIDATION');
    expect(spy.called).toBe(false);
  });

  it('rejects an oversized string without invoking the service', async () => {
    const spy = new ServiceSpy();
    const dispatch = dispatcherFor(fixtureEntry(spy));
    const result = await dispatch({ proposalId: 7, reason: 'x'.repeat(5000) });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('VALIDATION');
    expect(result.status).toBe(400);
    expect(spy.called).toBe(false);
  });

  it('rejects the numeric-string id form at the boundary', async () => {
    const spy = new ServiceSpy();
    const dispatch = dispatcherFor(fixtureEntry(spy));
    expect((await dispatch({ proposalId: '7', reason: 'ok' })).code).toBe('VALIDATION');
    expect((await dispatch({ proposalId: 0, reason: 'ok' })).code).toBe('VALIDATION');
    expect((await dispatch({ proposalId: 1.5, reason: 'ok' })).code).toBe('VALIDATION');
    expect(spy.called).toBe(false);
  });

  it('uses the channel-authored validation message when one is supplied', async () => {
    const spy = new ServiceSpy();
    const message = 'Add a short reason before rejecting this item.';
    const dispatch = dispatcherFor(fixtureEntry(spy, { validationMessage: message }));
    expect((await dispatch({ proposalId: 7 })).message).toBe(message);
    expect(spy.called).toBe(false);
  });

  it('refuses an unknown channel with the same object the preload uses, naming nothing', async () => {
    const spy = new ServiceSpy();
    const contribution: ChannelContribution = {
      channels: ['aphub:shell:version'],
      entries: [fixtureEntry(spy)],
    };
    const { dispatch } = createDispatcher({ contributions: [contribution], databaseState: ready });

    for (const channel of ['aphub:shell:status', 'aphub:not:registered', '../etc/passwd']) {
      const result = await dispatch(channel, {});
      expect(result).toEqual({ ok: false, code: 'INTERNAL', message: plainMessage('INTERNAL') });
      expect(JSON.stringify(result)).not.toContain(channel);
    }
    expect(spy.called).toBe(false);
  });
});

describe('the database gate answers without calling any service', () => {
  it('returns DB_STARTING while the private database is still coming up', async () => {
    const spy = new ServiceSpy();
    const dispatch = dispatcherFor(fixtureEntry(spy), () => 'starting');
    const result = await dispatch({ proposalId: 1, reason: 'ok' });
    expect(result).toEqual({
      ok: false,
      status: 503,
      code: 'DB_STARTING',
      message: plainMessage('DB_STARTING'),
    });
    expect(spy.called).toBe(false);
  });

  it('returns DB_FAILED when the database did not start', async () => {
    const spy = new ServiceSpy();
    const dispatch = dispatcherFor(fixtureEntry(spy), () => 'failed');
    const result = await dispatch({ proposalId: 1, reason: 'ok' });
    expect(result.code).toBe('DB_FAILED');
    expect(result.status).toBe(503);
    expect(spy.called).toBe(false);
  });
});

// --- request synthesis ---------------------------------------------------------------------

describe('Request synthesis matches what the unmodified wrappers read', () => {
  it('sends no body on a GET and always at least "{}" on every other method', async () => {
    for (const method of ['POST', 'PATCH', 'DELETE'] as const) {
      const spy = new ServiceSpy();
      // `aphub:statements:file` takes no fields yet must still be sent '{}', because
      // `action()` calls request.json() unconditionally (src/statements/http.ts:30).
      const dispatch = dispatcherFor(
        fixtureEntry(spy, {
          method,
          pathTemplate: '/api/statements/:statementId/file',
          request: strict({ statementId: entityId }),
          bodyKeys: [],
        }),
      );
      await dispatch({ statementId: 4 });
      const request = spy.calls[0]!.request;
      expect(request.method).toBe(method);
      await expect(request.text()).resolves.toBe('{}');
    }

    const getSpy = new ServiceSpy();
    const getDispatch = dispatcherFor(
      fixtureEntry(getSpy, {
        method: 'GET',
        pathTemplate: '/api/statements/:statementId',
        request: strict({ statementId: entityId }),
        bodyKeys: [],
      }),
    );
    await getDispatch({ statementId: 4 });
    expect(getSpy.calls[0]!.request.body).toBeNull();
  });

  it('carries query params into the URL and omits absent optional ones', async () => {
    const spy = new ServiceSpy();
    const dispatch = dispatcherFor(
      fixtureEntry(spy, {
        method: 'GET',
        pathTemplate: '/api/dimension-mappings',
        request: strict({ connectionId: entityId.optional(), provider: filterText.optional() }),
        queryParams: ['connectionId', 'provider'],
        bodyKeys: [],
      }),
    );

    await dispatch({ connectionId: 12 });
    const url = new URL(spy.calls[0]!.request.url);
    expect(url.origin).toBe('http://localhost');
    expect(url.searchParams.get('connectionId')).toBe('12');
    // Omitted, not '' and not 'null': runListTaxMappings branches on a truthy raw value
    // (src/services/action/taxMappings.ts:137).
    expect(url.searchParams.has('provider')).toBe(false);
  });

  it('substitutes path params and forwards only declared body keys', async () => {
    const spy = new ServiceSpy();
    const dispatch = dispatcherFor(
      fixtureEntry(spy, {
        pathTemplate: '/api/statements/:statementId/lines/:lineId/exclude',
        request: strict({ statementId: entityId, lineId: entityId, reason }),
        bodyKeys: ['reason'],
      }),
    );
    await dispatch({ statementId: 9, lineId: 3, reason: 'duplicate line' });
    const call = spy.calls[0]!;
    expect(new URL(call.request.url).pathname).toBe('/api/statements/9/lines/3/exclude');
    // Path params are passed positionally by the invoke thunk, never duplicated into the body.
    await expect(call.request.json()).resolves.toEqual({ reason: 'duplicate line' });
  });

  it('takes the method from the registry entry, never from the payload shape', async () => {
    // runOnboardingAction branches on request.method (src/services/action/onboarding.ts:43),
    // so an identical payload shape must be able to produce either method.
    const getSpy = new ServiceSpy();
    const postSpy = new ServiceSpy();
    const shape = { request: strict({}), pathTemplate: '/api/onboarding', bodyKeys: [] };
    await dispatcherFor(fixtureEntry(getSpy, { ...shape, method: 'GET' }))({});
    await dispatcherFor(fixtureEntry(postSpy, { ...shape, method: 'POST' }))({});
    expect(getSpy.calls[0]!.request.method).toBe('GET');
    expect(postSpy.calls[0]!.request.method).toBe('POST');
  });
});

// --- Response decoding ---------------------------------------------------------------------

describe('Response decoding keeps ok and code independent', () => {
  async function dispatchWith(response: Response) {
    const spy = new ServiceSpy();
    spy.respond = () => response;
    const dispatch = dispatcherFor(fixtureEntry(spy));
    return dispatch({ proposalId: 1, reason: 'ok' });
  }

  it('decodes a 202 QBO_RETRY to ok:true with status 202 and the code intact', async () => {
    // src/services/action/index.ts:153 — an existing, reachable ok:true response that also
    // carries a code. A decoder deriving ok from "no code present" would flip it to a failure
    // and change what the retry screens do.
    const result = await dispatchWith(errorResponse('QBO_RETRY', 'qbo post failed; safe to retry', 202));
    expect(result.ok).toBe(true);
    expect(result.status).toBe(202);
    expect(result.code).toBe('QBO_RETRY');
    expect(result.message).toBe(plainMessage('QBO_RETRY'));
  });

  it('decodes a 404 to ok:false with code NOT_FOUND', async () => {
    const result = await dispatchWith(errorResponse('NOT_FOUND', 'not found', 404));
    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
    expect(result.code).toBe('NOT_FOUND');
    expect(result.message).toBe(plainMessage('NOT_FOUND'));
  });

  it('leaves HELD_FOR_REVIEW inside data, where the screens read it today', async () => {
    const held = jsonResponse({ status: 'held', code: 'HELD_FOR_REVIEW', reason: 'over ceiling' }, 202);
    const result = await dispatchWith(held);
    expect(result.ok).toBe(true);
    expect(result.status).toBe(202);
    expect(result.code).toBeUndefined();
    expect(result.data).toEqual({ status: 'held', code: 'HELD_FOR_REVIEW', reason: 'over ceiling' });
  });

  it('carries a 201 through unchanged', async () => {
    const result = await dispatchWith(jsonResponse({ posting_id: 5 }, 201));
    expect(result).toMatchObject({ ok: true, status: 201, data: { posting_id: 5 } });
    expect(result.code).toBeUndefined();
  });

  it('survives a bodyless or non-JSON response without inventing a code', async () => {
    const empty = await dispatchWith(new Response(null, { status: 204 }));
    expect(empty).toEqual({ ok: true, status: 204 });
    const garbage = await dispatchWith(new Response('<html>nope', { status: 500 }));
    expect(garbage).toEqual({ ok: false, status: 500 });
  });

  it('decodes a Response built outside the dispatcher identically', async () => {
    await expect(decode(errorResponse('ALREADY_POSTED', 'proposal already posted', 409))).resolves.toEqual({
      ok: false,
      status: 409,
      code: 'ALREADY_POSTED',
      message: plainMessage('ALREADY_POSTED'),
    });
  });
});

describe('normalizeCode closes the open service code families', () => {
  it('passes the closed set through unchanged', () => {
    for (const code of IPC_ERROR_CODES) expect(normalizeCode(code)).toBe(code);
  });

  it('collapses the whole ServiceError *_NOT_FOUND family onto NOT_FOUND', () => {
    for (const code of [
      'TAX_MAPPING_NOT_FOUND',
      'DIMENSION_MAPPING_NOT_FOUND',
      'PROPOSAL_NOT_FOUND',
      'REPLY_DRAFT_NOT_FOUND',
      'STATEMENT_LINE_NOT_FOUND',
      'ACCOUNTING_DOCUMENT_NOT_FOUND',
    ]) {
      expect(normalizeCode(code)).toBe('NOT_FOUND');
    }
  });

  it('maps the provider and conflict families onto their declared targets', () => {
    expect(normalizeCode('GMAIL_RECONNECT_REQUIRED')).toBe('PROVIDER_REAUTH');
    expect(normalizeCode('GMAIL_COMPOSE_SCOPE_REQUIRED')).toBe('PROVIDER_REAUTH');
    expect(normalizeCode('DRAFT_RETRY')).toBe('PROVIDER_OFFLINE');
    expect(normalizeCode('DRAFT_RESULT_UNKNOWN')).toBe('PROVIDER_OFFLINE');
    expect(normalizeCode('REPLY_DRAFT_ALREADY_SENT')).toBe('CONFLICT');
    expect(normalizeCode('UNSAFE_RETRY')).toBe('CONFLICT');
    expect(normalizeCode('INVALID_ID')).toBe('VALIDATION');
    expect(normalizeCode('SOURCE_MESSAGE_MISSING')).toBe('VALIDATION');
    expect(normalizeCode('DRY_RUN_LOCKED')).toBe('FORBIDDEN');
    expect(normalizeCode('READ_BACK_FAILED')).toBe('INTERNAL');
  });

  it('keeps ALREADY_POSTED distinct from CONFLICT, because it is guarantee 4 made visible', () => {
    expect(normalizeCode('ALREADY_POSTED')).toBe('ALREADY_POSTED');
  });

  it('keeps the two 401s distinct', () => {
    expect(normalizeCode('UNAUTHENTICATED')).toBe('UNAUTHENTICATED');
    expect(normalizeCode('SESSION_EXPIRED')).toBe('SESSION_EXPIRED');
  });

  it('fails closed on a code it has never heard of', () => {
    for (const code of ['SOME_NEW_SERVICE_CODE', 'ECONNREFUSED', '', 'null']) {
      expect(normalizeCode(code)).toBe('INTERNAL');
    }
    expect(normalizeCode(undefined)).toBe('INTERNAL');
    expect(normalizeCode(42)).toBe('INTERNAL');
  });
});

// --- message hygiene ----------------------------------------------------------------------

describe('no message crossing the bridge leaks anything', () => {
  it('gives every code a plain-language sentence that names nothing internal', () => {
    for (const code of IPC_ERROR_CODES) {
      const message = plainMessage(code);
      expect(message.length).toBeGreaterThan(10);
      expect(message).not.toContain(code); // no code name
      expect(message).not.toContain('aphub'); // no channel name
      expect(message).not.toMatch(/[:{}$\\]/); // no code, JSON, path or interpolation site
      expect(message).not.toMatch(/\bat\s+\w+\s*\(/); // no stack frame
      expect(message).not.toMatch(/\berror\b/i);
      expect(message).not.toMatch(/\b(sql|token|cookie|port|env|json|api)\b/i);
    }
  });

  it('never forwards a service message that interpolated the caller\'s own input', async () => {
    // src/services/dimensionMappings.ts:50 interpolates the caller's value verbatim.
    const spy = new ServiceSpy();
    spy.respond = () => errorResponse('VALIDATION', "invalid dimensionType 'zzz-secret-value'", 400);
    const dispatch = dispatcherFor(fixtureEntry(spy));
    const result = await dispatch({ proposalId: 1, reason: 'ok' });
    expect(result.message).toBe(plainMessage('VALIDATION'));
    expect(JSON.stringify(result)).not.toContain('zzz-secret-value');
    expect(JSON.stringify(result)).not.toContain('dimensionType');
  });

  it('never forwards raw driver text or a stack trace', async () => {
    const spy = new ServiceSpy();
    // src/services/taxMappings.ts:259 interpolates a raw driver Error message verbatim.
    spy.respond = () =>
      errorResponse('VALIDATION', 'replace failed: connect ECONNREFUSED 127.0.0.1:5432', 400);
    const leaked = await dispatcherFor(fixtureEntry(spy))({ proposalId: 1, reason: 'ok' });
    expect(JSON.stringify(leaked)).not.toContain('ECONNREFUSED');
    expect(JSON.stringify(leaked)).not.toContain('5432');

    const thrower = new ServiceSpy();
    thrower.respond = () => {
      throw new Error('relation "proposals" does not exist at Client._handleErrorMessage');
    };
    const crashed = await dispatcherFor(fixtureEntry(thrower))({ proposalId: 1, reason: 'ok' });
    expect(crashed).toEqual({
      ok: false,
      status: 500,
      code: 'INTERNAL',
      message: plainMessage('INTERNAL'),
    });
    expect(JSON.stringify(crashed)).not.toContain('proposals');
  });

  it('never echoes the channel name in any envelope it produces', async () => {
    const spy = new ServiceSpy();
    spy.respond = () => errorResponse('NOT_FOUND', 'not found', 404);
    const entry = fixtureEntry(spy);
    const dispatch = dispatcherFor(entry);
    for (const payload of [{}, { proposalId: 1, reason: 'ok' }, { token: 'x' }]) {
      const result = await dispatch(payload);
      expect(JSON.stringify(result)).not.toContain(entry.channel);
      expect(JSON.stringify(result)).not.toContain('aphub:');
    }
  });
});

// --- token custody -------------------------------------------------------------------------

describe('the session token is main-process property', () => {
  beforeEach(() => clearSessionToken());

  it('signs the cookie with the real signer, so readSessionCookie resolves it', async () => {
    // An unsigned value returns null from verifySessionValue (src/auth/session.ts:126-128),
    // which would make every channel answer UNAUTHENTICATED.
    setSessionToken('a-raw-session-token');
    const spy = new ServiceSpy();
    await dispatcherFor(fixtureEntry(spy))({ proposalId: 1, reason: 'ok' });
    const header = spy.calls[0]!.request.headers.get('cookie');
    expect(header).toMatch(new RegExp(`^${SESSION_COOKIE_NAME}=`));
    expect(readSessionCookie(header)).toBe('a-raw-session-token');
    expect(tokenFromRequest(spy.calls[0]!.request)).toBe('a-raw-session-token');
  });

  it('sends no cookie header at all when the main process holds no token', async () => {
    const spy = new ServiceSpy();
    await dispatcherFor(fixtureEntry(spy))({ proposalId: 1, reason: 'ok' });
    expect(spy.calls[0]!.request.headers.has('cookie')).toBe(false);
    expect(tokenFromRequest(spy.calls[0]!.request)).toBeNull();
  });

  it('discards the token on sign-out so a stale call cannot re-authenticate', async () => {
    setSessionToken('token-a');
    clearSessionToken();
    const spy = new ServiceSpy();
    await dispatcherFor(fixtureEntry(spy))({ proposalId: 1, reason: 'ok' });
    expect(spy.calls[0]!.request.headers.has('cookie')).toBe(false);
  });

  it.each(['token', 'sessionToken', 'cookie', 'authorization', 'tenantId', 'role', 'userId'])(
    'rejects a payload carrying %s and never lets it influence the identity',
    async (field) => {
      setSessionToken('the-real-main-process-token');
      const spy = new ServiceSpy();
      const dispatch = dispatcherFor(fixtureEntry(spy));

      const result = await dispatch({ proposalId: 1, reason: 'ok', [field]: 'attacker-supplied' });

      expect(result).toEqual({
        ok: false,
        status: 400,
        code: 'VALIDATION',
        message: plainMessage('VALIDATION'),
      });
      expect(spy.called).toBe(false);
    },
  );

  it('resolves the main-process identity even when the payload argued otherwise', async () => {
    // Belt and braces: a legitimate call made while an attacker-shaped field was attempted on a
    // previous call still resolves to the held token, and nothing from any payload appears in
    // the cookie.
    setSessionToken('the-real-main-process-token');
    const spy = new ServiceSpy();
    const dispatch = dispatcherFor(fixtureEntry(spy));
    await dispatch({ proposalId: 1, reason: 'ok', token: 'attacker-supplied' });
    await dispatch({ proposalId: 1, reason: 'ok' });
    const header = spy.calls[0]!.request.headers.get('cookie');
    expect(spy.calls).toHaveLength(1);
    expect(readSessionCookie(header)).toBe('the-real-main-process-token');
    expect(header).not.toContain('attacker-supplied');
  });

  it('cannot be handed a payload value: synthesize takes a branded cookie only', () => {
    const payload: Record<string, unknown> = { statementId: 1, token: 'attacker' };
    const spec = { method: 'POST' as const, pathTemplate: '/api/statements/:statementId/file' };
    // @ts-expect-error a payload value is `unknown` and is not assignable to SessionCookie
    synthesize(spec, payload, payload.token);
  });
});

// --- the authorization funnel still fires --------------------------------------------------

describe('the real authorization funnel fires through a synthesized Request', () => {
  beforeEach(async () => {
    await resetTables();
    clearSessionToken();
  });
  afterAll(async () => {
    clearSessionToken();
    await closeAll();
  });

  async function sessionFor(tenantId: number, role: string): Promise<string> {
    const userId = await createUser(tenantId, { role, email: `${role}-${tenantId}@example.com` });
    return (await createSession(userId)).token;
  }

  /** A read channel whose handler reports the tenant the funnel resolved. */
  function tenantEchoEntry(role: RegistryEntry['role'], opts: { role?: readonly string[] } = {}) {
    return defineChannel({
      channel: 'aphub:shell:version',
      role,
      method: 'GET',
      pathTemplate: '/api/me',
      request: strict({}),
      // `persistedId`, not `z.number()`: pg hands back bigint columns as strings, so demanding
      // a number here makes the dispatcher fail a perfectly good read closed.
      response: passthrough({ tenantId: persistedId }),
      invoke: (request) =>
        runRead(
          request,
          async (ctx) => ({ tenantId: ctx.tenantId, role: ctx.role }),
          opts.role === undefined ? {} : { role: opts.role as never },
        ),
    });
  }

  it('resolves the tenant from the held token, and only from the held token', async () => {
    const tenantA = await createTenant('Tenant A');
    const tenantB = await createTenant('Tenant B');
    setSessionToken(await sessionFor(tenantA, 'owner_controller'));

    const dispatch = dispatcherFor(tenantEchoEntry('any'));
    const asA = await dispatch({});
    expect(asA.ok).toBe(true);
    expect(asA.data).toMatchObject({ tenantId: tenantA, role: 'owner_controller' });

    // Naming another tenant in the payload is refused outright, not resolved.
    const attempt = await dispatch({ tenantId: tenantB });
    expect(attempt).toMatchObject({ ok: false, code: 'VALIDATION' });

    setSessionToken(await sessionFor(tenantB, 'owner_controller'));
    expect((await dispatch({})).data).toMatchObject({ tenantId: tenantB });
  });

  it('answers UNAUTHENTICATED with no token and after the token is cleared', async () => {
    const tenant = await createTenant('Tenant A');
    const dispatch = dispatcherFor(tenantEchoEntry('any'));

    expect(await dispatch({})).toMatchObject({
      ok: false,
      status: 401,
      code: 'UNAUTHENTICATED',
      message: plainMessage('UNAUTHENTICATED'),
    });

    setSessionToken(await sessionFor(tenant, 'cpa'));
    expect((await dispatch({})).ok).toBe(true);
    clearSessionToken();
    expect((await dispatch({})).code).toBe('UNAUTHENTICATED');
  });

  it('answers FORBIDDEN for a role outside the channel\'s set, with no data', async () => {
    const tenant = await createTenant('Tenant A');
    const ownerOnly = tenantEchoEntry(['owner_controller'], { role: ['owner_controller'] });
    const dispatch = dispatcherFor(ownerOnly);

    for (const role of ['bookkeeper', 'cpa']) {
      setSessionToken(await sessionFor(tenant, role));
      const result = await dispatch({});
      expect(result).toEqual({
        ok: false,
        status: 403,
        code: 'FORBIDDEN',
        message: plainMessage('FORBIDDEN'),
      });
      expect(result.data).toBeUndefined();
    }

    setSessionToken(await sessionFor(tenant, 'owner_controller'));
    expect((await dispatch({})).ok).toBe(true);
  });

  it('turns a cross-tenant miss into NOT_FOUND rather than a foreign row', async () => {
    const tenantA = await createTenant('Tenant A');
    const tenantB = await createTenant('Tenant B');
    setSessionToken(await sessionFor(tenantA, 'owner_controller'));

    // The handler is tenant-scoped exactly as the route files are: no row → null → 404.
    const entry = defineChannel({
      channel: 'aphub:shell:version',
      role: 'any',
      method: 'GET',
      pathTemplate: '/api/things/:thingId',
      request: strict({ thingId: entityId }),
      response: passthrough({}),
      invoke: (request, payload) =>
        runRead(request, async (ctx) =>
          ctx.tenantId === tenantB && payload.thingId === 1 ? { secret: 'tenant B row' } : null,
        ),
    });

    const result = await dispatcherFor(entry)({ thingId: 1 });
    expect(result).toEqual({
      ok: false,
      status: 404,
      code: 'NOT_FOUND',
      message: plainMessage('NOT_FOUND'),
    });
    expect(JSON.stringify(result)).not.toContain('tenant B row');
  });
});

// --- packaging constraints the foundation must not break -----------------------------------

describe('the channel-name modules stay importless, or the preload bundle breaks', () => {
  /**
   * B3 and B4 have not landed yet, so these assert vacuously today and bite the moment either
   * `channels.ts` appears.
   *
   * WHY this matters, and it is not style: `desktop/channels.ts` is BUNDLED into the sandboxed
   * preload (`scripts/build-desktop.mjs`), because a sandboxed preload cannot resolve modules
   * at runtime. Anything those two modules import is therefore dragged into that bundle. A
   * zod or `src/**` import there reproduces the CHUNK_2 `Dynamic require of "events"` failure
   * class — the app launches, shows a window, and dies on first use — except at the preload
   * layer, where `test/desktop-packaging.test.ts` does not look. That is why the allowlist
   * cannot be derived from the registry, and why the duplication is guarded by assertion
   * instead of discipline.
   */
  const modules = [
    join(ROOT, 'desktop', 'ipc', 'read', 'channels.ts'),
    join(ROOT, 'desktop', 'ipc', 'action', 'channels.ts'),
  ];

  function withoutComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  }

  it.each(modules)('%s has no import and no require', (file) => {
    if (!existsSync(file)) return; // vacuous until B3/B4 land
    const code = withoutComments(readFileSync(file, 'utf8'));
    expect(code).not.toMatch(/\bimport\b/);
    expect(code).not.toMatch(/\brequire\s*\(/);
    expect(code).toMatch(/as const/);
  });

  it('keeps every declared channel name a well-formed literal in the allowlist', () => {
    // The registry side of the same duplication: if either module exists, its names must be
    // reachable through IPC_CHANNELS once the integration lead applies the spread.
    for (const file of modules) {
      if (!existsSync(file)) continue;
      const names = [...readFileSync(file, 'utf8').matchAll(/'(aphub:[a-z0-9:-]+)'/g)].map((m) => m[1]!);
      expect(names.length).toBeGreaterThan(0);
      for (const name of names) expect(IPC_CHANNELS).toContain(name);
    }
  });
});

describe('the envelope declaration stays in step with the preload bridge', () => {
  it('declares the same five fields the preload relays', () => {
    // `envelope.ts` re-declares IpcResult instead of importing it, because `preload.ts`
    // imports electron. That duplication is only safe if it is asserted.
    const preload = readFileSync(join(ROOT, 'desktop', 'preload.ts'), 'utf8');
    const declaration = preload.slice(preload.indexOf('export interface IpcResult'));
    for (const field of ['ok: boolean', 'data?: T', 'code?: string', 'message?: string', 'status?: number']) {
      expect(declaration).toContain(field);
    }
  });

  it('reuses the preload\'s exact refused-channel message, so probing reveals nothing', () => {
    const preload = readFileSync(join(ROOT, 'desktop', 'preload.ts'), 'utf8');
    expect(preload).toContain(plainMessage('INTERNAL'));
  });
});
