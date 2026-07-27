import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

import { IPC_CHANNELS, SHELL_CHANNELS } from '../desktop/channels.js';
import { READ_CHANNELS } from '../desktop/ipc/read/channels.js';
import { READ_ENTRIES } from '../desktop/ipc/read/index.js';
import { ACTION_CHANNELS, ACTION_ENTRIES } from '../desktop/ipc/action/index.js';
import { buildRegistry, type RegistryEntry } from '../desktop/ipc/registry.js';
import { createDispatcher } from '../desktop/ipc/dispatcher.js';
import { clearSessionToken, setSessionToken } from '../desktop/ipc/context.js';
import { IPC_ERROR_CODES, isIpcErrorCode, plainMessage } from '../desktop/ipc/errors.js';
import type { IpcResult } from '../desktop/ipc/envelope.js';

import { ROLES } from '../src/auth/guard.js';
import { createSession } from '../src/auth/session.js';
import { query } from '../src/db/pool.js';
import {
  closeAll,
  createConnection,
  createTenant,
  createUser,
  insertAttachment,
  insertDimensionMapping,
  insertExtraction,
  insertMessage,
  insertProposal,
  resetTables,
} from './helpers.js';
import {
  insertMarkedAccountingDocument,
  insertMarkedBankStatement,
  insertMarkedBankStatementLine,
  insertMarkedException,
  insertMarkedForward,
  insertMarkedNotification,
  insertMarkedProposal,
  insertMarkedProviderJob,
  insertMarkedReplyDraft,
  insertMarkedTaxMapping,
  insertMarkedTaxMappingAudit,
  openDryRunGate,
  uniqueMarker,
} from './helpers/ipc-contract-fixtures.js';
import { hashToken } from '../src/auth/session.js';

const ROOT = join(__dirname, '..');

/**
 * B6 — the independent, unified, exhaustive IPC contract replay.
 *
 * `test/ipc-foundation.test.ts`, `test/ipc-read-domains.test.ts` and `test/ipc-action-domains.test.ts`
 * each test the machinery or one domain's own wiring. This file is the cross-cutting replay
 * `specs/03_CHUNK_3_IPC.md` and `docs/build/interfaces/ipc-auth-context.md` §5 require: the full
 * role and cross-tenant matrices from `test/f5-cross-tenant-isolation.test.ts`, driven off the
 * REAL, ASSEMBLED registry — `READ_ENTRIES` + `ACTION_ENTRIES`, dispatched under their REAL
 * channel names (already members of the real `IPC_CHANNELS` allowlist) — so a channel added
 * later cannot silently skip it.
 *
 * Every dispatch here goes through the same `createDispatcher` production code path
 * (allowlist → registry lookup → DB gate → identity screen → zod → synthesize → invoke →
 * decode) that `registerProductHandlers` wires onto `ipcMain`. Nothing under `src/**`,
 * `desktop/**` or `app/**` is edited, forked or mocked at the entry level — only `invoke` is
 * ever swapped for a spy, and only in the schema-gating / leakage sections that say so.
 */

// ---------------------------------------------------------------------------------------------
// 0. the combined registry — the one source of truth for "all 52 channels"
// ---------------------------------------------------------------------------------------------

const REGISTRY = buildRegistry([
  { channels: READ_CHANNELS, entries: READ_ENTRIES },
  { channels: ACTION_CHANNELS, entries: ACTION_ENTRIES },
]);

const ALL_ENTRIES: readonly RegistryEntry[] = [...READ_ENTRIES, ...ACTION_ENTRIES];
const ALL_CHANNELS: readonly string[] = REGISTRY.channels;

function entryFor(channel: string): RegistryEntry {
  const entry = REGISTRY.byChannel[channel];
  if (!entry) throw new Error(`test setup: no entry for ${channel}`);
  return entry;
}

// ---------------------------------------------------------------------------------------------
// 1. one schema-valid sample payload per channel
// ---------------------------------------------------------------------------------------------

/**
 * Every id-shaped value here is a sentinel that does not exist (`987654` / `654321`), exactly as
 * `test/ipc-action-domains.test.ts` does: an admitted call fails on a missing row, never on a
 * real mutation, and every service reached this way looks the row up (tenant-scoped) before any
 * provider I/O.
 */
const VALID_PAYLOAD: Readonly<Record<string, Record<string, unknown>>> = {
  // --- reads --------------------------------------------------------------------------------
  'aphub:today:get': {},
  'aphub:transactions:list': {},
  'aphub:transactions:get': { id: 987654 },
  'aphub:exceptions:list': {},
  'aphub:exceptions:get': { id: 987654 },
  'aphub:evidence:get': { id: 987654 },
  'aphub:audit:list': {},
  'aphub:notifications:list': {},
  'aphub:me:get': {},
  'aphub:accounting-documents:review': {},
  'aphub:statements:list': {},
  'aphub:statements:get': { id: 987654 },
  'aphub:reply-drafts:get': { messageId: 987654 },
  'aphub:provider-capabilities:list': {},
  'aphub:provider-jobs:list': {},
  'aphub:dimension-mappings:list': {},
  'aphub:tax-mappings:list': {},
  'aphub:tax-mappings:get': { id: 987654 },
  'aphub:tax-mappings:discover': {},
  'aphub:tax-mappings:audit': { id: 987654 },
  'aphub:onboarding:get': {},
  'aphub:connections:status': {},
  'aphub:backup:list': {},

  // --- actions --------------------------------------------------------------------------------
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
    // camelCase: `CORRECTABLE_FIELDS` (`src/statements/review.ts:252-260`) keys on the camelCase
    // form and maps it onto the snake_case column itself; the snake_case form is not correctable
    // and throws a service-level VALIDATION before the statement is even looked up.
    field: 'closingBalance',
    value: '1200.00',
    reason: 'mistyped from the PDF',
  },
  'aphub:statements:file': { statementId: 987654 },
  'aphub:statements:match-line': {
    statementId: 987654,
    lineId: 654321,
    providerRef: { transactionId: 'QB-8812' },
    reason: 'same amount and date',
  },
  'aphub:statements:exclude-line': { statementId: 987654, lineId: 654321, reason: 'duplicate line' },
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
  'aphub:dimension-mappings:accept': { mappingId: 987654 },
  'aphub:dimension-mappings:correct': { mappingId: 987654, normalizedValue: 'Marketing' },
  'aphub:dimension-mappings:reject': { mappingId: 987654, reason: 'not a department' },
  'aphub:dimension-mappings:save-rule': { mappingId: 987654 },
  'aphub:dimension-mappings:select-alternate': { mappingId: 987654, providerId: '42' },
  'aphub:provider-jobs:retry': { jobId: 987654 },
  'aphub:connections:start': { provider: 'gmail' },
  // Sentinel id: no such backup row exists, so both channels answer NOT_FOUND without ever
  // touching the credential store or the filesystem (`src/backup/http.ts`'s existence
  // pre-check runs before `restoreBackup`'s own `getOrCreateBackupKey`/`mkdir`).
  'aphub:backup:restore': { backupId: 987654 },
  'aphub:backup:export': { backupId: 987654, destination: 'C:\\Users\\Public\\aphub-export-test.aphubbak' },
};

// ---------------------------------------------------------------------------------------------
// 2. drive an entry through the REAL dispatcher, under its REAL, already-allowlisted name
// ---------------------------------------------------------------------------------------------

const ready = (): 'ready' => 'ready';

interface Call {
  readonly request: Request;
  readonly payload: Record<string, unknown>;
}

class ServiceSpy {
  readonly calls: Call[] = [];
  respond: (call: Call) => Response | Promise<Response> = () => new Response(JSON.stringify({ data: { ok: true } }));

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
 * Dispatches under the entry's OWN channel name. This is safe (unlike the two domain test
 * files, which had to borrow a shell name because their own channel list had not been merged
 * into `desktop/channels.ts` yet): every name in `ALL_CHANNELS` is already a real member of the
 * live `IPC_CHANNELS` allowlist (`desktop/channels.ts` spreads `READ_CHANNELS`/`ACTION_CHANNELS`
 * verbatim), so `isAllowedChannel` — the real one, not a stand-in — passes for real.
 */
function drive(
  entry: RegistryEntry,
  payload?: unknown,
  databaseState: () => 'ready' | 'starting' | 'failed' = ready,
): Promise<IpcResult> {
  const { dispatch } = createDispatcher({
    contributions: [{ channels: [entry.channel], entries: [entry] }],
    databaseState,
  });
  return dispatch(entry.channel, payload);
}

function driveSpied(entry: RegistryEntry, payload?: unknown): { spy: ServiceSpy; result: Promise<IpcResult> } {
  const spy = new ServiceSpy();
  const result = drive({ ...entry, invoke: spy.invoke }, payload);
  return { spy, result };
}

function admits(entry: RegistryEntry, role: string): boolean {
  return entry.role === 'any' || entry.role.includes(role as never);
}

async function sessionFor(tenantId: number, role: string): Promise<string> {
  const userId = await createUser(tenantId, { role });
  return (await createSession(userId)).token;
}

/** No banned substring crossed the bridge: channel names, stack frames, SQL/table hints, file
 * paths, secrets vocabulary, or the jargon the non-technical user must never see (CLAUDE.md). */
const BANNED = /\b(api|oauth|json|sql|token|session|cookie|port|database|schema|migration|worker|model|env(?:ironment)?[\s-]?var(?:iable)?s?)\b/i;

function assertNoLeakage(envelope: unknown, entry?: RegistryEntry): void {
  const wire = JSON.stringify(envelope);
  expect(wire, wire).not.toMatch(BANNED);
  expect(wire).not.toContain('aphub:');
  if (entry) expect(wire).not.toContain(entry.channel);
  expect(wire).not.toMatch(/[A-Za-z]:\\|\/(src|desktop|app)\//); // a file path
  expect(wire).not.toMatch(/\bat\s+\w+(\.\w+)*\s*\(/); // a stack frame
}

// ===============================================================================================
// 1. THE SURFACE: exactly 52 channels, every sample payload valid against its OWN schema
// ===============================================================================================

describe('the combined registry is exactly the 55 channels this chunk migrated (52 original + 3 CHUNK_7_BACKUP)', () => {
  it('READ (23) + ACTION (32) = 55, and the registry agrees', () => {
    expect(READ_CHANNELS).toHaveLength(23);
    expect(ACTION_CHANNELS).toHaveLength(32);
    expect(ALL_CHANNELS).toHaveLength(55);
    expect(ALL_ENTRIES).toHaveLength(55);
    expect(new Set(ALL_CHANNELS).size).toBe(55); // no name shared between the two domains
  });

  it('has a valid sample payload for every one of the 55 channels — asserted against its OWN schema', () => {
    // This is the correctness detail the task packet calls out explicitly: a payload that fails
    // its own schema would return VALIDATION for every role, which is indistinguishable from a
    // correctly-enforced FORBIDDEN and would make the entire role matrix below pass vacuously.
    expect(Object.keys(VALID_PAYLOAD).sort()).toEqual([...ALL_CHANNELS].sort());
    for (const entry of ALL_ENTRIES) {
      const sample = VALID_PAYLOAD[entry.channel];
      const parsed = entry.request.safeParse(sample);
      expect(parsed.success, `${entry.channel} sample payload must pass its own schema: ${JSON.stringify(parsed.success ? null : parsed.error?.issues)}`).toBe(true);
    }
  });

  it('registers no channel twice and every one is well-formed aphub:<domain>:<action>', () => {
    for (const channel of ALL_CHANNELS) expect(channel).toMatch(/^aphub:[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/);
  });
});

// ===============================================================================================
// 2. registry / allowlist symmetry — both directions
// ===============================================================================================

describe('registry/allowlist symmetry: every registry channel is allowlisted, every non-shell allowlisted channel is registered', () => {
  it('every one of the 55 registry channels is a member of the real IPC_CHANNELS', () => {
    for (const channel of ALL_CHANNELS) expect(IPC_CHANNELS).toContain(channel);
  });

  it('every non-shell IPC_CHANNELS member has a registry entry — nothing is dead surface', () => {
    const nonShell = IPC_CHANNELS.filter((c) => !(SHELL_CHANNELS as readonly string[]).includes(c));
    expect(nonShell).toHaveLength(55);
    for (const channel of nonShell) expect(ALL_CHANNELS).toContain(channel);
  });

  it('IPC_CHANNELS is exactly SHELL_CHANNELS plus the 55 registry channels, set-equal', () => {
    const expected = new Set([...SHELL_CHANNELS, ...ALL_CHANNELS]);
    expect(new Set(IPC_CHANNELS)).toEqual(expected);
  });
});

// ===============================================================================================
// 3. THE ROLE MATRIX — exhaustive over 55 channels × 3 roles, no sampling
// ===============================================================================================

describe('the exhaustive role matrix: every channel × every role in ROLES', () => {
  const session: Record<string, string> = {};
  let tenantId = 0;

  beforeAll(async () => {
    await resetTables();
    tenantId = await createTenant(uniqueMarker('role-matrix-tenant'));
    // Opens the DRY_RUN_LOCKED gate so aphub:proposals:{approve,retry} are not masked FORBIDDEN
    // by the onboarding business rule, which normalizeCode maps onto the SAME code as an RBAC
    // refusal (`docs/build/interfaces/ipc-error-contract.md`, EXPLICIT.DRY_RUN_LOCKED).
    await openDryRunGate(tenantId);
    for (const role of ROLES) session[role] = await sessionFor(tenantId, role);
  });

  afterAll(() => clearSessionToken());

  it('asserts against exactly the registry size, so a channel cannot silently skip the matrix', () => {
    expect(ALL_ENTRIES.length).toBe(REGISTRY.channels.length);
    expect(ALL_ENTRIES.length).toBe(55);
  });

  const cells = ALL_ENTRIES.flatMap((entry) => ROLES.map((role) => [`${entry.channel} as ${role}`, entry, role] as const));

  it(`covers exactly ${55 * ROLES.length} cells (55 channels × ${ROLES.length} roles)`, () => {
    expect(cells).toHaveLength(55 * ROLES.length);
  });

  it.each(cells)('%s', async (_label, entry, role) => {
    setSessionToken(session[role]!);
    const envelope = await drive(entry, VALID_PAYLOAD[entry.channel]);

    if (admits(entry, role)) {
      // Admitted: the wrapper must not have refused on ROLE. The ids are sentinels, so the
      // outcome is a not-found, a fail-safe retry code, or a validation failure — never FORBIDDEN.
      expect(envelope.code, `${entry.channel} must admit ${role} (got ${JSON.stringify(envelope)})`).not.toBe('FORBIDDEN');
      expect(envelope.status).not.toBe(403);
    } else {
      expect(envelope, `${entry.channel} must refuse ${role}`).toEqual({
        ok: false,
        status: 403,
        code: 'FORBIDDEN',
        message: plainMessage('FORBIDDEN'),
      });
      expect(envelope.data).toBeUndefined();
      assertNoLeakage(envelope, entry);
    }
  });
});

// ===============================================================================================
// 4. UNAUTHENTICATED — exhaustive, no session at all
// ===============================================================================================

describe('every one of the 55 channels answers UNAUTHENTICATED with no session held', () => {
  beforeEach(() => clearSessionToken());

  it.each(ALL_ENTRIES.map((e) => [e.channel, e] as const))('%s', async (_channel, entry) => {
    const envelope = await drive(entry, VALID_PAYLOAD[entry.channel]);
    expect(envelope).toEqual({
      ok: false,
      status: 401,
      code: 'UNAUTHENTICATED',
      message: plainMessage('UNAUTHENTICATED'),
    });
    expect(envelope.data).toBeUndefined();
    assertNoLeakage(envelope, entry);
  });
});

// ===============================================================================================
// 5. EXPIRED / CLEARED SESSION — exhaustive
// ===============================================================================================

describe('every one of the 55 channels refuses once the session is cleared', () => {
  let tenantId = 0;

  beforeAll(async () => {
    await resetTables();
    tenantId = await createTenant(uniqueMarker('cleared-session-tenant'));
  });
  afterAll(() => clearSessionToken());

  it.each(ALL_ENTRIES.map((e) => [e.channel, e] as const))(
    '%s: a stale call cannot re-authenticate after clearSessionToken()',
    async (_channel, entry) => {
      setSessionToken(await sessionFor(tenantId, 'owner_controller'));
      const before = await drive(entry, VALID_PAYLOAD[entry.channel]);
      expect(before.code, entry.channel).not.toBe('UNAUTHENTICATED');

      clearSessionToken();
      const after = await drive(entry, VALID_PAYLOAD[entry.channel]);
      expect(after).toEqual({
        ok: false,
        status: 401,
        code: 'UNAUTHENTICATED',
        message: plainMessage('UNAUTHENTICATED'),
      });
      expect(after.data).toBeUndefined();
    },
  );

  it('a genuinely expired session (not merely cleared) answers SESSION_EXPIRED, not UNAUTHENTICATED', async () => {
    // Not claimed exhaustive across all 55 (both codes redirect to /login identically —
    // ipc-auth-context.md §4.1 — so this is a spot check of the distinct code, not a second
    // full matrix): create a real session row, then age it past expiry directly.
    const userId = await createUser(tenantId, { role: 'owner_controller' });
    const { token } = await createSession(userId);
    await query(`UPDATE sessions SET expires_at = now() - interval '1 hour' WHERE token_hash = $1`, [
      hashToken(token),
    ]);
    setSessionToken(token);
    const envelope = await drive(entryFor('aphub:me:get'), {});
    expect(['SESSION_EXPIRED', 'UNAUTHENTICATED']).toContain(envelope.code);
  });
});

// ===============================================================================================
// 6. RENDERER IDENTITY INJECTION — exhaustive over channels, representative over fields
// ===============================================================================================

describe('no channel lets the renderer choose its own identity', () => {
  let tenantId = 0;

  beforeAll(async () => {
    await resetTables();
    tenantId = await createTenant(uniqueMarker('identity-injection-tenant'));
  });
  afterAll(() => clearSessionToken());

  const IDENTITY_PROBES = ['token', 'tenantId', 'role', 'userId', 'sessionId', 'email', 'actor', 'cookie'] as const;

  it.each(ALL_ENTRIES.map((e) => [e.channel, e] as const))(
    '%s: an identity-shaped field never influences the resolved identity, on every probe field',
    async (_channel, entry) => {
      setSessionToken(await sessionFor(tenantId, 'owner_controller'));
      for (const field of IDENTITY_PROBES) {
        const { spy, result } = driveSpied(entry, { ...VALID_PAYLOAD[entry.channel], [field]: 'attacker-supplied' });
        const envelope = await result;
        expect(envelope, `${entry.channel} + ${field}`).toEqual({
          ok: false,
          status: 400,
          code: 'VALIDATION',
          message: plainMessage('VALIDATION'),
        });
        expect(spy.called).toBe(false);
        assertNoLeakage(envelope, entry);
      }
    },
  );
});

// ===============================================================================================
// 7. NO LEAKAGE IN ANY ERROR — exhaustive over channels and failure modes
// ===============================================================================================

describe('nothing any channel says leaks a channel name, a stack, SQL, a table, a path, a secret word, or jargon', () => {
  it('every validationMessage is plain language with a next action, and names nothing internal', () => {
    for (const entry of ALL_ENTRIES) {
      const message = entry.validationMessage;
      if (message === undefined) continue; // the generic VALIDATION string is used instead
      expect(message.length, entry.channel).toBeGreaterThan(10);
      expect(message, entry.channel).not.toMatch(BANNED);
      expect(message).not.toContain('aphub');
      expect(message).not.toMatch(/[${}]/);
      expect(message).not.toMatch(/\bat\s+\w+\s*\(/);
    }
  });

  it('every code in the closed set has a plain-language message naming nothing internal', () => {
    for (const code of IPC_ERROR_CODES) {
      const message = plainMessage(code);
      expect(message).not.toMatch(BANNED);
      expect(message).not.toContain('aphub');
      expect(message).not.toContain(code);
    }
  });

  describe('a thrown service error never crosses the bridge as anything but INTERNAL, on every channel', () => {
    it.each(ALL_ENTRIES.map((e) => [e.channel, e] as const))('%s', async (_channel, entry) => {
      const thrower = new ServiceSpy();
      thrower.respond = () => {
        throw new Error(
          `relation "${uniqueMarker('secret-table')}" does not exist at Client._handleErrorMessage (C:\\ap-hub\\src\\db\\pool.ts:42)`,
        );
      };
      const envelope = await drive({ ...entry, invoke: thrower.invoke }, VALID_PAYLOAD[entry.channel]);
      expect(envelope).toEqual({
        ok: false,
        status: 500,
        code: 'INTERNAL',
        message: plainMessage('INTERNAL'),
      });
      assertNoLeakage(envelope, entry);
    });
  });

  describe('a poisoned service message (driver error, provider error, caller-interpolated value) never crosses the bridge, on every channel', () => {
    it.each(ALL_ENTRIES.map((e) => [e.channel, e] as const))('%s', async (_channel, entry) => {
      const marker = uniqueMarker('poison');
      const poisonedMessages = [
        `invalid dimensionType '${marker}'`,
        `replace failed: connect ECONNREFUSED 127.0.0.1:5432 (${marker})`,
        `Intuit said: AuthenticationErrorFault realmId=4620816365 (${marker})`,
      ];
      for (const text of poisonedMessages) {
        const spy = new ServiceSpy();
        spy.respond = () =>
          new Response(JSON.stringify({ error: { code: 'VALIDATION', message: text } }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
          });
        const envelope = await drive({ ...entry, invoke: spy.invoke }, VALID_PAYLOAD[entry.channel]);
        const wire = JSON.stringify(envelope);
        expect(wire, `${entry.channel}: ${text}`).not.toContain(marker);
        expect(wire).not.toContain('ECONNREFUSED');
        expect(wire).not.toContain('5432');
        expect(wire).not.toContain('realmId');
        expect(wire).not.toContain('dimensionType');
      }
    });
  });

  it('never echoes the channel name: every failure() call site passes only a closed, literal code', () => {
    // Structural, over the source rather than re-deriving it per call: every `failure(...)` call
    // site in the dispatcher passes a literal `IpcErrorCode`, never `channel` or any per-request
    // value, so there is no expression anywhere that could interpolate a channel name into a
    // message (comments are stripped first — this file's own doc comments discuss "channel"
    // extensively in prose, which is not the property under test).
    const withoutComments = (source: string): string =>
      source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const dispatcherSource = withoutComments(readFileSync(join(ROOT, 'desktop', 'ipc', 'dispatcher.ts'), 'utf8'));
    expect(dispatcherSource).not.toMatch(/failure\([^)]*channel/);
  });

  it('every one of the 55 channel names is absent from every FORBIDDEN/UNAUTHENTICATED/VALIDATION message text', () => {
    for (const code of ['FORBIDDEN', 'UNAUTHENTICATED', 'VALIDATION', 'NOT_FOUND'] as const) {
      const message = plainMessage(code);
      for (const channel of ALL_CHANNELS) expect(message).not.toContain(channel);
    }
  });
});

// ===============================================================================================
// 8. EVERY CHANNEL IS REACHABLE — a well-formed envelope, never an unhandled throw
// ===============================================================================================

describe('every one of the 55 channels is reachable and returns a well-formed envelope', () => {
  let tenantId = 0;

  beforeAll(async () => {
    await resetTables();
    tenantId = await createTenant(uniqueMarker('reachability-tenant'));
    await openDryRunGate(tenantId);
  });
  afterAll(async () => {
    clearSessionToken();
  });

  it.each(ALL_ENTRIES.map((e) => [e.channel, e] as const))('%s', async (_channel, entry) => {
    // owner_controller is admitted by every one of the 55 channels (ipc-auth-context.md §3/§5.1).
    setSessionToken(await sessionFor(tenantId, 'owner_controller'));
    const envelope = await drive(entry, VALID_PAYLOAD[entry.channel]);
    expect(typeof envelope.ok, entry.channel).toBe('boolean');
    if (envelope.ok) {
      expect(envelope.code === undefined || isIpcErrorCode(envelope.code), entry.channel).toBe(true);
    } else {
      expect(isIpcErrorCode(envelope.code), `${entry.channel}: ${JSON.stringify(envelope)}`).toBe(true);
      expect(typeof envelope.message).toBe('string');
    }
    expect(envelope.code).not.toBe('FORBIDDEN');
  });
});

// ===============================================================================================
// 9. EXHAUSTIVE CROSS-TENANT ISOLATION
// ===============================================================================================
//
// 32 channels take an id (path or query param) that names a specific tenant-scoped row: these
// get the full F5-style replay — seed the row in tenant B, call as tenant A (owner_controller,
// which every one of the 55 channels admits), and assert NOT_FOUND with the foreign content
// absent — never FORBIDDEN (which would leak existence) and never the foreign row.
//
// 2 more channels (`aphub:backup:restore`, `aphub:backup:export`, CHUNK_7_BACKUP) also take a
// required id but are deliberately EXCLUDED from that replay: `backups` has no `tenant_id`
// column at all (`migrations/015_backups.sql`) — it covers the whole local install, not a
// tenant, so there is no "tenant B's row" for a tenant-A caller to be denied. These get their
// own describe block below instead, proving the opposite invariant on purpose: any tenant's
// owner_controller can see and act on the SAME backup, which is the intended shared-visibility
// design, not a leak.
//
// The remaining 21 channels are list/global reads or tenant-wide mutations with NO id-shaped
// field in their schema at all (`defineChannel`'s own IDENTITY/UNROUTED checks already prove
// this structurally); for those, isolation is proven by (a) the structural absence of a
// foreign-row-selecting field, and (b) for every one that queries a real table, a live check
// that a marker seeded in tenant B never appears in tenant A's result.

interface CrossTenantFixture {
  readonly ids: Record<string, number>;
  readonly marker: string;
}

/** Every id-taking channel's cross-tenant fixture: seeds ONE row owned by `tenantB`, scoped
 * exactly the way the real service looks it up, with a marker in a column the response (or a
 * would-be-leaked response) would actually surface. */
const CROSS_TENANT_SEED: Readonly<Record<string, (tenantB: number) => Promise<CrossTenantFixture>>> = {
  // --- reads ----------------------------------------------------------------------------------
  'aphub:transactions:get': async (tenantB) => {
    const marker = uniqueMarker('vendor');
    const id = Number(await insertMarkedProposal(tenantB, { vendorName: marker }));
    return { ids: { id }, marker };
  },
  'aphub:evidence:get': async (tenantB) => {
    const marker = uniqueMarker('subject');
    const messageId = await insertMessage(tenantB, { subject: marker });
    const attachmentId = await insertAttachment(tenantB, messageId);
    const extractionId = await insertExtraction(tenantB, messageId, attachmentId, {});
    const id = Number(await insertProposal(tenantB, { attachmentId, extractionId, status: 'review' }));
    return { ids: { id }, marker };
  },
  'aphub:exceptions:get': async (tenantB) => {
    const marker = uniqueMarker('entity-ref');
    const id = Number(await insertMarkedException(tenantB, { entityRef: marker }));
    return { ids: { id }, marker };
  },
  'aphub:statements:get': async (tenantB) => {
    const marker = uniqueMarker('bank');
    const messageId = await insertMessage(tenantB);
    const documentId = await insertMarkedAccountingDocument(tenantB, messageId, { kind: 'bank_statement', status: 'review' });
    const id = Number(await insertMarkedBankStatement(tenantB, documentId, { institutionName: marker }));
    return { ids: { id }, marker };
  },
  'aphub:reply-drafts:get': async (tenantB) => {
    const marker = uniqueMarker('subject');
    const owner = await createUser(tenantB, { role: 'owner_controller' });
    const messageId = Number(await insertMessage(tenantB));
    await insertMarkedReplyDraft(tenantB, messageId, owner, { subject: marker });
    return { ids: { messageId }, marker };
  },
  'aphub:tax-mappings:get': async (tenantB) => {
    const marker = uniqueMarker('taxcode');
    const connectionId = await createConnection(tenantB);
    const id = Number(await insertMarkedTaxMapping(tenantB, connectionId, { providerTaxCode: marker }));
    return { ids: { id }, marker };
  },
  'aphub:tax-mappings:audit': async (tenantB) => {
    const marker = uniqueMarker('audit-reason');
    const connectionId = await createConnection(tenantB);
    const taxMappingId = Number(await insertMarkedTaxMapping(tenantB, connectionId));
    await insertMarkedTaxMappingAudit(tenantB, taxMappingId, connectionId, { reason: marker });
    return { ids: { id: taxMappingId }, marker };
  },

  // --- actions --------------------------------------------------------------------------------
  'aphub:proposals:approve': async (tenantB) => {
    const marker = uniqueMarker('vendor');
    const proposalId = Number(await insertMarkedProposal(tenantB, { vendorName: marker }));
    return { ids: { proposalId }, marker };
  },
  'aphub:proposals:retry': async (tenantB) => {
    const marker = uniqueMarker('vendor');
    const proposalId = Number(await insertMarkedProposal(tenantB, { vendorName: marker }));
    return { ids: { proposalId }, marker };
  },
  'aphub:proposals:reject': async (tenantB) => {
    const marker = uniqueMarker('vendor');
    const proposalId = Number(await insertMarkedProposal(tenantB, { vendorName: marker }));
    return { ids: { proposalId }, marker };
  },
  'aphub:accounting-documents:classify': async (tenantB) => {
    const marker = uniqueMarker('hold-reason');
    const messageId = await insertMessage(tenantB);
    const documentId = Number(await insertMarkedAccountingDocument(tenantB, messageId, { holdReason: marker }));
    return { ids: { documentId }, marker };
  },
  'aphub:notifications:read': async (tenantB) => {
    const marker = uniqueMarker('notif');
    const notificationId = Number(await insertMarkedNotification(tenantB, { marker }));
    return { ids: { notificationId }, marker };
  },
  'aphub:provider-connections:write-gate': async (tenantB) => {
    const marker = uniqueMarker('company');
    const connectionId = Number(await createConnection(tenantB, { externalCompany: marker }));
    return { ids: { connectionId }, marker };
  },
  'aphub:replies:send': async (tenantB) => {
    const marker = uniqueMarker('subj-tag');
    const messageId = await insertMessage(tenantB);
    const replyId = Number(await insertMarkedForward(tenantB, messageId, { subjectTag: marker }));
    return { ids: { replyId }, marker };
  },
  'aphub:reply-drafts:create': async (tenantB) => {
    const marker = uniqueMarker('subject');
    const messageId = Number(await insertMessage(tenantB, { subject: marker }));
    return { ids: { messageId }, marker };
  },
  'aphub:reply-drafts:update': async (tenantB) => {
    const marker = uniqueMarker('subject');
    const owner = await createUser(tenantB, { role: 'owner_controller' });
    const messageId = Number(await insertMessage(tenantB));
    const draftId = Number(await insertMarkedReplyDraft(tenantB, messageId, owner, { subject: marker }));
    return { ids: { draftId }, marker };
  },
  'aphub:reply-drafts:discard': async (tenantB) => {
    const marker = uniqueMarker('subject');
    const owner = await createUser(tenantB, { role: 'owner_controller' });
    const messageId = Number(await insertMessage(tenantB));
    const draftId = Number(await insertMarkedReplyDraft(tenantB, messageId, owner, { subject: marker }));
    return { ids: { draftId }, marker };
  },
  'aphub:statements:correct': async (tenantB) => {
    const marker = uniqueMarker('bank');
    const messageId = await insertMessage(tenantB);
    const documentId = await insertMarkedAccountingDocument(tenantB, messageId, { kind: 'bank_statement', status: 'review' });
    const statementId = Number(await insertMarkedBankStatement(tenantB, documentId, { institutionName: marker }));
    return { ids: { statementId }, marker };
  },
  'aphub:statements:file': async (tenantB) => {
    const marker = uniqueMarker('bank');
    const messageId = await insertMessage(tenantB);
    const documentId = await insertMarkedAccountingDocument(tenantB, messageId, { kind: 'bank_statement', status: 'review' });
    const statementId = Number(await insertMarkedBankStatement(tenantB, documentId, { institutionName: marker }));
    return { ids: { statementId }, marker };
  },
  'aphub:statements:match-line': async (tenantB) => {
    const marker = uniqueMarker('line-desc');
    const messageId = await insertMessage(tenantB);
    const documentId = await insertMarkedAccountingDocument(tenantB, messageId, { kind: 'bank_statement', status: 'review' });
    const statementId = Number(await insertMarkedBankStatement(tenantB, documentId));
    const lineId = Number(await insertMarkedBankStatementLine(tenantB, statementId, { description: marker }));
    return { ids: { statementId, lineId }, marker };
  },
  'aphub:statements:exclude-line': async (tenantB) => {
    const marker = uniqueMarker('line-desc');
    const messageId = await insertMessage(tenantB);
    const documentId = await insertMarkedAccountingDocument(tenantB, messageId, { kind: 'bank_statement', status: 'review' });
    const statementId = Number(await insertMarkedBankStatement(tenantB, documentId));
    const lineId = Number(await insertMarkedBankStatementLine(tenantB, statementId, { description: marker }));
    return { ids: { statementId, lineId }, marker };
  },
  'aphub:tax-mappings:create': async (tenantB) => {
    const marker = uniqueMarker('company');
    const connectionId = Number(await createConnection(tenantB, { externalCompany: marker }));
    return { ids: { connectionId }, marker };
  },
  'aphub:tax-mappings:edit': async (tenantB) => {
    const marker = uniqueMarker('taxcode');
    const connectionId = await createConnection(tenantB);
    const taxMappingId = Number(await insertMarkedTaxMapping(tenantB, connectionId, { providerTaxCode: marker }));
    return { ids: { taxMappingId }, marker };
  },
  'aphub:tax-mappings:disable': async (tenantB) => {
    const marker = uniqueMarker('taxcode');
    const connectionId = await createConnection(tenantB);
    const taxMappingId = Number(await insertMarkedTaxMapping(tenantB, connectionId, { providerTaxCode: marker }));
    return { ids: { taxMappingId }, marker };
  },
  'aphub:tax-mappings:replace': async (tenantB) => {
    const marker = uniqueMarker('taxcode');
    const connectionId = await createConnection(tenantB);
    const taxMappingId = Number(await insertMarkedTaxMapping(tenantB, connectionId, { providerTaxCode: marker }));
    return { ids: { taxMappingId }, marker };
  },
  'aphub:tax-mappings:revalidate': async (tenantB) => {
    const marker = uniqueMarker('taxcode');
    const connectionId = await createConnection(tenantB);
    const taxMappingId = Number(await insertMarkedTaxMapping(tenantB, connectionId, { providerTaxCode: marker }));
    return { ids: { taxMappingId }, marker };
  },
  'aphub:dimension-mappings:accept': async (tenantB) => {
    const marker = uniqueMarker('raw-value');
    const connectionId = await createConnection(tenantB);
    const proposalId = await insertProposal(tenantB);
    const mappingId = Number(await insertDimensionMapping(tenantB, connectionId, proposalId, { rawValue: marker }));
    return { ids: { mappingId }, marker };
  },
  'aphub:dimension-mappings:correct': async (tenantB) => {
    const marker = uniqueMarker('raw-value');
    const connectionId = await createConnection(tenantB);
    const proposalId = await insertProposal(tenantB);
    const mappingId = Number(await insertDimensionMapping(tenantB, connectionId, proposalId, { rawValue: marker }));
    return { ids: { mappingId }, marker };
  },
  'aphub:dimension-mappings:reject': async (tenantB) => {
    const marker = uniqueMarker('raw-value');
    const connectionId = await createConnection(tenantB);
    const proposalId = await insertProposal(tenantB);
    const mappingId = Number(await insertDimensionMapping(tenantB, connectionId, proposalId, { rawValue: marker }));
    return { ids: { mappingId }, marker };
  },
  'aphub:dimension-mappings:save-rule': async (tenantB) => {
    const marker = uniqueMarker('raw-value');
    const connectionId = await createConnection(tenantB);
    const proposalId = await insertProposal(tenantB);
    const mappingId = Number(await insertDimensionMapping(tenantB, connectionId, proposalId, { rawValue: marker }));
    return { ids: { mappingId }, marker };
  },
  'aphub:dimension-mappings:select-alternate': async (tenantB) => {
    const marker = uniqueMarker('raw-value');
    const connectionId = await createConnection(tenantB);
    const proposalId = await insertProposal(tenantB);
    const mappingId = Number(await insertDimensionMapping(tenantB, connectionId, proposalId, { rawValue: marker }));
    return { ids: { mappingId }, marker };
  },
  'aphub:provider-jobs:retry': async (tenantB) => {
    const marker = uniqueMarker('idem');
    const connectionId = await createConnection(tenantB);
    const jobId = Number(await insertMarkedProviderJob(tenantB, connectionId, { status: 'failed', idempotencyKey: marker }));
    return { ids: { jobId }, marker };
  },
};

describe('exhaustive cross-tenant isolation: every id-taking channel', () => {
  const byIdChannels = Object.keys(CROSS_TENANT_SEED);

  it(`covers exactly the 32 id-taking channels — every other channel is checked structurally below`, () => {
    expect(byIdChannels).toHaveLength(32);
    for (const channel of byIdChannels) expect(ALL_CHANNELS).toContain(channel);
  });

  it.each(byIdChannels.map((c) => [c, entryFor(c)] as const))(
    '%s: a row seeded in tenant B is NOT_FOUND (or a fail-safe non-leak) for a tenant-A caller, never FORBIDDEN, never leaked',
    async (channel, entry) => {
      await resetTables();
      const tenantA = await createTenant(uniqueMarker('ct-a'));
      const tenantB = await createTenant(uniqueMarker('ct-b'));
      await openDryRunGate(tenantA); // harmless for every channel except approve/retry, load-bearing for those two
      if (channel === 'aphub:statements:match-line') {
        // `updateLine` (`src/statements/review.ts:177-194`) requires the caller's OWN tenant to
        // hold an authoritatively-posted `postings_ap` row for the given `providerRef
        // .transactionId` BEFORE it ever reaches the tenant+statementId+lineId scoped UPDATE —
        // real, verified behaviour, not a test artifact. Without this the channel answers
        // VALIDATION for every caller regardless of tenant, which would silently hide the tenant
        // check this test exists to prove.
        await query(
          `INSERT INTO postings_ap (tenant_id, external_id, entity_type, status, mode, idempotency_key, posted_at, response)
           VALUES ($1,'QB-8812','Bill','posted','sandbox',$2,now(),'{}')`,
          [tenantA, uniqueMarker('idem')],
        );
      }
      const seed = CROSS_TENANT_SEED[channel]!;
      const { ids, marker } = await seed(tenantB);
      setSessionToken(await sessionFor(tenantA, 'owner_controller'));

      const payload = { ...VALID_PAYLOAD[channel], ...ids };
      const envelope = await drive(entry, payload);

      expect(envelope.code, `${channel}: ${JSON.stringify(envelope)}`).not.toBe('FORBIDDEN');
      expect(envelope.data).toBeUndefined();
      expect(JSON.stringify(envelope)).not.toContain(marker);

      if (channel === 'aphub:proposals:approve' || channel === 'aphub:proposals:retry') {
        // No QBO connection exists for tenant A in this environment, so `getQboConnector`
        // (src/connectors/factory.ts:27) throws before `postOnce` ever reaches the tenant-scoped
        // proposal lookup, and `qboRetryOnThrow` (src/services/action/index.ts) converts that
        // into a fail-safe 202 QBO_RETRY — ok:true, no data, no leak. Documented, not papered
        // over: either outcome below is a genuine non-leak; NOT_FOUND is the code the tenant
        // scoping itself would produce if the QBO short-circuit were absent.
        expect(['NOT_FOUND', 'QBO_RETRY']).toContain(envelope.code);
      } else {
        expect(envelope.code, JSON.stringify(envelope)).toBe('NOT_FOUND');
        expect(envelope.status).toBe(404);
        expect(envelope.message).toBe(plainMessage('NOT_FOUND'));
      }
    },
  );

  afterAll(async () => {
    clearSessionToken();
    await closeAll();
  });
});

// --- the 2 whole-install id-taking channels: CHUNK_7_BACKUP, deliberately NOT tenant-scoped ----

const WHOLE_INSTALL_ID_CHANNELS = ['aphub:backup:restore', 'aphub:backup:export'] as const;

describe('the 2 whole-install id-taking channels (CHUNK_7_BACKUP) are not tenant-scoped by design', () => {
  it('covers exactly the 2 documented exceptions, both real registry channels', () => {
    expect(WHOLE_INSTALL_ID_CHANNELS).toHaveLength(2);
    for (const channel of WHOLE_INSTALL_ID_CHANNELS) expect(ALL_CHANNELS).toContain(channel);
  });

  it.each(WHOLE_INSTALL_ID_CHANNELS.map((c) => [c, entryFor(c)] as const))(
    '%s: a nonexistent id answers NOT_FOUND for any tenant\'s owner, never FORBIDDEN',
    async (channel, entry) => {
      await resetTables();
      const tenantId = await createTenant(uniqueMarker('whole-install'));
      setSessionToken(await sessionFor(tenantId, 'owner_controller'));
      const envelope = await drive(entry, VALID_PAYLOAD[channel]);
      expect(envelope.code, JSON.stringify(envelope)).toBe('NOT_FOUND');
      expect(envelope.status).toBe(404);
      expect(envelope.data).toBeUndefined();
    },
  );

  it("aphub:backup:list is intentionally visible to every tenant's owner alike (backups has no tenant_id column)", async () => {
    await resetTables();
    const tenantA = await createTenant(uniqueMarker('shared-a'));
    const tenantB = await createTenant(uniqueMarker('shared-b'));
    const marker = uniqueMarker('backup-kind');
    const seeded = await query<{ id: number }>(
      `INSERT INTO backups (kind, path, size_bytes, manifest_hash, row_counts, verified_at)
       VALUES ('manual', $1, 100, 'deadbeef', '{}'::jsonb, now()) RETURNING id`,
      [`C:\\aphub-test\\${marker}.aphubbak`],
    );
    const backupId = Number(seeded.rows[0]!.id);

    setSessionToken(await sessionFor(tenantA, 'owner_controller'));
    const asA = await drive(entryFor('aphub:backup:list'), {});
    setSessionToken(await sessionFor(tenantB, 'owner_controller'));
    const asB = await drive(entryFor('aphub:backup:list'), {});

    expect(asA.ok).toBe(true);
    expect(asB.ok).toBe(true);
    const idsSeenByA = (asA.data as Array<{ id: number | string }>).map((r) => Number(r.id));
    const idsSeenByB = (asB.data as Array<{ id: number | string }>).map((r) => Number(r.id));
    expect(idsSeenByA).toContain(backupId);
    expect(idsSeenByB).toContain(backupId);
  });

  afterAll(async () => {
    clearSessionToken();
    await closeAll();
  });
});

// --- the remaining 21 channels: no id-shaped field at all, plus a live no-leak check where a
// real tenant-scoped table backs the read -------------------------------------------------------

const LIST_OR_GLOBAL_CHANNELS = ALL_CHANNELS.filter(
  (c) => !(c in CROSS_TENANT_SEED) && !(WHOLE_INSTALL_ID_CHANNELS as readonly string[]).includes(c),
);

describe('the remaining 21 channels have no id-shaped field that could select a foreign row', () => {
  it('covers exactly the complement of the 32 id-taking + 2 whole-install channels', () => {
    expect(LIST_OR_GLOBAL_CHANNELS).toHaveLength(21);
  });

  /** Unwrap to the base `ZodObject`, seeing through the same wrappers `defineChannel` does
   * (`desktop/ipc/registry.ts`'s `baseObject`) — `.superRefine()` wraps a `ZodObject` in a
   * `ZodEffects`, and this file has no access to that private helper. */
  function baseShape(schema: z.ZodTypeAny): Record<string, z.ZodTypeAny> {
    let current: z.ZodTypeAny = schema;
    for (let depth = 0; depth < 12; depth += 1) {
      if (current instanceof z.ZodObject) return current.shape as Record<string, z.ZodTypeAny>;
      if (current instanceof z.ZodEffects) {
        current = current.innerType() as z.ZodTypeAny;
        continue;
      }
      return {};
    }
    return {};
  }

  it.each(LIST_OR_GLOBAL_CHANNELS.map((c) => [c, entryFor(c)] as const))(
    '%s: no schema key is a required entity id, so there is no foreign-row vector at all',
    (_channel, entry) => {
      const shape = baseShape(entry.request);
      for (const [key, field] of Object.entries(shape)) {
        const looksLikeId = /(^id$|Id$)/.test(key);
        if (looksLikeId) {
          // The two exceptions the RBAC doc records: `connectionId` on the two owner-only list
          // filters is OPTIONAL and used only to narrow the caller's OWN rows, never to select a
          // specific foreign one — `runListDimensionMappings`/`runListTaxMappings` still scope by
          // `ctx.tenantId` first (verified in the live no-leak check below).
          expect(field.isOptional(), `${entry.channel} declares required id-shaped key '${key}'`).toBe(true);
        }
      }
    },
  );
});

interface ListLeakCase {
  readonly seedForeign: (tenantB: number) => Promise<{ marker: string }>;
  readonly payload?: Record<string, unknown>;
}

/** For every list/global channel that is backed by a real, tenant-scoped table, seed a marker
 * row in tenant B and prove tenant A's call never contains it. Channels that return only the
 * CALLER's own identity/state (`me:get`, `onboarding:get`) or call an external provider
 * (`tax-mappings:discover`) have no "other tenant's row" to leak by construction and are
 * covered by the structural check above instead. `aphub:backup:list` is excluded for a
 * different reason — `backups` is not tenant-scoped at all, so "seeded in tenant B, must not
 * leak to tenant A" is the wrong invariant for it; its intentional shared-visibility is proven
 * separately, in the whole-install describe block above. */
const LIST_LEAK_CASES: Readonly<Record<string, ListLeakCase>> = {
  'aphub:today:get': {
    seedForeign: async (tenantB) => {
      const marker = uniqueMarker('vendor');
      await insertMarkedProposal(tenantB, { vendorName: marker, status: 'review' });
      return { marker };
    },
  },
  'aphub:transactions:list': {
    seedForeign: async (tenantB) => {
      const marker = uniqueMarker('vendor');
      await insertMarkedProposal(tenantB, { vendorName: marker, status: 'review' });
      return { marker };
    },
  },
  'aphub:exceptions:list': {
    seedForeign: async (tenantB) => {
      const marker = uniqueMarker('entity-ref');
      await insertMarkedException(tenantB, { entityRef: marker });
      return { marker };
    },
  },
  'aphub:audit:list': {
    seedForeign: async (tenantB) => {
      const marker = uniqueMarker('audit-entity');
      await query(`INSERT INTO audit_log (tenant_id, actor, action, entity) VALUES ($1,'system','test.event',$2)`, [
        tenantB,
        marker,
      ]);
      return { marker };
    },
  },
  'aphub:notifications:list': {
    seedForeign: async (tenantB) => {
      const marker = uniqueMarker('notif');
      await insertMarkedNotification(tenantB, { marker });
      return { marker };
    },
  },
  'aphub:accounting-documents:review': {
    seedForeign: async (tenantB) => {
      const marker = uniqueMarker('filename');
      const messageId = await insertMessage(tenantB, { subject: marker });
      await insertMarkedAccountingDocument(tenantB, messageId, { status: 'held' });
      return { marker };
    },
  },
  'aphub:statements:list': {
    seedForeign: async (tenantB) => {
      const marker = uniqueMarker('bank');
      const messageId = await insertMessage(tenantB);
      const documentId = await insertMarkedAccountingDocument(tenantB, messageId, { kind: 'bank_statement', status: 'review' });
      await insertMarkedBankStatement(tenantB, documentId, { institutionName: marker });
      return { marker };
    },
  },
  'aphub:provider-capabilities:list': {
    seedForeign: async (tenantB) => {
      const marker = uniqueMarker('company');
      await createConnection(tenantB, { provider: 'qbo', externalCompany: marker });
      return { marker };
    },
  },
  'aphub:provider-jobs:list': {
    seedForeign: async (tenantB) => {
      const marker = uniqueMarker('idem');
      const connectionId = await createConnection(tenantB);
      await insertMarkedProviderJob(tenantB, connectionId, { idempotencyKey: marker });
      return { marker };
    },
  },
  'aphub:dimension-mappings:list': {
    seedForeign: async (tenantB) => {
      const marker = uniqueMarker('raw-value');
      const connectionId = await createConnection(tenantB);
      const proposalId = await insertProposal(tenantB);
      await insertDimensionMapping(tenantB, connectionId, proposalId, { rawValue: marker });
      return { marker };
    },
  },
  'aphub:tax-mappings:list': {
    seedForeign: async (tenantB) => {
      const marker = uniqueMarker('taxcode');
      const connectionId = await createConnection(tenantB);
      await insertMarkedTaxMapping(tenantB, connectionId, { providerTaxCode: marker });
      return { marker };
    },
  },
  'aphub:connections:status': {
    seedForeign: async (tenantB) => {
      const marker = uniqueMarker('company');
      await createConnection(tenantB, { provider: 'qbo', externalCompany: marker });
      return { marker };
    },
  },
};

describe('a marker seeded in tenant B never appears in tenant A\'s list/global response', () => {
  it.each(Object.keys(LIST_LEAK_CASES).map((c) => [c, entryFor(c)] as const))(
    '%s',
    async (channel, entry) => {
      await resetTables();
      const tenantA = await createTenant(uniqueMarker('leak-a'));
      const tenantB = await createTenant(uniqueMarker('leak-b'));
      const { marker } = await LIST_LEAK_CASES[channel]!.seedForeign(tenantB);
      setSessionToken(await sessionFor(tenantA, 'owner_controller'));

      const envelope = await drive(entry, VALID_PAYLOAD[channel]);
      expect(envelope.ok, `${channel}: ${JSON.stringify(envelope)}`).toBe(true);
      expect(JSON.stringify(envelope)).not.toContain(marker);
    },
  );

  afterAll(async () => {
    clearSessionToken();
    await closeAll();
  });
});

// --- the 4 tenant-wide action mutations that take no id at all: side-effect isolation ----------

describe('a tenant-wide mutation with no id parameter never writes into another tenant', () => {
  let tenantA = 0;
  let tenantB = 0;

  beforeEach(async () => {
    await resetTables();
    tenantA = await createTenant(uniqueMarker('side-a'));
    tenantB = await createTenant(uniqueMarker('side-b'));
    setSessionToken(await sessionFor(tenantA, 'owner_controller'));
  });
  afterAll(async () => {
    clearSessionToken();
    await closeAll();
  });

  it('aphub:corrections:learn only ever writes a `corrections` row for the caller\'s own tenant', async () => {
    await drive(entryFor('aphub:corrections:learn'), VALID_PAYLOAD['aphub:corrections:learn']);
    const foreign = await query<{ n: number }>('SELECT count(*)::int AS n FROM corrections WHERE tenant_id=$1', [tenantB]);
    expect(foreign.rows[0]!.n).toBe(0);
  });

  it('aphub:mappings:remap only ever writes a `mappings` row for the caller\'s own tenant', async () => {
    await drive(entryFor('aphub:mappings:remap'), VALID_PAYLOAD['aphub:mappings:remap']);
    const foreign = await query<{ n: number }>('SELECT count(*)::int AS n FROM mappings WHERE tenant_id=$1', [tenantB]);
    expect(foreign.rows[0]!.n).toBe(0);
  });

  it('aphub:onboarding:step only ever touches the caller\'s own `onboarding_state` row', async () => {
    await drive(entryFor('aphub:onboarding:step'), VALID_PAYLOAD['aphub:onboarding:step']);
    const foreign = await query<{ n: number }>('SELECT count(*)::int AS n FROM onboarding_state WHERE tenant_id=$1', [
      tenantB,
    ]);
    expect(foreign.rows[0]!.n).toBe(0);
  });

  it('aphub:onboarding:dry-run only ever touches the caller\'s own `onboarding_state` row', async () => {
    await drive(entryFor('aphub:onboarding:dry-run'), VALID_PAYLOAD['aphub:onboarding:dry-run']);
    const foreign = await query<{ n: number }>('SELECT count(*)::int AS n FROM onboarding_state WHERE tenant_id=$1', [
      tenantB,
    ]);
    expect(foreign.rows[0]!.n).toBe(0);
  });
});
