/**
 * CHUNK_3_IPC — the production-write owner gate (guarantee 3).
 *
 * Replaces `app/api/provider-connections/[id]/write-gate/route.ts`.
 *
 * Role: `runSetOwnerWriteGate` uses no shared wrapper. It calls
 * `readContext(request, 'owner_controller')` inline (`src/accounting/write-gates-http.ts:9`) and
 * then `request.json()` unconditionally.
 *
 * ── ALL FOUR FIELDS ARE REQUIRED ────────────────────────────────────────────────────────────
 * `write-gates-http.ts:11-15` returns 400 unless `enabled` is a boolean, `confirmedCompanyId` is
 * a string, `backupConfirmed` is a boolean and `confirmation` is a string. All four keys are
 * therefore REQUIRED in this schema — a partial body is refused before the service is reached.
 *
 * The two strings are `permissiveText`, NOT `shortText`, and that difference is load-bearing.
 * `setOwnerWriteGate` only demands non-empty values when `enabled` is true
 * (`src/accounting/write-gates.ts:13-19`); the DISABLE path legitimately sends
 * `{ enabled: false, confirmedCompanyId: '', backupConfirmed: false, confirmation: '' }`. A
 * `min(1)` here would make turning writes OFF impossible — a schema that fails safe in the
 * dangerous direction and fails CLOSED in the safe one.
 *
 * `confirmation` is not narrowed to the literal `'ENABLE WRITES'` either: the service compares it
 * itself and produces the plain-language failure, and the exact phrase is a product string that
 * must not be duplicated into the transport.
 * ────────────────────────────────────────────────────────────────────────────────────────────
 */

import { z } from 'zod';

import { runSetOwnerWriteGate } from '../../../src/accounting/write-gates-http.js';
import { defineChannel, entityId, passthrough, strict, type RegistryEntry } from '../registry.js';
import { permissiveText } from './fields.js';

export const writeGateEntries: readonly RegistryEntry[] = [
  defineChannel({
    channel: 'aphub:provider-connections:write-gate',
    role: ['owner_controller'],
    method: 'POST',
    pathTemplate: '/api/provider-connections/:connectionId/write-gate',
    bodyKeys: ['enabled', 'confirmedCompanyId', 'backupConfirmed', 'confirmation'],
    request: strict({
      connectionId: entityId,
      enabled: z.boolean(),
      confirmedCompanyId: permissiveText(255),
      backupConfirmed: z.boolean(),
      confirmation: permissiveText(64),
    }),
    response: passthrough({ enabled: z.boolean() }),
    validationMessage:
      'AP-Hub needs the exact company name, a confirmed backup, and the typed confirmation before it can change this. Complete all of them and try again.',
    invoke: (request, payload) => runSetOwnerWriteGate(request, payload.connectionId as number),
  }),
];
