import type pg from 'pg';
import { scopedQuery } from '../db/scoped.js';
import {
  assertContractValue,
  type AccountingDocument,
  type AccountingDocumentKind,
  type AccountingDocumentStatus,
  type BankStatement,
  type BankStatementFacts,
  type BankStatementLine,
  type BankStatementStatus,
  type ProviderJob,
  type ProviderJobOperation,
  type ReplyDraft,
  type ReplyDraftStatus,
} from './contracts.js';

export type TenantQuery = <T extends pg.QueryResultRow = pg.QueryResultRow>(
  tenantId: number,
  text: string,
  params?: unknown[],
) => Promise<pg.QueryResult<T>>;

const DOCUMENT_KINDS = ['invoice', 'bank_statement', 'unknown'] as const;
const DOCUMENT_STATUSES = [
  'received', 'extracted', 'review', 'ready', 'filed', 'posted', 'held', 'rejected',
] as const;
const STATEMENT_STATUSES = ['extracted', 'unbalanced', 'review', 'ready', 'filed', 'held'] as const;
const JOB_OPERATIONS = ['verify_company', 'query', 'post_bill', 'read_back', 'attach'] as const;
const DRAFT_STATUSES = ['proposed', 'created', 'updated', 'discarded', 'sent_external'] as const;

interface DocumentRow extends pg.QueryResultRow {
  id: number; tenant_id: number; message_id: number; attachment_id: number | null;
  kind: AccountingDocumentKind; sha256: string; status: AccountingDocumentStatus;
  classification_confidence: string | null; hold_reason: string | null;
  created_at: Date; updated_at: Date;
}

interface StatementRow extends pg.QueryResultRow {
  id: number; tenant_id: number; document_id: number; institution_name: string | null;
  account_hint: string | null; currency: string | null; period_start: string | null;
  period_end: string | null; opening_balance: string | null; closing_balance: string | null;
  extracted_fields: Record<string, unknown>; status: BankStatementStatus;
  validation_detail: Record<string, unknown>; filed_at: Date | null;
  created_at: Date; updated_at: Date;
}

interface StatementLineRow extends pg.QueryResultRow {
  id: number; tenant_id: number; statement_id: number; line_no: number;
  posted_on: string | null; description: string; amount: string; balance: string | null;
  fingerprint: string; match_status: BankStatementLine['matchStatus'];
  matched_provider_ref: Record<string, unknown> | null; review_reason: string | null;
  created_at: Date;
}

interface JobRow extends pg.QueryResultRow {
  id: number; tenant_id: number; connection_id: number; proposal_id: number | null;
  operation: ProviderJobOperation; request_payload: Record<string, unknown>;
  response_payload: Record<string, unknown> | null; status: ProviderJob['status'];
  idempotency_key: string; lease_token: string | null; leased_at: Date | null;
  lease_expires_at: Date | null; attempts: number; error_code: string | null;
  error_detail: string | null; created_at: Date; updated_at: Date;
}

interface DraftRow extends pg.QueryResultRow {
  id: number; tenant_id: number; message_id: number; gmail_draft_id: string | null;
  thread_id: string; to_addr: string; subject: string; body_text: string;
  status: ReplyDraftStatus; reason: string | null; created_by: number;
  created_at: Date; updated_at: Date;
}

export class AccountingIntakeRepository {
  constructor(private readonly run: TenantQuery = scopedQuery) {}

  async createDocument(input: {
    tenantId: number; messageId: number; attachmentId?: number | null;
    kind: AccountingDocumentKind; sha256: string; status?: AccountingDocumentStatus;
    classificationConfidence?: string | null; holdReason?: string | null;
  }): Promise<AccountingDocument> {
    assertContractValue('document kind', input.kind, DOCUMENT_KINDS);
    const status = input.status ?? 'received';
    assertContractValue('document status', status, DOCUMENT_STATUSES);
    const { rows } = await this.run<DocumentRow>(
      input.tenantId,
      `INSERT INTO accounting_documents
         (tenant_id, message_id, attachment_id, kind, sha256, status,
          classification_confidence, hold_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [input.messageId, input.attachmentId ?? null, input.kind, input.sha256, status,
        input.classificationConfidence ?? null, input.holdReason ?? null],
    );
    return mapDocument(requiredRow(rows));
  }

  async createStatement(input: {
    tenantId: number; documentId: number; facts: BankStatementFacts;
    status?: BankStatementStatus;
  }): Promise<BankStatement> {
    const status = input.status ?? 'extracted';
    assertContractValue('statement status', status, STATEMENT_STATUSES);
    const f = input.facts;
    const { rows } = await this.run<StatementRow>(
      input.tenantId,
      `INSERT INTO bank_statements
         (tenant_id, document_id, institution_name, account_hint, currency,
          period_start, period_end, opening_balance, closing_balance, extracted_fields,
          status, validation_detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [input.documentId, f.institutionName, f.accountHint, f.currency, f.periodStart,
        f.periodEnd, f.openingBalance, f.closingBalance, f.extractedFields, status,
        f.validationDetail],
    );
    return mapStatement(requiredRow(rows));
  }

  async listStatementLines(tenantId: number, statementId: number): Promise<BankStatementLine[]> {
    const { rows } = await this.run<StatementLineRow>(
      tenantId,
      `SELECT * FROM bank_statement_lines
       WHERE tenant_id = $1 AND statement_id = $2 ORDER BY line_no`,
      [statementId],
    );
    return rows.map(mapStatementLine);
  }

  async enqueueProviderJob(input: {
    tenantId: number; connectionId: number; proposalId?: number | null;
    operation: ProviderJobOperation; requestPayload: Record<string, unknown>;
    idempotencyKey: string;
  }): Promise<ProviderJob> {
    assertContractValue('provider job operation', input.operation, JOB_OPERATIONS);
    const { rows } = await this.run<JobRow>(
      input.tenantId,
      `INSERT INTO provider_jobs
         (tenant_id, connection_id, proposal_id, operation, request_payload, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [input.connectionId, input.proposalId ?? null, input.operation, input.requestPayload,
        input.idempotencyKey],
    );
    return mapJob(requiredRow(rows));
  }

  async createReplyDraft(input: {
    tenantId: number; messageId: number; externalDraftId?: string | null;
    threadId: string; toAddress: string; subject: string; bodyText: string;
    status?: ReplyDraftStatus; reason?: string | null; createdBy: number;
  }): Promise<ReplyDraft> {
    const status = input.status ?? 'proposed';
    assertContractValue('reply draft status', status, DRAFT_STATUSES);
    const { rows } = await this.run<DraftRow>(
      input.tenantId,
      `INSERT INTO reply_drafts
         (tenant_id, message_id, gmail_draft_id, thread_id, to_addr, subject,
          body_text, status, reason, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [input.messageId, input.externalDraftId ?? null, input.threadId, input.toAddress,
        input.subject, input.bodyText, status, input.reason ?? null, input.createdBy],
    );
    return mapDraft(requiredRow(rows));
  }
}

function requiredRow<T>(rows: T[]): T {
  const row = rows[0];
  if (!row) throw new Error('Repository write returned no row');
  return row;
}

function mapDocument(r: DocumentRow): AccountingDocument {
  return { id: Number(r.id), tenantId: Number(r.tenant_id), messageId: Number(r.message_id),
    attachmentId: r.attachment_id == null ? null : Number(r.attachment_id), kind: r.kind,
    sha256: r.sha256, status: r.status, classificationConfidence: r.classification_confidence,
    holdReason: r.hold_reason, createdAt: r.created_at, updatedAt: r.updated_at };
}

function mapStatement(r: StatementRow): BankStatement {
  return { id: Number(r.id), tenantId: Number(r.tenant_id), documentId: Number(r.document_id),
    institutionName: r.institution_name, accountHint: r.account_hint, currency: r.currency,
    periodStart: r.period_start, periodEnd: r.period_end, openingBalance: r.opening_balance,
    closingBalance: r.closing_balance, extractedFields: r.extracted_fields, status: r.status,
    validationDetail: r.validation_detail, filedAt: r.filed_at, createdAt: r.created_at,
    updatedAt: r.updated_at };
}

function mapStatementLine(r: StatementLineRow): BankStatementLine {
  return { id: Number(r.id), tenantId: Number(r.tenant_id), statementId: Number(r.statement_id),
    lineNo: r.line_no, postedOn: r.posted_on, description: r.description, amount: r.amount,
    balance: r.balance, fingerprint: r.fingerprint, matchStatus: r.match_status,
    matchedProviderRef: r.matched_provider_ref, reviewReason: r.review_reason,
    createdAt: r.created_at };
}

function mapJob(r: JobRow): ProviderJob {
  return { id: Number(r.id), tenantId: Number(r.tenant_id), connectionId: Number(r.connection_id),
    proposalId: r.proposal_id == null ? null : Number(r.proposal_id), operation: r.operation,
    requestPayload: r.request_payload, responsePayload: r.response_payload, status: r.status,
    idempotencyKey: r.idempotency_key, leaseToken: r.lease_token, leasedAt: r.leased_at,
    leaseExpiresAt: r.lease_expires_at, attempts: r.attempts, errorCode: r.error_code,
    errorDetail: r.error_detail, createdAt: r.created_at, updatedAt: r.updated_at };
}

function mapDraft(r: DraftRow): ReplyDraft {
  return { id: Number(r.id), tenantId: Number(r.tenant_id), messageId: Number(r.message_id),
    externalDraftId: r.gmail_draft_id, threadId: r.thread_id, toAddress: r.to_addr,
    subject: r.subject, bodyText: r.body_text, status: r.status, reason: r.reason,
    createdBy: Number(r.created_by), createdAt: r.created_at, updatedAt: r.updated_at };
}
