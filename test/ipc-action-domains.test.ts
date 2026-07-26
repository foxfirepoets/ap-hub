import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

import { ACTION_CHANNELS, ACTION_ENTRIES, RECIPIENT_DENY_LIST } from '../desktop/ipc/action/index.js';
import { CHANNEL_PATTERN } from '../desktop/channels.js';
import { createDispatcher } from '../desktop/ipc/dispatcher.js';
import { clearSessionToken, setSessionToken } from '../desktop/ipc/context.js';
import { plainMessage } from '../desktop/ipc/errors.js';
import { buildRegistry, type RegistryEntry } from '../desktop/ipc/registry.js';
import type { IpcResult } from '../desktop/ipc/envelope.js';
import { errorResponse, jsonResponse } from '../src/services/read/http.js';
import { createSession } from '../src/auth/session.js';
import {
  closeAll,
  createConnection,
  createTenant,
  createUser,
  insertDimensionMapping,
  insertProposal,
  resetTables,
} from './helpers.js';

/**
 * CHUNK_3_IPC — the ACTION channel contract. Every mutation in the product.
 *
 * These tests exist to catch the four ways this port could be wrong in a way review would miss:
 *
 *  1. A ROLE that drifted from the wrapper that actually gates it. `runAction` has six private
 *     clones with different role defaults, so the role matrix below is EXHAUSTIVE over channels ×
 *     {bookkeeper, cpa}, driven through the real `requireSession` against real database sessions.
 *     Nothing is sampled.
 *  2. The RECIPIENT DENY-LIST on `aphub:replies:send` silently dropped. Asserted one field at a
 *     time, all eleven, against `src/services/action/index.ts`'s own list.
 *  3. The write-gate accepting a PARTIAL confirmation. Asserted by removing each of the four
 *     required fields in turn.
 *  4. A schema that lets a bad payload REACH a service. Asserted with a call spy on every
 *     channel, because an envelope can be right while the service was still entered, a body
 *     still parsed and an audit row still written.
 */

const ROOT = join(__dirname, '..');
const ready = (): 'ready' => 'ready';
const SHELL_CHANNEL = 'aphub:shell:version';

const byChannel = new Map(ACTION_ENTRIES.map((entry) => [entry.channel, entry]));

// --- harness --------------------------------------------------------------------------------

interface Call {
  readonly request: Request;
  readonly payload: Record<string, unknown>;
}

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

/**
 * Drive one entry through the REAL dispatcher.
 *
 * The channel name is borrowed from `SHELL_CHANNELS` for the duration of the call because
 * `desktop/channels.ts` is a shared file this agent does not own: the integration lead applies the
 * `ACTION_CHANNELS` spread, so until then `isAllowedChannel` refuses every action name and the
 * dispatcher would answer `CHANNEL_REFUSED` before reaching the entry. Borrowing an allowlisted
 * name exercises steps 3–8 of the dispatcher (database gate, identity screen, zod, synthesis,
 * invoke, decode) exactly as production will — the same technique `test/ipc-foundation.test.ts:96`
 * uses, and for the same reason.
 */
function drive(entry: RegistryEntry, payload?: unknown): Promise<IpcResult> {
  const borrowed: RegistryEntry = { ...entry, channel: SHELL_CHANNEL };
  const { dispatch } = createDispatcher({
    contributions: [{ channels: [SHELL_CHANNEL], entries: [borrowed] }],
    databaseState: ready,
  });
  return dispatch(SHELL_CHANNEL, payload);
}

/** The same, with the real service replaced by a spy: schema-gating tests only. */
function driveSpied(entry: RegistryEntry, payload?: unknown): { spy: ServiceSpy; result: Promise<IpcResult> } {
  const spy = new ServiceSpy();
  const result = drive({ ...entry, invoke: spy.invoke }, payload);
  return { spy, result };
}

/**
 * One VALID payload per channel — valid at the schema, and deliberately pointing at ids that do
 * not exist so an admitted call fails on a missing row rather than mutating anything real.
 *
 * Every service reached this way looks the row up before doing provider I/O
 * (`createReplyDraft` → `sourceMessage` first; `classifyHeldDocument` → the scoped UPDATE before
 * `dispatchPendingClassifications`; `discardReplyDraft` → `getDraftRow` first), so no external
 * service is contacted even on the cells where the role is admitted.
 */
const VALID_PAYLOAD: Readonly<Record<string, Record<string, unknown>>> = {
  'aphub:proposals:approve': { proposalId: 987654 },
  'aphub:proposals:reject': { proposalId: 987654, reason: 'not our invoice' },
  'aphub:proposals:retry': { proposalId: 987654 },
  'aphub:corrections:learn': { field: 'vendor_name', newValue: 'Acme Supplies' },
  'aphub:mappings:remap': { kind: 'vendor', sourceKey: 'acme-supplies' },
  'aphub:accounting-documents:classify': {
    documentId: 987654,
    classification: 'invoice',
    reason: 'clearly a supplier invoice',
  },
  'aphub:notifications:read': { notificationId: 987654 },
  'aphub:onboarding:step': { step: 'connect-email' },
  'aphub:onboarding:dry-run': {},
  'aphub:provider-connections:write-gate': {
    connectionId: 987654,
    enabled: false,
    confirmedCompanyId: '',
    backupConfirmed: false,
    confirmation: '',
  },
  'aphub:replies:send': { replyId: 987654 },
  'aphub:reply-drafts:create': {
    messageId: 987654,
    subject: 'Re: your invoice',
    bodyText: 'Could you resend the PDF please?',
  },
  'aphub:reply-drafts:update': {
    draftId: 987654,
    subject: 'Re: your invoice',
    bodyText: 'Could you resend the PDF please?',
  },
  'aphub:reply-drafts:discard': { draftId: 987654 },
  'aphub:statements:correct': {
    statementId: 987654,
    field: 'closing_balance',
    value: '1200.00',
    reason: 'mistyped from the PDF',
  },
  'aphub:statements:file': { statementId: 987654 },
  'aphub:statements:match-line': {
    statementId: 987654,
    lineId: 987654,
    providerRef: { transactionId: 'QB-8812' },
    reason: 'same amount and date',
  },
  'aphub:statements:exclude-line': { statementId: 987654, lineId: 987654, reason: 'duplicate line' },
  'aphub:tax-mappings:create': {
    connectionId: 987654,
    provider: 'qbo',
    providerTaxCode: 'TAX8',
    internalTaxTreatment: 'standard',
    taxMode: 'exclusive',
  },
  'aphub:tax-mappings:edit': { taxMappingId: 987654, reason: 'rate changed' },
  'aphub:tax-mappings:disable': { taxMappingId: 987654, reason: 'no longer used' },
  'aphub:tax-mappings:replace': {
    taxMappingId: 987654,
    internalTaxTreatment: 'standard',
    taxMode: 'exclusive',
    reason: 'rate changed',
  },
  'aphub:tax-mappings:revalidate': { taxMappingId: 987654 },
  'aphub:tax-mappings:discover': {},
  'aphub:dimension-mappings:accept': { mappingId: 987654 },
  'aphub:dimension-mappings:correct': { mappingId: 987654, normalizedValue: 'Marketing' },
  'aphub:dimension-mappings:reject': { mappingId: 987654, reason: 'not a department' },
  'aphub:dimension-mappings:save-rule': { mappingId: 987654 },
  'aphub:dimension-mappings:select-alternate': { mappingId: 987654, providerId: '42' },
  'aphub:provider-jobs:retry': { jobId: 987654 },
};

/** The verb each replaced route declared. Asserted, because `method` is never inferred. */
const EXPECTED_METHOD: Readonly<Record<string, string>> = {
  'aphub:reply-drafts:update': 'PATCH',
  'aphub:reply-drafts:discard': 'DELETE',
  'aphub:tax-mappings:discover': 'GET',
};

function rolesOf(entry: RegistryEntry): readonly string[] | 'any' {
  return entry.role;
}

function admits(entry: RegistryEntry, role: string): boolean {
  const declared = rolesOf(entry);
  return declared === 'any' || declared.includes(role as never);
}

// --- 1. the surface itself -------------------------------------------------------------------

describe('the action surface is complete and symmetric', () => {
  it('registers a channel for every mutation, and 30 of them', () => {
    expect(ACTION_ENTRIES).toHaveLength(30);
    expect(ACTION_CHANNELS).toHaveLength(30);
  });

  it('is set-equal between the zero-import name list and the entries, in both directions', () => {
    const names = [...ACTION_CHANNELS].sort();
    const entries = ACTION_ENTRIES.map((e) => e.channel).sort();
    expect(names).toEqual(entries);
    // And the assembly point agrees — this is what would actually run at startup.
    const registry = buildRegistry([{ channels: ACTION_CHANNELS, entries: ACTION_ENTRIES }]);
    expect(Object.keys(registry.byChannel).sort()).toEqual(names);
  });

  it('declares no channel twice and every name well-formed', () => {
    expect(new Set(ACTION_CHANNELS).size).toBe(ACTION_CHANNELS.length);
    for (const name of ACTION_CHANNELS) expect(name).toMatch(CHANNEL_PATTERN);
  });

  it('covers every mutation route named in the route→service map', () => {
    // Path templates, not channel names: this is the check that a route was not simply forgotten.
    const templates = new Set(ACTION_ENTRIES.map((e) => `${e.method} ${e.pathTemplate}`));
    for (const expected of [
      'POST /api/proposals/:proposalId/approve',
      'POST /api/proposals/:proposalId/reject',
      'POST /api/proposals/:proposalId/retry',
      'POST /api/corrections/learn',
      'POST /api/mappings/remap',
      'POST /api/accounting-documents/:documentId/classify',
      'POST /api/notifications/:notificationId/read',
      'POST /api/onboarding/step',
      'POST /api/onboarding/dry-run',
      'POST /api/provider-connections/:connectionId/write-gate',
      'POST /api/replies/:replyId/send',
      'POST /api/reply-drafts',
      'PATCH /api/reply-drafts/:draftId',
      'DELETE /api/reply-drafts/:draftId',
      'POST /api/statements/:statementId/correct',
      'POST /api/statements/:statementId/file',
      'POST /api/statements/:statementId/lines/:lineId/match',
      'POST /api/statements/:statementId/lines/:lineId/exclude',
      'POST /api/tax-mappings',
      'POST /api/tax-mappings/:taxMappingId/edit',
      'POST /api/tax-mappings/:taxMappingId/disable',
      'POST /api/tax-mappings/:taxMappingId/replace',
      'POST /api/tax-mappings/:taxMappingId/revalidate',
      'GET /api/tax-mappings/discover',
      'POST /api/dimension-mappings/:mappingId/accept',
      'POST /api/dimension-mappings/:mappingId/correct',
      'POST /api/dimension-mappings/:mappingId/reject',
      'POST /api/dimension-mappings/:mappingId/save-rule',
      'POST /api/dimension-mappings/:mappingId/select-alternate',
      'POST /api/provider-jobs/:jobId/retry',
    ]) {
      expect(templates).toContain(expected);
    }
  });

  it('never registers a pre-auth or redirect route as a channel', () => {
    // `/api/auth/callback` is replaced by CHUNK_5's loopback callback and must never become an
    // IPC channel (route→service map, carry-forward warning 2).
    const paths = ACTION_ENTRIES.map((e) => e.pathTemplate);
    for (const forbidden of [
      '/api/auth/login',
      '/api/auth/callback',
      '/api/auth/logout',
      '/api/connections/gmail/start',
      '/api/connections/qbo/start',
    ]) {
      expect(paths).not.toContain(forbidden);
    }
    for (const name of ACTION_CHANNELS) expect(name).not.toContain('auth');
  });

  it('takes the method from the entry and matches the verb the route declared', () => {
    for (const entry of ACTION_ENTRIES) {
      expect(entry.method).toBe(EXPECTED_METHOD[entry.channel] ?? 'POST');
    }
  });

  it('declares no body keys on the one GET channel', () => {
    const discover = byChannel.get('aphub:tax-mappings:discover')!;
    expect(discover.method).toBe('GET');
    expect(discover.bodyKeys ?? []).toEqual([]);
    // `runDiscoverTaxCodes` reads `code` off searchParams (taxMappings.ts:238), so it must be a
    // query param or the filter silently disappears.
    expect(discover.queryParams).toEqual(['code']);
  });

  it('never duplicates a path param into the body', () => {
    for (const entry of ACTION_ENTRIES) {
      const params = [...entry.pathTemplate.matchAll(/:([A-Za-z][A-Za-z0-9]*)/g)].map((m) => m[1]!);
      for (const param of params) {
        expect(entry.bodyKeys ?? []).not.toContain(param);
        expect(entry.queryParams ?? []).not.toContain(param);
      }
    }
  });

  it('has a valid sample payload for every channel, so the role matrix below is exhaustive', () => {
    expect(Object.keys(VALID_PAYLOAD).sort()).toEqual([...ACTION_CHANNELS].sort());
    for (const entry of ACTION_ENTRIES) {
      const parsed = entry.request.safeParse(VALID_PAYLOAD[entry.channel]);
      expect(parsed.success, `${entry.channel} sample payload must pass its own schema`).toBe(true);
    }
  });
});

describe('the zero-import rule on the action channel list', () => {
  const file = join(ROOT, 'desktop', 'ipc', 'action', 'channels.ts');

  it('has no import and no require, because it is bundled into the sandboxed preload', () => {
    // An import here reproduces the CHUNK_2 `Dynamic require of "events"` crash at the preload
    // layer, where test/desktop-packaging.test.ts does not look.
    expect(existsSync(file)).toBe(true);
    const code = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(code).not.toMatch(/\bimport\b/);
    expect(code).not.toMatch(/\brequire\s*\(/);
    expect(code).not.toMatch(/\bfrom\b/);
    expect(code).toMatch(/as const/);
  });

  it('states every name as a plain literal, never a template or a concatenation', () => {
    const source = readFileSync(file, 'utf8');
    const literals = [...source.matchAll(/'(aphub:[a-z0-9:-]+)'/g)].map((m) => m[1]!);
    expect(literals.sort()).toEqual([...ACTION_CHANNELS].sort());
    // Comments stripped: the doc comment legitimately quotes file names in backticks. What must
    // not appear is a template literal or a concatenation in the CODE — either would defeat the
    // literal scrape that keeps this list and the preload allowlist in step.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(code).not.toContain('`');
    expect(code).not.toContain('+');
  });
});

// --- 2. schema gating: nothing bad reaches a service ----------------------------------------

describe('a payload that fails its schema never reaches the service', () => {
  it.each(ACTION_ENTRIES.map((e) => [e.channel, e] as const))(
    '%s rejects an unknown extra field without invoking the service',
    async (_channel, entry) => {
      const { spy, result } = driveSpied(entry, { ...VALID_PAYLOAD[entry.channel], surprise: 'extra' });
      const envelope = await result;
      expect(envelope.ok).toBe(false);
      expect(envelope.code).toBe('VALIDATION');
      expect(envelope.status).toBe(400);
      expect(spy.called).toBe(false);
    },
  );

  it.each(ACTION_ENTRIES.map((e) => [e.channel, e] as const))(
    '%s rejects an oversized string without invoking the service',
    async (_channel, entry) => {
      // 200_001 chars exceeds every cap in the action schemas, including the 100_000-char
      // email body — so this is a single payload that must fail on every channel.
      const flooded: Record<string, unknown> = { ...VALID_PAYLOAD[entry.channel] };
      let stringKey: string | undefined;
      for (const [key, value] of Object.entries(flooded)) {
        if (typeof value === 'string') {
          stringKey = key;
          break;
        }
      }
      if (stringKey === undefined) return; // no string field on this channel
      flooded[stringKey] = 'x'.repeat(200_001);
      const { spy, result } = driveSpied(entry, flooded);
      const envelope = await result;
      expect(envelope.ok).toBe(false);
      expect(envelope.code).toBe('VALIDATION');
      expect(spy.called).toBe(false);
    },
  );

  it.each(ACTION_ENTRIES.map((e) => [e.channel, e] as const))(
    '%s rejects an identity-shaped field without invoking the service',
    async (_channel, entry) => {
      for (const field of ['token', 'tenantId', 'role', 'userId', 'sessionId']) {
        const { spy, result } = driveSpied(entry, { ...VALID_PAYLOAD[entry.channel], [field]: 'x' });
        const envelope = await result;
        expect(envelope.ok).toBe(false);
        expect(envelope.code).toBe('VALIDATION');
        expect(spy.called).toBe(false);
      }
    },
  );

  it.each(
    ACTION_ENTRIES.filter((e) => e.pathTemplate.includes(':')).map((e) => [e.channel, e] as const),
  )('%s rejects a numeric-string, zero and fractional id at the boundary', async (_channel, entry) => {
    const params = [...entry.pathTemplate.matchAll(/:([A-Za-z][A-Za-z0-9]*)/g)].map((m) => m[1]!);
    for (const param of params) {
      for (const bad of ['987654', 0, -1, 1.5, null]) {
        const { spy, result } = driveSpied(entry, { ...VALID_PAYLOAD[entry.channel], [param]: bad });
        expect((await result).code).toBe('VALIDATION');
        expect(spy.called).toBe(false);
      }
    }
  });

  it.each(
    ACTION_ENTRIES.filter((e) => e.pathTemplate.includes(':')).map((e) => [e.channel, e] as const),
  )('%s rejects an omitted path param, so no URL is ever built with a hole in it', async (_channel, entry) => {
    const params = [...entry.pathTemplate.matchAll(/:([A-Za-z][A-Za-z0-9]*)/g)].map((m) => m[1]!);
    for (const param of params) {
      const payload: Record<string, unknown> = { ...VALID_PAYLOAD[entry.channel] };
      delete payload[param];
      const { spy, result } = driveSpied(entry, payload);
      expect((await result).code).toBe('VALIDATION');
      expect(spy.called).toBe(false);
    }
  });

  it('rejects a payload that is not an object at all', async () => {
    for (const entry of ACTION_ENTRIES) {
      for (const payload of ['a string', 42, [1, 2, 3], true]) {
        const { spy, result } = driveSpied(entry, payload);
        expect((await result).ok).toBe(false);
        expect(spy.called).toBe(false);
      }
    }
  });
});

describe('required reasons are enforced before the service is reached', () => {
  /** Channels whose wrapper returns 400 for a blank reason — the requirement moves earlier. */
  const REASON_REQUIRED = [
    'aphub:proposals:reject',
    'aphub:accounting-documents:classify',
    'aphub:statements:correct',
    'aphub:statements:exclude-line',
    'aphub:statements:match-line',
    'aphub:tax-mappings:edit',
    'aphub:tax-mappings:disable',
    'aphub:tax-mappings:replace',
    'aphub:dimension-mappings:reject',
  ] as const;

  it.each(REASON_REQUIRED)('%s refuses a missing, blank and whitespace-only reason', async (channel) => {
    const entry = byChannel.get(channel)!;
    const base = VALID_PAYLOAD[channel]!;
    expect(base.reason).toBeTypeOf('string');
    for (const reason of [undefined, '', '   ', '\n\t']) {
      const payload: Record<string, unknown> = { ...base };
      if (reason === undefined) delete payload.reason;
      else payload.reason = reason;
      const { spy, result } = driveSpied(entry, payload);
      expect((await result).code).toBe('VALIDATION');
      expect(spy.called).toBe(false);
    }
  });

  it('keeps revalidate\'s reason OPTIONAL, because the wrapper passes undefined rather than ""', () => {
    // src/services/action/taxMappings.ts:227. Making it required "for consistency" would break
    // the screen's re-check button.
    const entry = byChannel.get('aphub:tax-mappings:revalidate')!;
    expect(entry.request.safeParse({ taxMappingId: 5 }).success).toBe(true);
  });
});

// --- 3. the recipient deny-list (guarantee 2) -----------------------------------------------

describe('aphub:replies:send reproduces the recipient deny-list, field by field', () => {
  const entry = () => byChannel.get('aphub:replies:send')!;

  it('carries the same eleven names as the service', () => {
    // src/services/action/index.ts:252-264 — asserted against the source so a name added there
    // and forgotten here is a test failure, not a silent hole.
    const source = readFileSync(join(ROOT, 'src', 'services', 'action', 'index.ts'), 'utf8');
    const block = source.slice(source.indexOf('const RECIPIENT_FIELDS'));
    const serviceList = [...block.slice(0, block.indexOf(']')).matchAll(/'([A-Za-z_]+)'/g)].map((m) => m[1]!);
    expect(serviceList).toHaveLength(11);
    expect([...RECIPIENT_DENY_LIST].sort()).toEqual([...serviceList].sort());
  });

  it.each([
    'to',
    'recipient',
    'recipients',
    'cc',
    'bcc',
    'email',
    'address',
    'to_address',
    'toAddress',
    'from',
    'replyTo',
  ])('rejects a body carrying %s and never reaches the send path', async (field) => {
    // Guard the fixture itself: a typo'd field name here would make this test pass vacuously,
    // because `.strict()` refuses ANY unknown key. The name must be one the service denies.
    expect(RECIPIENT_DENY_LIST).toContain(field);

    const { spy, result } = driveSpied(entry(), { replyId: 7, [field]: 'attacker@example.test' });
    const envelope = await result;
    expect(envelope.ok).toBe(false);
    expect(envelope.code).toBe('VALIDATION');
    expect(envelope.status).toBe(400);
    // The assertion that matters: `sendReply` — and therefore the locked forwarder — was never
    // entered, so no audit row was written and no provider was contacted.
    expect(spy.called).toBe(false);
    // And the recipient the caller tried to name is nowhere in the answer. (The FIELD name is not
    // asserted absent: 'to' and 'from' are substrings of ordinary English, and the
    // "never echoes the caller's own input" test below covers that property with a
    // distinctive marker instead.)
    expect(JSON.stringify(envelope)).not.toContain('attacker@example.test');
    expect(JSON.stringify(envelope)).not.toContain('example.test');
  });

  it('rejects the presence of a deny-listed field even when its value is empty or null', async () => {
    // Presence, not value — mirroring `hasOwnProperty` at index.ts:268.
    for (const value of ['', null, 0, false, undefined]) {
      const { spy, result } = driveSpied(entry(), { replyId: 7, to: value });
      expect((await result).code).toBe('VALIDATION');
      expect(spy.called).toBe(false);
    }
  });

  it('rejects every deny-listed field at once', async () => {
    const payload: Record<string, unknown> = { replyId: 7 };
    for (const field of RECIPIENT_DENY_LIST) payload[field] = 'x@example.test';
    const { spy, result } = driveSpied(entry(), payload);
    expect((await result).code).toBe('VALIDATION');
    expect(spy.called).toBe(false);
  });

  it('declares exactly one field, so there is nothing on this channel that could carry a recipient', () => {
    const shape = (entry().request as unknown as { _def: { schema: z.ZodObject<z.ZodRawShape> } })._def.schema
      .shape;
    expect(Object.keys(shape)).toEqual(['replyId']);
    expect(entry().bodyKeys ?? []).toEqual([]);
  });

  it('admits a clean payload, so the deny-list is not just a broken channel', async () => {
    const spy = new ServiceSpy();
    spy.respond = () => jsonResponse(surrogate('aphub:replies:send'));
    const envelope = await drive({ ...entry(), invoke: spy.invoke }, { replyId: 7 });
    expect(envelope.ok).toBe(true);
    expect(spy.calls).toHaveLength(1);
    // No body at all beyond '{}' — `runAction`'s parseBody needs one, and there is no field on
    // this channel that could carry a recipient.
    await expect(spy.calls[0]!.request.text()).resolves.toBe('{}');
    expect(new URL(spy.calls[0]!.request.url).pathname).toBe('/api/replies/7/send');
  });

  it('leaves exactly one provider-send call site in the tree', () => {
    // Zero would mean the control was DELETED — a defect, not a pass (guarantee 2).
    let sites = 0;
    for (const file of ['src/gmail/adapter.ts', 'src/gatekeeper/forwarder.ts']) {
      const source = readFileSync(join(ROOT, file), 'utf8');
      sites += [...source.matchAll(/messages\.send\s*\(/g)].length;
    }
    expect(sites).toBe(1);
    // And this agent's own modules add none.
    for (const file of readdirActionModules()) {
      expect(readFileSync(file, 'utf8')).not.toMatch(/messages\.send\s*\(/);
    }
  });
});

function readdirActionModules(): string[] {
  const dir = join(ROOT, 'desktop', 'ipc', 'action');
  return [
    'accountingDocuments.ts',
    'channels.ts',
    'corrections.ts',
    'dimensionMappings.ts',
    'fields.ts',
    'index.ts',
    'notifications.ts',
    'onboarding.ts',
    'proposals.ts',
    'providerJobs.ts',
    'replies.ts',
    'replyDrafts.ts',
    'statements.ts',
    'taxMappings.ts',
    'writeGates.ts',
  ].map((name) => join(dir, name));
}

// --- 4. the production-write owner gate (guarantee 3) ---------------------------------------

describe('aphub:provider-connections:write-gate demands all four confirmations', () => {
  const entry = () => byChannel.get('aphub:provider-connections:write-gate')!;
  const complete = {
    connectionId: 4,
    enabled: true,
    confirmedCompanyId: 'Sandbox Company_US_1',
    backupConfirmed: true,
    confirmation: 'ENABLE WRITES',
  };

  it.each(['enabled', 'confirmedCompanyId', 'backupConfirmed', 'confirmation'])(
    'rejects a body missing %s, without reaching the gate',
    async (field) => {
      const payload: Record<string, unknown> = { ...complete };
      delete payload[field];
      const { spy, result } = driveSpied(entry(), payload);
      const envelope = await result;
      expect(envelope.ok).toBe(false);
      expect(envelope.code).toBe('VALIDATION');
      expect(spy.called).toBe(false);
    },
  );

  it.each([
    ['enabled', 'yes'],
    ['backupConfirmed', 'true'],
    ['confirmedCompanyId', 42],
    ['confirmation', true],
  ])('rejects %s of the wrong type', async (field, value) => {
    const { spy, result } = driveSpied(entry(), { ...complete, [field]: value });
    expect((await result).code).toBe('VALIDATION');
    expect(spy.called).toBe(false);
  });

  it('admits the complete confirmation and forwards all four fields in the body', async () => {
    const spy = new ServiceSpy();
    spy.respond = () => jsonResponse({ enabled: true });
    expect((await drive({ ...entry(), invoke: spy.invoke }, complete)).ok).toBe(true);
    await expect(spy.calls[0]!.request.json()).resolves.toEqual({
      enabled: true,
      confirmedCompanyId: 'Sandbox Company_US_1',
      backupConfirmed: true,
      confirmation: 'ENABLE WRITES',
    });
    // connectionId went into the path, positionally — never duplicated into the body.
    expect(new URL(spy.calls[0]!.request.url).pathname).toBe('/api/provider-connections/4/write-gate');
  });

  it('still allows turning writes OFF with empty confirmations, as the wrapper does today', async () => {
    // src/accounting/write-gates.ts:13-19 only requires non-empty values when `enabled` is true.
    // A min(1) here would make the SAFE direction impossible — the schema must not be stricter.
    const spy = new ServiceSpy();
    spy.respond = () => jsonResponse({ enabled: false });
    const envelope = await drive({ ...entry(), invoke: spy.invoke }, {
      connectionId: 4,
      enabled: false,
      confirmedCompanyId: '',
      backupConfirmed: false,
      confirmation: '',
    });
    expect(envelope.ok).toBe(true);
    expect(spy.calls).toHaveLength(1);
  });
});

// --- 5. the role matrix, against real sessions ----------------------------------------------

describe('the role matrix matches the wrapper that actually gates each channel', () => {
  const session: Record<string, string> = {};
  let tenantId = 0;

  beforeAll(async () => {
    await resetTables();
    tenantId = await createTenant('Role Matrix Co');
    for (const role of ['owner_controller', 'bookkeeper', 'cpa']) {
      const userId = await createUser(tenantId, { role, email: `matrix-${role}@example.com` });
      session[role] = (await createSession(userId)).token;
    }
  });

  afterAll(async () => {
    clearSessionToken();
  });

  it('answers UNAUTHENTICATED on every channel when no session is held', async () => {
    clearSessionToken();
    for (const entry of ACTION_ENTRIES) {
      const envelope = await drive(entry, VALID_PAYLOAD[entry.channel]);
      expect(envelope, entry.channel).toMatchObject({
        ok: false,
        status: 401,
        code: 'UNAUTHENTICATED',
        message: plainMessage('UNAUTHENTICATED'),
      });
      expect(envelope.data).toBeUndefined();
    }
  });

  // Exhaustive: every channel × every non-owner role. 30 × 2 = 60 cells, none sampled.
  const cells = ACTION_ENTRIES.flatMap((entry) =>
    ['bookkeeper', 'cpa'].map((role) => [`${entry.channel} as ${role}`, entry, role] as const),
  );

  it.each(cells)('%s', async (_label, entry, role) => {
    setSessionToken(session[role]!);
    const envelope = await drive(entry, VALID_PAYLOAD[entry.channel]);

    if (admits(entry, role)) {
      // Admitted by the wrapper: it must NOT be a permission refusal. The ids do not exist, so
      // the outcome is a not-found or a service validation failure — never 403.
      expect(envelope.code, `${entry.channel} must admit ${role}`).not.toBe('FORBIDDEN');
      expect(envelope.status).not.toBe(403);
    } else {
      expect(envelope, `${entry.channel} must refuse ${role}`).toEqual({
        ok: false,
        status: 403,
        code: 'FORBIDDEN',
        message: plainMessage('FORBIDDEN'),
      });
      expect(envelope.data).toBeUndefined();
    }
  });

  it('refuses bookkeeper on every owner-only channel, and there are 18 of them', async () => {
    const ownerOnly = ACTION_ENTRIES.filter((e) => !admits(e, 'bookkeeper'));
    expect(ownerOnly).toHaveLength(18);
    setSessionToken(session.bookkeeper!);
    for (const entry of ownerOnly) {
      expect((await drive(entry, VALID_PAYLOAD[entry.channel])).code, entry.channel).toBe('FORBIDDEN');
    }
  });

  it('refuses cpa on all 29 channels that are not the notification read', async () => {
    const closed = ACTION_ENTRIES.filter((e) => !admits(e, 'cpa'));
    expect(closed).toHaveLength(29);
    setSessionToken(session.cpa!);
    for (const entry of closed) {
      expect((await drive(entry, VALID_PAYLOAD[entry.channel])).code, entry.channel).toBe('FORBIDDEN');
    }
  });

  it('keeps aphub:notifications:read open to ANY authenticated role, as the wrapper does today', async () => {
    // src/services/action/notifications.ts:22 calls readContext(request) with NO role. This is
    // recorded, deliberate behaviour (route→service map line 134). It is NOT tightened here.
    const entry = byChannel.get('aphub:notifications:read')!;
    expect(entry.role).toBe('any');
    for (const role of ['owner_controller', 'bookkeeper', 'cpa']) {
      setSessionToken(session[role]!);
      const envelope = await drive(entry, { notificationId: 987654 });
      expect(envelope.code, role).not.toBe('FORBIDDEN');
      // The row does not exist, so every role gets the same not-found answer.
      expect(envelope.code).toBe('NOT_FOUND');
    }
  });

  it('declares a role for every channel and never an empty set', () => {
    for (const entry of ACTION_ENTRIES) {
      if (entry.role === 'any') continue;
      expect(entry.role.length).toBeGreaterThan(0);
      for (const role of entry.role) {
        expect(['owner_controller', 'bookkeeper', 'cpa']).toContain(role);
      }
    }
  });
});

// --- 6. cross-tenant isolation ---------------------------------------------------------------

describe('a cross-tenant mutation returns NOT_FOUND, never a foreign row', () => {
  let tenantA = 0;
  let tenantB = 0;

  beforeEach(async () => {
    await resetTables();
    tenantA = await createTenant('Tenant A');
    tenantB = await createTenant('Tenant B');
    const owner = await createUser(tenantA, { role: 'owner_controller', email: 'a-owner@example.com' });
    setSessionToken((await createSession(owner)).token);
  });

  afterAll(async () => {
    clearSessionToken();
    await closeAll();
  });

  it('refuses to reject another tenant\'s proposal, and succeeds on its own', async () => {
    // `Number(...)` is not cosmetic. pg returns `bigint` columns as STRINGS
    // (`src/services/index.ts:51-57`), so the fixture helpers hand back `'1'` despite their
    // `Promise<number>` signature, and `entityId` correctly refuses the numeric-string form. The
    // renderer sends real numbers; the test fixture has to as well or this asserts VALIDATION
    // instead of NOT_FOUND and the isolation property goes untested.
    const foreign = Number(await insertProposal(tenantB, { status: 'review' }));
    const own = Number(await insertProposal(tenantA, { status: 'review' }));
    const entry = byChannel.get('aphub:proposals:reject')!;

    const denied = await drive(entry, { proposalId: foreign, reason: 'not mine' });
    expect(denied).toEqual({
      ok: false,
      status: 404,
      code: 'NOT_FOUND',
      message: plainMessage('NOT_FOUND'),
    });
    expect(JSON.stringify(denied)).not.toContain('Tenant B');

    // The positive control: the same call on the caller's OWN row works, so the 404 above came
    // from tenant scoping and not from a broken channel.
    const allowed = await drive(entry, { proposalId: own, reason: 'not mine' });
    expect(allowed.ok).toBe(true);
    expect(allowed.data).toMatchObject({ status: 'rejected' });
  });

  it('refuses to accept another tenant\'s dimension mapping', async () => {
    const connectionB = Number(await createConnection(tenantB));
    const proposalB = Number(await insertProposal(tenantB));
    const foreign = Number(
      await insertDimensionMapping(tenantB, connectionB, proposalB, {
        proposedProviderId: 'CLASS-99',
        normalizedValue: 'Tenant B Only',
      }),
    );

    const envelope = await drive(byChannel.get('aphub:dimension-mappings:accept')!, { mappingId: foreign });
    expect(envelope.code).toBe('NOT_FOUND');
    expect(envelope.status).toBe(404);
    expect(JSON.stringify(envelope)).not.toContain('CLASS-99');
    expect(JSON.stringify(envelope)).not.toContain('Tenant B Only');
  });

  it('never lets a payload name the tenant it operates on', async () => {
    const foreign = Number(await insertProposal(tenantB, { status: 'review' }));
    const entry = byChannel.get('aphub:proposals:reject')!;
    for (const field of ['tenantId', 'tenant_id', 'tenant']) {
      const envelope = await drive(entry, { proposalId: foreign, reason: 'x', [field]: tenantB });
      expect(envelope).toEqual({
        ok: false,
        status: 400,
        code: 'VALIDATION',
        message: plainMessage('VALIDATION'),
      });
    }
    // And the foreign proposal is untouched: a second scoped attempt still 404s.
    expect((await drive(entry, { proposalId: foreign, reason: 'x' })).code).toBe('NOT_FOUND');
  });
});

// --- 7. message hygiene ----------------------------------------------------------------------

describe('nothing a channel says leaks anything', () => {
  const BANNED = /\b(api|oauth|json|sql|token|cookie|port|endpoint|schema|migration|worker|env|stack|null|undefined|param)\b/i;

  it('gives every channel one plain-language validation message with a next action', () => {
    for (const entry of ACTION_ENTRIES) {
      const message = entry.validationMessage;
      expect(message, entry.channel).toBeTypeOf('string');
      expect(message!.length).toBeGreaterThan(20);
      expect(message, entry.channel).not.toMatch(BANNED);
      expect(message).not.toContain('aphub');
      expect(message).not.toMatch(/[${}]/); // no interpolation site
      expect(message).not.toMatch(/[A-Z]{3,}_[A-Z]{3,}/); // no raw error code
      expect(message).not.toMatch(/\bat\s+\w+\s*\(/); // no stack frame
      expect(message).not.toMatch(/\/api\//); // no route path
      expect(message).not.toMatch(/\b\d{2,5}\b/); // no status code or port
    }
  });

  it('never forwards a raw provider error, a driver error or a stack trace', async () => {
    for (const entry of ACTION_ENTRIES) {
      const poisoned = [
        errorResponse('VALIDATION', "invalid dimensionType 'zzz-secret-value'", 400),
        errorResponse('VALIDATION', 'replace failed: connect ECONNREFUSED 127.0.0.1:5432', 400),
        errorResponse('INTERNAL', 'Intuit said: AuthenticationErrorFault realmId=4620816365', 500),
      ];
      for (const response of poisoned) {
        const spy = new ServiceSpy();
        spy.respond = () => response.clone();
        const envelope = await drive({ ...entry, invoke: spy.invoke }, VALID_PAYLOAD[entry.channel]);
        const wire = JSON.stringify(envelope);
        expect(wire).not.toContain('zzz-secret-value');
        expect(wire).not.toContain('ECONNREFUSED');
        expect(wire).not.toContain('5432');
        expect(wire).not.toContain('realmId');
        expect(wire).not.toContain('4620816365');
        expect(wire).not.toContain('dimensionType');
      }
    }
  });

  it('never echoes the channel name, and answers a thrown service with INTERNAL only', async () => {
    for (const entry of ACTION_ENTRIES) {
      const spy = new ServiceSpy();
      spy.respond = () => {
        throw new Error('relation "proposals" does not exist at Client._handleErrorMessage');
      };
      const envelope = await drive({ ...entry, invoke: spy.invoke }, VALID_PAYLOAD[entry.channel]);
      expect(envelope).toEqual({
        ok: false,
        status: 500,
        code: 'INTERNAL',
        message: plainMessage('INTERNAL'),
      });
      const wire = JSON.stringify(envelope);
      expect(wire).not.toContain(entry.channel);
      expect(wire).not.toContain('aphub:');
      expect(wire).not.toContain('_handleErrorMessage');
    }
  });

  it('never echoes the caller\'s own input back in a validation refusal', async () => {
    for (const entry of ACTION_ENTRIES) {
      const { result } = driveSpied(entry, {
        ...VALID_PAYLOAD[entry.channel],
        zzzUnknownField: 'caller-supplied-marker',
      });
      const wire = JSON.stringify(await result);
      expect(wire).not.toContain('caller-supplied-marker');
      expect(wire).not.toContain('zzzUnknownField');
    }
  });
});

// --- 8. response schemas fail open, not closed ------------------------------------------------

describe('response schemas document without breaking', () => {
  it('accepts a bigint id arriving as a string, which is how pg hands them back', async () => {
    // `persistedId`, not z.number(): src/services/index.ts:51-57. A z.number() here makes the
    // dispatcher fail a perfectly good mutation closed with INTERNAL.
    const spy = new ServiceSpy();
    spy.respond = () => jsonResponse({ proposal_id: '987654', status: 'rejected' });
    const envelope = await drive({ ...byChannel.get('aphub:proposals:reject')!, invoke: spy.invoke }, {
      proposalId: 987654,
      reason: 'ok',
    });
    expect(envelope.ok).toBe(true);
    expect(envelope.data).toMatchObject({ proposal_id: '987654' });
  });

  it('lets a service add a column without breaking the channel', async () => {
    for (const entry of ACTION_ENTRIES) {
      const spy = new ServiceSpy();
      spy.respond = () => jsonResponse({ ...surrogate(entry.channel), brandNewColumn: 'later' });
      const envelope = await drive({ ...entry, invoke: spy.invoke }, VALID_PAYLOAD[entry.channel]);
      expect(envelope.ok, entry.channel).toBe(true);
      expect(envelope.data).toMatchObject({ brandNewColumn: 'later' });
    }
  });

  it('keeps the approve/retry response open enough for all four post outcomes', async () => {
    // postResultResponse (src/services/action/index.ts:127) has four success shapes. A narrow
    // schema would turn a correct `held` answer — guarantee 5 made visible — into INTERNAL.
    for (const channel of ['aphub:proposals:approve', 'aphub:proposals:retry']) {
      const entry = byChannel.get(channel)!;
      for (const body of [
        { posting_id: 5, qbo_type: 'Bill', qbo_id: '77', qbo_link: null, mode: 'sandbox' },
        { status: 'queued', provider: 'qbd', providerJobId: '9' },
        { status: 'held', code: 'HELD_FOR_REVIEW', reason: 'over ceiling' },
      ]) {
        const spy = new ServiceSpy();
        spy.respond = () => jsonResponse(body, 202);
        const envelope = await drive({ ...entry, invoke: spy.invoke }, VALID_PAYLOAD[channel]);
        expect(envelope.ok, `${channel} ${JSON.stringify(body)}`).toBe(true);
        expect(envelope.data).toEqual(body);
      }
    }
  });

  it('carries ALREADY_POSTED through as its own code, because it is guarantee 4 made visible', async () => {
    const spy = new ServiceSpy();
    spy.respond = () => errorResponse('ALREADY_POSTED', 'proposal already posted', 409);
    const envelope = await drive({ ...byChannel.get('aphub:proposals:approve')!, invoke: spy.invoke }, {
      proposalId: 1,
    });
    expect(envelope).toEqual({
      ok: false,
      status: 409,
      code: 'ALREADY_POSTED',
      message: plainMessage('ALREADY_POSTED'),
    });
  });

  it('carries the retry-safe 202 through as ok:true, which the retry screens depend on', async () => {
    const spy = new ServiceSpy();
    spy.respond = () => errorResponse('QBO_RETRY', 'qbo post failed; safe to retry', 202);
    const envelope = await drive({ ...byChannel.get('aphub:proposals:retry')!, invoke: spy.invoke }, {
      proposalId: 1,
    });
    expect(envelope.ok).toBe(true);
    expect(envelope.status).toBe(202);
    expect(envelope.code).toBe('QBO_RETRY');
  });
});

/** The minimum success payload each channel's response schema documents. */
function surrogate(channel: string): Record<string, unknown> {
  switch (channel) {
    case 'aphub:proposals:reject':
      return { proposal_id: 1, status: 'rejected' };
    case 'aphub:corrections:learn':
      return { correction_id: 1 };
    case 'aphub:mappings:remap':
      return { kind: 'vendor', source_key: 'acme' };
    case 'aphub:accounting-documents:classify':
      return { classification: 'invoice', queued: true };
    case 'aphub:provider-connections:write-gate':
      return { enabled: false };
    case 'aphub:replies:send':
      return { forward_id: 1, to: 'capture@qbo.example', send_id: 'g-1' };
    case 'aphub:statements:correct':
    case 'aphub:statements:file':
    case 'aphub:statements:match-line':
    case 'aphub:statements:exclude-line':
      return { ok: true };
    case 'aphub:tax-mappings:replace':
      return { old: {}, replacement: {} };
    case 'aphub:tax-mappings:create':
    case 'aphub:tax-mappings:edit':
    case 'aphub:tax-mappings:disable':
    case 'aphub:tax-mappings:revalidate':
    case 'aphub:dimension-mappings:accept':
    case 'aphub:dimension-mappings:correct':
    case 'aphub:dimension-mappings:reject':
    case 'aphub:dimension-mappings:select-alternate':
      return { mapping: {} };
    case 'aphub:dimension-mappings:save-rule':
      return { rule: {} };
    default:
      return {};
  }
}

// --- 9. the service layer was not touched -----------------------------------------------------

describe('the port changed the transport and nothing else', () => {
  it('defines no second authorization path in any action module', () => {
    // Every role gate must live in the `src/**` wrapper the channel calls. The ONE exception is
    // `providerJobs.ts`, which reproduces the route file's inline `requireSession` because that
    // operation has no exported wrapper — and it uses the same function with the same literal.
    for (const file of readdirActionModules()) {
      const source = readFileSync(file, 'utf8');
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
      if (file.endsWith('providerJobs.ts')) {
        expect(code).toContain("requireSession(tokenFromRequest(request), 'owner_controller')");
        continue;
      }
      expect(code, file).not.toMatch(/\brequireSession\b/);
      expect(code, file).not.toMatch(/\breadContext\b/);
      expect(code, file).not.toMatch(/\bensurePermission\b/);
    }
  });

  it('calls each service wrapper with no deps argument, so production takes the real adapters', () => {
    for (const file of readdirActionModules()) {
      // Comments stripped — several of them explain the rule and name `deps` while doing so.
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
      // A `deps` argument would silently swap a real adapter for a stub in production. Four
      // wrappers accept one (`runApprove`, `runRetry`, `runSendReply`, the reply-draft trio) and
      // every route file omits it; so does every channel here.
      expect(code, file).not.toMatch(/\bdeps\b/);
    }
  });
});
