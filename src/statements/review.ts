import { scopedQuery } from '../db/scoped.js';
import {
  assertEntityId,
  ensurePermission,
  ServiceError,
  withAudit,
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
  const { rows } = await scopedQuery<LineRow>(
    ctx.tenantId,
    `UPDATE bank_statement_lines
        SET match_status=$4, matched_provider_ref=$5, review_reason=$6
      WHERE tenant_id=$1 AND statement_id=$2 AND id=$3
      RETURNING *`,
    [statementId, lineId, status, providerRef, normalizedReason],
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
  await withAudit(
    ctx,
    'statement.line_matched',
    `statement_line:${lineId}`,
    () => updateLine(ctx, statementId, lineId, 'matched', input.providerRef, input.reason),
    (row) => ({ statementId, lineId, reason: row.review_reason, providerRef: row.matched_provider_ref }),
  );
}

export async function excludeStatementLine(
  ctx: ActorContext,
  statementId: number,
  lineId: number,
  reason: string,
): Promise<void> {
  await withAudit(
    ctx,
    'statement.line_excluded',
    `statement_line:${lineId}`,
    () => updateLine(ctx, statementId, lineId, 'excluded', null, reason),
    (row) => ({ statementId, lineId, reason: row.review_reason }),
  );
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
  await withAudit(
    ctx,
    'statement.fact_corrected',
    `bank_statement:${statementId}`,
    async () => {
      const before = await getStatement(ctx.tenantId, statementId);
      if (!before) throw new ServiceError('statement_not_found');
      const oldValue = before[input.field as keyof StatementDetail];
      const { rows } = await scopedQuery<{ id: number }>(
        ctx.tenantId,
        `UPDATE bank_statements SET ${column}=$3, updated_at=now()
          WHERE tenant_id=$1 AND id=$2 RETURNING id`,
        [statementId, input.value],
      );
      if (!rows[0]) throw new ServiceError('statement_not_found');
      return { oldValue: oldValue ?? null };
    },
    (result) => ({ field: input.field, oldValue: result.oldValue, newValue: input.value, reason }),
  );
}

export async function fileStatement(ctx: ActorContext, statementId: number): Promise<void> {
  ensurePermission(ctx, 'remap');
  assertEntityId(statementId);
  await withAudit(
    ctx,
    'statement.filed',
    `bank_statement:${statementId}`,
    async () => {
      const detail = await getStatement(ctx.tenantId, statementId);
      if (!detail) throw new ServiceError('statement_not_found');
      if (['unbalanced', 'held'].includes(detail.status)) {
        throw new ServiceError('VALIDATION', 'held or unbalanced statements cannot be filed');
      }
      if (detail.lineCount === 0 || detail.unresolvedCount > 0) {
        throw new ServiceError('VALIDATION', 'every line must be matched or excluded before filing');
      }
      await scopedQuery(
        ctx.tenantId,
        `UPDATE bank_statements
            SET status='filed', filed_at=now(), updated_at=now()
          WHERE tenant_id=$1 AND id=$2`,
        [statementId],
      );
      await scopedQuery(
        ctx.tenantId,
        `UPDATE accounting_documents
            SET status='filed', updated_at=now()
          WHERE tenant_id=$1 AND id=$2`,
        [detail.documentId],
      );
      return detail;
    },
    (detail) => ({ documentId: detail.documentId, lineCount: detail.lineCount }),
  );
}
