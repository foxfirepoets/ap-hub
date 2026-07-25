import { scopedQuery } from '../db/scoped.js';
import { withTransaction } from '../db/pool.js';
import { writeAudit } from '../audit.js';
import { parseMoneyToCents, type StatementValidation } from './ingest.js';
import {
  actorLabel,
  assertEntityId,
  ensurePermission,
  ServiceError,
  type ActorContext,
} from '../services/index.js';

type StatementStatus = 'extracted' | 'unbalanced' | 'review' | 'ready' | 'filed' | 'held';

interface StatementRow {
  id: number;
  document_id: number;
  institution_name: string | null;
  account_hint: string | null;
  currency: string | null;
  period_start: string | null;
  period_end: string | null;
  opening_balance: string | null;
  closing_balance: string | null;
  status: StatementStatus;
  validation_detail: Record<string, unknown>;
  filed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface LineRow {
  id: number;
  statement_id: number;
  line_no: number;
  posted_on: string | null;
  description: string;
  amount: string;
  balance: string | null;
  match_status: 'unmatched' | 'suggested' | 'matched' | 'excluded';
  matched_provider_ref: Record<string, unknown> | null;
  review_reason: string | null;
}

export interface StatementListItem {
  id: number;
  institutionName: string | null;
  accountHint: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  status: StatementStatus;
  filedAt: Date | null;
  lineCount: number;
  unresolvedCount: number;
}

export interface StatementDetail extends Omit<StatementListItem, 'lineCount' | 'unresolvedCount'> {
  documentId: number;
  lineCount: number;
  unresolvedCount: number;
  currency: string | null;
  openingBalance: string | null;
  closingBalance: string | null;
  validationDetail: Record<string, unknown>;
  lines: Array<{
    id: number;
    lineNo: number;
    postedOn: string | null;
    description: string;
    amount: string;
    balance: string | null;
    matchStatus: LineRow['match_status'];
    matchedProviderRef: Record<string, unknown> | null;
    reviewReason: string | null;
  }>;
}

export async function listStatements(tenantId: number, status?: string): Promise<StatementListItem[]> {
  const allowed = ['extracted', 'unbalanced', 'review', 'ready', 'filed', 'held'];
  if (status !== undefined && !allowed.includes(status)) {
    throw new ServiceError('VALIDATION', 'invalid statement status');
  }
  const params: unknown[] = status === undefined ? [] : [status];
  const filter = status === undefined ? '' : 'AND s.status=$2';
  const { rows } = await scopedQuery<StatementRow & { line_count: string; unresolved_count: string }>(
    tenantId,
    `SELECT s.*,
            count(l.id)::text AS line_count,
            count(l.id) FILTER (WHERE l.match_status NOT IN ('matched','excluded'))::text
              AS unresolved_count
       FROM bank_statements s
       LEFT JOIN bank_statement_lines l
         ON l.tenant_id=s.tenant_id AND l.statement_id=s.id
      WHERE s.tenant_id=$1 ${filter}
      GROUP BY s.id
      ORDER BY s.period_end DESC NULLS LAST, s.created_at DESC`,
    params,
  );
  return rows.map((row) => ({
    id: Number(row.id),
    institutionName: row.institution_name,
    accountHint: row.account_hint,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    status: row.status,
    filedAt: row.filed_at,
    lineCount: Number(row.line_count),
    unresolvedCount: Number(row.unresolved_count),
  }));
}

export async function getStatement(tenantId: number, statementId: number): Promise<StatementDetail | null> {
  assertEntityId(statementId);
  const { rows } = await scopedQuery<StatementRow>(
    tenantId,
    'SELECT * FROM bank_statements WHERE tenant_id=$1 AND id=$2',
    [statementId],
  );
  const statement = rows[0];
  if (!statement) return null;
  const lineResult = await scopedQuery<LineRow>(
    tenantId,
    `SELECT * FROM bank_statement_lines
      WHERE tenant_id=$1 AND statement_id=$2 ORDER BY line_no`,
    [statementId],
  );
  const lines = lineResult.rows.map((line) => ({
    id: Number(line.id),
    lineNo: line.line_no,
    postedOn: line.posted_on,
    description: line.description,
    amount: line.amount,
    balance: line.balance,
    matchStatus: line.match_status,
    matchedProviderRef: line.matched_provider_ref,
    reviewReason: line.review_reason,
  }));
  return {
    id: Number(statement.id),
    documentId: Number(statement.document_id),
    institutionName: statement.institution_name,
    accountHint: statement.account_hint,
    currency: statement.currency,
    periodStart: statement.period_start,
    periodEnd: statement.period_end,
    openingBalance: statement.opening_balance,
    closingBalance: statement.closing_balance,
    status: statement.status,
    filedAt: statement.filed_at,
    validationDetail: statement.validation_detail,
    lineCount: lines.length,
    unresolvedCount: lines.filter((line) => !['matched', 'excluded'].includes(line.matchStatus)).length,
    lines,
  };
}

function requireReason(reason: string): string {
  const normalized = reason.trim();
  if (!normalized) throw new ServiceError('VALIDATION', 'reason is required');
  if (normalized.length > 1000) throw new ServiceError('VALIDATION', 'reason is too long');
  return normalized;
}

async function updateLine(
  client: import('pg').PoolClient,
  ctx: ActorContext,
  statementId: number,
  lineId: number,
  status: 'matched' | 'excluded',
  providerRef: Record<string, unknown> | null,
  reason: string,
): Promise<LineRow> {
  ensurePermission(ctx, 'remap');
  assertEntityId(statementId);
  assertEntityId(lineId);
  const normalizedReason = requireReason(reason);
  if (status === 'matched' && (!providerRef || Object.keys(providerRef).length === 0)) {
    throw new ServiceError('VALIDATION', 'providerRef is required');
  }
  if (status === 'matched') {
    const externalId = String(providerRef?.transactionId ?? providerRef?.id ?? '').trim();
    if (!externalId) throw new ServiceError('VALIDATION', 'provider transaction id is required');
    const authoritative = (await client.query<{
      external_id: string; entity_type: string; realm: string; mode: string;
      response: Record<string, unknown>;
    }>(
      `SELECT external_id,entity_type,realm,mode,response FROM postings_ap
        WHERE tenant_id=$1 AND external_id=$2
          AND status IN ('posted','posted_sandbox')
        ORDER BY posted_at DESC,id DESC LIMIT 1`,
      [ctx.tenantId, externalId],
    )).rows[0];
    if (!authoritative) {
      throw new ServiceError('VALIDATION', 'provider transaction was not authoritatively verified');
    }
    providerRef = {
      provider: providerRef?.provider ?? 'accounting',
      transactionId: authoritative.external_id,
      entityType: authoritative.entity_type,
      realm: authoritative.realm,
      mode: authoritative.mode,
      evidence: {
        source: 'provider_readback',
        responseHash: (await import('../audit.js')).hashOf(authoritative.response),
      },
    };
  }
  const { rows } = await client.query<LineRow>(
    `UPDATE bank_statement_lines
        SET match_status=$4, matched_provider_ref=$5, review_reason=$6
      WHERE tenant_id=$1 AND statement_id=$2 AND id=$3
      RETURNING *`,
    [ctx.tenantId, statementId, lineId, status, providerRef, normalizedReason],
  );
  const row = rows[0];
  if (!row) throw new ServiceError('statement_line_not_found');
  return row;
}

export async function matchStatementLine(
  ctx: ActorContext,
  statementId: number,
  lineId: number,
  input: { providerRef: Record<string, unknown>; reason: string },
): Promise<void> {
  await withTransaction(async (client) => {
    const row = await updateLine(client, ctx, statementId, lineId, 'matched', input.providerRef, input.reason);
    await writeAudit({
      tenantId: ctx.tenantId, actor: actorLabel(ctx), action: 'statement.line_matched',
      entity: `statement_line:${lineId}`,
      detail: { role: ctx.role, statementId, lineId, reason: row.review_reason, providerRef: row.matched_provider_ref },
    }, client);
  });
}

export async function excludeStatementLine(
  ctx: ActorContext,
  statementId: number,
  lineId: number,
  reason: string,
): Promise<void> {
  await withTransaction(async (client) => {
    const row = await updateLine(client, ctx, statementId, lineId, 'excluded', null, reason);
    await writeAudit({
      tenantId: ctx.tenantId, actor: actorLabel(ctx), action: 'statement.line_excluded',
      entity: `statement_line:${lineId}`,
      detail: { role: ctx.role, statementId, lineId, reason: row.review_reason },
    }, client);
  });
}

const CORRECTABLE_FIELDS = {
  institutionName: 'institution_name',
  accountHint: 'account_hint',
  currency: 'currency',
  periodStart: 'period_start',
  periodEnd: 'period_end',
  openingBalance: 'opening_balance',
  closingBalance: 'closing_balance',
} as const;

async function revalidateStatement(
  client: import('pg').PoolClient,
  tenantId: number,
  statementId: number,
): Promise<{ valid: boolean; validation: StatementValidation; documentId: number }> {
  const statement = (await client.query<{
    document_id: number; period_start: string | null; period_end: string | null;
    opening_balance: string | null; closing_balance: string | null;
    extracted_fields: Record<string, unknown>;
  }>(
    `SELECT document_id,period_start,period_end,opening_balance,closing_balance,extracted_fields
       FROM bank_statements WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
    [tenantId, statementId],
  )).rows[0];
  if (!statement) throw new ServiceError('statement_not_found');
  const lineRows = (await client.query<{ amount: string; balance: string | null }>(
    `SELECT amount,balance FROM bank_statement_lines
      WHERE tenant_id=$1 AND statement_id=$2 ORDER BY line_no FOR SHARE`,
    [tenantId, statementId],
  )).rows;
  if (!statement.period_start || !statement.period_end || statement.period_end < statement.period_start) {
    throw new ServiceError('VALIDATION', 'statement period is invalid');
  }
  if (statement.opening_balance == null || statement.closing_balance == null) {
    throw new ServiceError('VALIDATION', 'statement balances are required');
  }
  const openingCents = parseMoneyToCents(statement.opening_balance);
  const closingCents = parseMoneyToCents(statement.closing_balance);
  const activityCents = lineRows.reduce((sum, line) => sum + parseMoneyToCents(line.amount), 0);
  const expectedClosingCents = openingCents + activityCents;
  const decimal = (cents: number) => `${cents < 0 ? '-' : ''}${Math.floor(Math.abs(cents) / 100)}.${String(Math.abs(cents) % 100).padStart(2, '0')}`;
  const valid = expectedClosingCents === closingCents;
  const validation: StatementValidation = {
    valid,
    code: valid ? 'BALANCED' : 'STATEMENT_UNBALANCED',
    equation: `${decimal(openingCents)} + ${decimal(activityCents)} = ${decimal(expectedClosingCents)}; reported ${decimal(closingCents)}`,
    openingCents,
    activityCents,
    closingCents,
    expectedClosingCents,
    missingRunningBalances: lineRows.filter((line) => line.balance == null).length,
    pageCount: Math.max(1, Number(statement.extracted_fields?.pageCount ?? 1)),
  };
  await client.query(
    `UPDATE bank_statements SET status=$3,validation_detail=$4,updated_at=now()
      WHERE tenant_id=$1 AND id=$2`,
    [tenantId, statementId, valid ? 'review' : 'unbalanced', validation],
  );
  await client.query(
    `UPDATE accounting_documents SET status=$3,hold_reason=$4,updated_at=now()
      WHERE tenant_id=$1 AND id=$2`,
    [tenantId, statement.document_id, valid ? 'review' : 'held', valid ? null : 'STATEMENT_UNBALANCED'],
  );
  return { valid, validation, documentId: Number(statement.document_id) };
}

export async function correctStatementFact(
  ctx: ActorContext,
  statementId: number,
  input: { field: string; value: string | null; reason: string },
): Promise<void> {
  ensurePermission(ctx, 'learn');
  assertEntityId(statementId);
  const column = CORRECTABLE_FIELDS[input.field as keyof typeof CORRECTABLE_FIELDS];
  if (!column) throw new ServiceError('VALIDATION', 'field is not correctable');
  const reason = requireReason(input.reason);
  if (input.value !== null && typeof input.value !== 'string') {
    throw new ServiceError('VALIDATION', 'value must be a string or null');
  }
  await withTransaction(async (client) => {
      const before = await client.query<Record<string, unknown>>(
        'SELECT * FROM bank_statements WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
        [ctx.tenantId, statementId],
      );
      if (!before.rows[0]) throw new ServiceError('statement_not_found');
      const oldValue = before.rows[0][column];
      const { rows } = await client.query<{ id: number }>(
        `UPDATE bank_statements SET ${column}=$3, updated_at=now()
          WHERE tenant_id=$1 AND id=$2 RETURNING id`,
        [ctx.tenantId, statementId, input.value],
      );
      if (!rows[0]) throw new ServiceError('statement_not_found');
      const result = await revalidateStatement(client, ctx.tenantId, statementId);
      await writeAudit({
        tenantId: ctx.tenantId,
        actor: actorLabel(ctx),
        action: 'statement.fact_corrected',
        entity: `bank_statement:${statementId}`,
        detail: { role: ctx.role, field: input.field, oldValue: oldValue ?? null, newValue: input.value, reason,
          validation: result.validation },
      }, client);
  });
}

export async function fileStatement(ctx: ActorContext, statementId: number): Promise<void> {
  ensurePermission(ctx, 'remap');
  assertEntityId(statementId);
  await withTransaction(async (client) => {
      const validation = await revalidateStatement(client, ctx.tenantId, statementId);
      if (!validation.valid) {
        throw new ServiceError('VALIDATION', 'held or unbalanced statements cannot be filed');
      }
      const counts = (await client.query<{ line_count: string; unresolved_count: string }>(
        `SELECT count(*)::text line_count,
          count(*) FILTER (WHERE match_status NOT IN ('matched','excluded'))::text unresolved_count
          FROM bank_statement_lines WHERE tenant_id=$1 AND statement_id=$2`,
        [ctx.tenantId, statementId],
      )).rows[0]!;
      if (Number(counts.line_count) === 0 || Number(counts.unresolved_count) > 0) {
        throw new ServiceError('VALIDATION', 'every line must be matched or excluded before filing');
      }
      await client.query(
        `UPDATE bank_statements
            SET status='filed', filed_at=now(), updated_at=now()
          WHERE tenant_id=$1 AND id=$2`,
        [ctx.tenantId, statementId],
      );
      await client.query(
        `UPDATE accounting_documents
            SET status='filed', updated_at=now()
          WHERE tenant_id=$1 AND id=$2`,
        [ctx.tenantId, validation.documentId],
      );
      await writeAudit({
        tenantId: ctx.tenantId, actor: actorLabel(ctx), action: 'statement.filed',
        entity: `bank_statement:${statementId}`,
        detail: { role: ctx.role, documentId: validation.documentId, lineCount: Number(counts.line_count) },
      }, client);
  });
}
