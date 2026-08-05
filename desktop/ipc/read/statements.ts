import { z } from 'zod';
import { getStatement, listStatements } from '../../../src/statements/review.js';
import { runRead } from '../../../src/services/read/http.js';
import { defineChannel, entityId, filterText, passthrough, strict, type RegistryEntry } from '../registry.js';

/**
 * B3 — GET /api/statements (list, filterable by `status`) and GET /api/statements/:id.
 * Owner, bookkeeper, cpa — matches the `role` array both route files pass to `runRead`
 * verbatim. Neither route exports a separate wrapper, so this invoke replicates the one-liner.
 *
 * Every id here is a plain `z.number()`: `listStatements`/`getStatement` explicitly
 * `Number(row.id)`-cast every id-shaped field, so they are real numbers on the wire.
 */

const STATEMENT_ROLE = ['owner_controller', 'bookkeeper', 'cpa'] as const;

const statementListItem = passthrough({
  id: z.number(),
  institutionName: z.string().nullable(),
  accountHint: z.string().nullable(),
  periodStart: z.string().nullable(),
  periodEnd: z.string().nullable(),
  status: z.string(),
  filedAt: z.string().nullable(),
  lineCount: z.number(),
  unresolvedCount: z.number(),
});

const statementLine = passthrough({
  id: z.number(),
  lineNo: z.number(),
  postedOn: z.string().nullable(),
  description: z.string(),
  amount: z.string(),
  balance: z.string().nullable(),
  matchStatus: z.string(),
  matchedProviderRef: z.record(z.unknown()).nullable(),
  reviewReason: z.string().nullable(),
});

export const statementsEntries: readonly RegistryEntry[] = [
  defineChannel({
    channel: 'aphub:statements:list',
    role: STATEMENT_ROLE,
    method: 'GET',
    pathTemplate: '/api/statements',
    queryParams: ['status'],
    request: strict({ status: filterText.optional() }),
    response: z.array(statementListItem),
    validationMessage: 'BookScout OS could not load your bank statements.',
    invoke: (request, payload) =>
      runRead(request, (ctx) => listStatements(ctx.tenantId, payload.status as string | undefined), {
        role: STATEMENT_ROLE,
      }),
  }),
  defineChannel({
    channel: 'aphub:statements:get',
    role: STATEMENT_ROLE,
    method: 'GET',
    pathTemplate: '/api/statements/:id',
    request: strict({ id: entityId }),
    response: passthrough({
      id: z.number(),
      documentId: z.number(),
      institutionName: z.string().nullable(),
      accountHint: z.string().nullable(),
      currency: z.string().nullable(),
      periodStart: z.string().nullable(),
      periodEnd: z.string().nullable(),
      openingBalance: z.string().nullable(),
      closingBalance: z.string().nullable(),
      status: z.string(),
      filedAt: z.string().nullable(),
      validationDetail: z.record(z.unknown()),
      lineCount: z.number(),
      unresolvedCount: z.number(),
      lines: z.array(statementLine),
    }),
    validationMessage: 'BookScout OS could not find that bank statement.',
    invoke: (request, payload) =>
      runRead(request, (ctx) => getStatement(ctx.tenantId, payload.id as number), { role: STATEMENT_ROLE }),
  }),
];
