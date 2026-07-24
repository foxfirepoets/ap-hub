import { createHash } from 'node:crypto';
import type pg from 'pg';
import { withTransaction } from '../db/pool.js';
import type {
  AccountingDocumentKind,
  BankStatementStatus,
} from '../accounting/contracts.js';

export interface RawStatementLine {
  postedOn: string;
  description: string;
  amount: string;
  balance?: string | null;
}

export interface RawBankStatement {
  institutionName?: string | null;
  accountHint?: string | null;
  currency?: string | null;
  periodStart: string;
  periodEnd: string;
  openingBalance: string;
  closingBalance: string;
  lines: RawStatementLine[];
  pageCount?: number;
}

export interface StatementSource {
  tenantId: number;
  messageId: number;
  attachmentId: number;
  sha256: string;
}

export type StatementImportResult =
  | {
      outcome: 'created';
      documentId: number;
      statementId: number;
      status: BankStatementStatus;
      validation: StatementValidation;
    }
  | {
      outcome: 'duplicate';
      documentId: number;
      statementId: number | null;
      status: BankStatementStatus | 'received';
    };

export interface StatementValidation {
  valid: boolean;
  code: 'BALANCED' | 'STATEMENT_UNBALANCED';
  equation: string;
  openingCents: number;
  activityCents: number;
  closingCents: number;
  expectedClosingCents: number;
  missingRunningBalances: number;
  pageCount: number;
}

export class StatementInputError extends Error {
  constructor(
    readonly code:
      | 'DOCUMENT_UNREADABLE'
      | 'DUPLICATE_LINE'
      | 'INVALID_PERIOD'
      | 'INVALID_LINE_DATE'
      | 'INVALID_MONEY',
    message: string,
  ) {
    super(message);
    this.name = 'StatementInputError';
  }
}

export interface AttachmentRouteInput {
  subject: string;
  filename: string;
  mime: string;
}

export interface AttachmentRoute {
  kind: AccountingDocumentKind;
  confidence: string;
  status: 'received' | 'held';
  holdReason: string | null;
}

/**
 * Fail-closed accounting attachment routing. A generic PDF is not silently
 * treated as an invoice because doing so can send statement data into posting.
 */
export function classifyAccountingAttachment(input: AttachmentRouteInput): AttachmentRoute {
  const text = `${input.subject} ${input.filename}`;
  if (/\b(bank|credit\s*card|account)?\s*statement\b/i.test(text)) {
    return { kind: 'bank_statement', confidence: '0.9900', status: 'received', holdReason: null };
  }
  if (/\b(invoice|bill|receipt|credit\s*memo)\b/i.test(text)) {
    return { kind: 'invoice', confidence: '0.9900', status: 'received', holdReason: null };
  }
  return {
    kind: 'unknown',
    confidence: '0.0000',
    status: 'held',
    holdReason: `UNCLASSIFIED_ATTACHMENT:${input.mime || 'unknown-mime'}`,
  };
}

export function parseMoneyToCents(value: string): number {
  const trimmed = value.trim();
  const negativeParentheses = /^\(.*\)$/.test(trimmed);
  const unwrapped = negativeParentheses ? trimmed.slice(1, -1) : trimmed;
  const normalized = unwrapped.replace(/[$,\s]/g, '');
  if (!/^[+-]?\d+(?:\.\d{1,2})?$/.test(normalized)) {
    throw new StatementInputError('INVALID_MONEY', `Invalid monetary value: ${value}`);
  }
  const sign = negativeParentheses ? -1 : normalized.startsWith('-') ? -1 : 1;
  const unsigned = normalized.replace(/^[+-]/, '');
  const [whole = '0', fraction = ''] = unsigned.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents)) {
    throw new StatementInputError('INVALID_MONEY', `Monetary value is out of range: ${value}`);
  }
  return sign * cents;
}

function centsToDecimal(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const absolute = Math.abs(cents);
  return `${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, '0')}`;
}

function assertIsoDate(value: string, code: 'INVALID_PERIOD' | 'INVALID_LINE_DATE'): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new StatementInputError(code, `Invalid ISO date: ${value}`);
  }
}

function fingerprint(sourceSha: string, line: {
  postedOn: string;
  description: string;
  amountCents: number;
  balanceCents: number | null;
}): string {
  return createHash('sha256')
    .update([
      sourceSha,
      line.postedOn,
      line.description.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US'),
      String(line.amountCents),
      line.balanceCents == null ? '' : String(line.balanceCents),
    ].join('\u001f'))
    .digest('hex');
}

function normalize(raw: RawBankStatement, sourceSha: string) {
  assertIsoDate(raw.periodStart, 'INVALID_PERIOD');
  assertIsoDate(raw.periodEnd, 'INVALID_PERIOD');
  if (raw.periodEnd < raw.periodStart) {
    throw new StatementInputError('INVALID_PERIOD', 'Statement period end precedes period start');
  }
  if (!Array.isArray(raw.lines) || raw.lines.length === 0) {
    throw new StatementInputError('DOCUMENT_UNREADABLE', 'Statement contains no readable transaction lines');
  }

  const lines = raw.lines.map((line, index) => {
    assertIsoDate(line.postedOn, 'INVALID_LINE_DATE');
    if (line.postedOn < raw.periodStart || line.postedOn > raw.periodEnd) {
      throw new StatementInputError(
        'INVALID_LINE_DATE',
        `Line ${index + 1} date ${line.postedOn} falls outside the statement period`,
      );
    }
    if (!line.description.trim()) {
      throw new StatementInputError('DOCUMENT_UNREADABLE', `Line ${index + 1} has no description`);
    }
    const normalizedLine = {
      lineNo: index + 1,
      postedOn: line.postedOn,
      description: line.description.trim().replace(/\s+/g, ' '),
      amountCents: parseMoneyToCents(line.amount),
      balanceCents: line.balance == null ? null : parseMoneyToCents(line.balance),
    };
    return { ...normalizedLine, fingerprint: fingerprint(sourceSha, normalizedLine) };
  });

  const seen = new Set<string>();
  for (const line of lines) {
    if (seen.has(line.fingerprint)) {
      throw new StatementInputError('DUPLICATE_LINE', `Duplicate statement line at line ${line.lineNo}`);
    }
    seen.add(line.fingerprint);
  }

  const openingCents = parseMoneyToCents(raw.openingBalance);
  const closingCents = parseMoneyToCents(raw.closingBalance);
  const activityCents = lines.reduce((total, line) => total + line.amountCents, 0);
  const expectedClosingCents = openingCents + activityCents;
  const valid = expectedClosingCents === closingCents;
  const validation: StatementValidation = {
    valid,
    code: valid ? 'BALANCED' : 'STATEMENT_UNBALANCED',
    equation: `${centsToDecimal(openingCents)} + ${centsToDecimal(activityCents)} = ${centsToDecimal(expectedClosingCents)}; reported ${centsToDecimal(closingCents)}`,
    openingCents,
    activityCents,
    closingCents,
    expectedClosingCents,
    missingRunningBalances: lines.filter((line) => line.balanceCents == null).length,
    pageCount: Math.max(1, Math.trunc(raw.pageCount ?? 1)),
  };
  return { lines, openingCents, closingCents, validation };
}

/**
 * Persists the source document, statement header, and every ordered line in one
 * database transaction. Validation is deterministic and happens before writes.
 */
export async function importBankStatement(
  source: StatementSource,
  raw: RawBankStatement,
): Promise<StatementImportResult> {
  const normalized = normalize(raw, source.sha256);
  return withTransaction(async (client) => {
    const existing = await client.query<{
      document_id: number;
      statement_id: number | null;
      status: BankStatementStatus | null;
    }>(
      `SELECT d.id AS document_id, s.id AS statement_id, s.status
       FROM accounting_documents d
       LEFT JOIN bank_statements s
         ON s.tenant_id=d.tenant_id AND s.document_id=d.id
       WHERE d.tenant_id=$1 AND d.sha256=$2 AND d.kind='bank_statement'
       FOR UPDATE OF d`,
      [source.tenantId, source.sha256],
    );
    if (existing.rows[0]?.statement_id != null) {
      const row = existing.rows[0];
      return {
        outcome: 'duplicate',
        documentId: Number(row.document_id),
        statementId: row.statement_id == null ? null : Number(row.statement_id),
        status: row.status ?? 'received',
      };
    }

    const documentId = existing.rows[0]
      ? Number(existing.rows[0].document_id)
      : Number((await client.query<{ id: number }>(
        `INSERT INTO accounting_documents
         (tenant_id,message_id,attachment_id,kind,sha256,status,classification_confidence)
       VALUES ($1,$2,$3,'bank_statement',$4,'extracted',1) RETURNING id`,
        [source.tenantId, source.messageId, source.attachmentId, source.sha256],
      )).rows[0]!.id);
    if (existing.rows[0]) {
      await client.query(
        `UPDATE accounting_documents
         SET status='extracted', hold_reason=NULL, classification_confidence=1, updated_at=now()
         WHERE tenant_id=$1 AND id=$2`,
        [source.tenantId, documentId],
      );
    }
    const status: BankStatementStatus = normalized.validation.valid ? 'review' : 'unbalanced';
    const statementId = Number((await client.query<{ id: number }>(
      `INSERT INTO bank_statements
         (tenant_id,document_id,institution_name,account_hint,currency,period_start,period_end,
          opening_balance,closing_balance,extracted_fields,status,validation_detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [
        source.tenantId,
        documentId,
        raw.institutionName ?? null,
        raw.accountHint ?? null,
        raw.currency ?? null,
        raw.periodStart,
        raw.periodEnd,
        centsToDecimal(normalized.openingCents),
        centsToDecimal(normalized.closingCents),
        { pageCount: normalized.validation.pageCount },
        status,
        normalized.validation,
      ],
    )).rows[0]!.id);

    await insertLines(client, source.tenantId, statementId, normalized.lines);
    await client.query(
      `UPDATE accounting_documents SET status=$3, hold_reason=$4, updated_at=now()
       WHERE tenant_id=$1 AND id=$2`,
      [
        source.tenantId,
        documentId,
        normalized.validation.valid ? 'review' : 'held',
        normalized.validation.valid ? null : 'STATEMENT_UNBALANCED',
      ],
    );
    return {
      outcome: 'created',
      documentId,
      statementId,
      status,
      validation: normalized.validation,
    };
  });
}

/** Record an encrypted or otherwise unreadable source without inventing facts. */
export async function holdUnreadableStatement(
  source: StatementSource,
  reason = 'DOCUMENT_UNREADABLE',
): Promise<{ documentId: number; status: 'held' }> {
  return withTransaction(async (client) => {
    const result = await client.query<{ id: number }>(
      `INSERT INTO accounting_documents
         (tenant_id,message_id,attachment_id,kind,sha256,status,classification_confidence,hold_reason)
       VALUES ($1,$2,$3,'bank_statement',$4,'held',1,$5)
       ON CONFLICT (tenant_id,sha256,kind)
       DO UPDATE SET status='held', hold_reason=EXCLUDED.hold_reason, updated_at=now()
       RETURNING id`,
      [source.tenantId, source.messageId, source.attachmentId, source.sha256, reason],
    );
    return { documentId: Number(result.rows[0]!.id), status: 'held' };
  });
}

async function insertLines(
  client: pg.PoolClient,
  tenantId: number,
  statementId: number,
  lines: Array<{
    lineNo: number;
    postedOn: string;
    description: string;
    amountCents: number;
    balanceCents: number | null;
    fingerprint: string;
  }>,
): Promise<void> {
  for (const line of lines) {
    await client.query(
      `INSERT INTO bank_statement_lines
         (tenant_id,statement_id,line_no,posted_on,description,amount,balance,fingerprint)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        tenantId,
        statementId,
        line.lineNo,
        line.postedOn,
        line.description,
        centsToDecimal(line.amountCents),
        line.balanceCents == null ? null : centsToDecimal(line.balanceCents),
        line.fingerprint,
      ],
    );
  }
}
