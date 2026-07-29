import { z } from 'zod';
import { getTransactionById, listTransactions, runRead } from '../../../src/services/read/index.js';
import { defineChannel, entityId, passthrough, persistedId, strict, type RegistryEntry } from '../registry.js';

/**
 * B3 — GET /api/transactions (list, filterable by `status`) and GET /api/transactions/:id.
 * Any authenticated role. Both routes inline `runRead` with no separate exported wrapper.
 *
 * `proposalId`/`postingId` are `persistedId`: `TransactionRow` types them `number`, but
 * `getTransactionById`/`listTransactions` project them straight off `bigserial` columns
 * (`p.id`, `po.id`), which pg returns as strings.
 */

const UX_STATUSES = ['prepared', 'held', 'posted', 'reconciled', 'rejected', 'exception'] as const;

const transactionRow = passthrough({
  proposalId: persistedId,
  status: z.enum(UX_STATUSES),
  rawStatus: z.string(),
  confidence: z.number(),
  vendor: z.string().nullable(),
  total: z.string().nullable(),
  docNumber: z.string().nullable(),
  txnDate: z.string().nullable(),
  postingId: persistedId.nullable(),
  qboType: z.string().nullable(),
  qboId: z.string().nullable(),
  qboLink: z.string().nullable(),
  reconciled: z.boolean(),
  createdAt: z.string(),
});

export const transactionsEntries: readonly RegistryEntry[] = [
  defineChannel({
    channel: 'aphub:transactions:list',
    role: 'any',
    method: 'GET',
    pathTemplate: '/api/transactions',
    queryParams: ['status'],
    request: strict({ status: z.enum(UX_STATUSES).optional() }),
    response: z.array(transactionRow),
    validationMessage: 'BookScout OS could not load your transactions.',
    invoke: (request, payload) =>
      runRead(request, (ctx) =>
        listTransactions(ctx.tenantId, { status: payload.status as (typeof UX_STATUSES)[number] | undefined }),
      ),
  }),
  defineChannel({
    channel: 'aphub:transactions:get',
    role: 'any',
    method: 'GET',
    pathTemplate: '/api/transactions/:id',
    request: strict({ id: entityId }),
    response: transactionRow,
    validationMessage: 'BookScout OS could not find that transaction.',
    invoke: (request, payload) => runRead(request, (ctx) => getTransactionById(ctx.tenantId, payload.id as number)),
  }),
];
