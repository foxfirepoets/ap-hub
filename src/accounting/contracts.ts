/**
 * Provider-neutral accounting intake contracts.
 *
 * Money remains a decimal string so database NUMERIC values are never rounded by
 * JavaScript. External adapters translate these records at the connector boundary.
 */

export type AccountingDocumentKind = 'invoice' | 'bank_statement' | 'unknown';
export type AccountingDocumentStatus =
  | 'received'
  | 'extracted'
  | 'review'
  | 'ready'
  | 'filed'
  | 'posted'
  | 'held'
  | 'rejected';
export type BankStatementStatus =
  | 'extracted'
  | 'unbalanced'
  | 'review'
  | 'ready'
  | 'filed'
  | 'held';
export type StatementLineMatchStatus = 'unmatched' | 'suggested' | 'matched' | 'excluded';
export type ProviderJobOperation = 'verify_company' | 'query' | 'post_bill' | 'read_back' | 'attach';
export type ProviderJobStatus = 'queued' | 'leased' | 'sent' | 'succeeded' | 'failed' | 'held';
export type ReplyDraftStatus = 'proposed' | 'created' | 'updated' | 'discarded' | 'sent_external';

export interface AccountingDocument {
  id: number;
  tenantId: number;
  messageId: number;
  attachmentId: number | null;
  kind: AccountingDocumentKind;
  sha256: string;
  status: AccountingDocumentStatus;
  classificationConfidence: string | null;
  holdReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface BankStatementFacts {
  institutionName: string | null;
  accountHint: string | null;
  currency: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  openingBalance: string | null;
  closingBalance: string | null;
  extractedFields: Record<string, unknown>;
  validationDetail: Record<string, unknown>;
}

export interface BankStatement extends BankStatementFacts {
  id: number;
  tenantId: number;
  documentId: number;
  status: BankStatementStatus;
  filedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface BankStatementLine {
  id: number;
  tenantId: number;
  statementId: number;
  lineNo: number;
  postedOn: string | null;
  description: string;
  amount: string;
  balance: string | null;
  fingerprint: string;
  matchStatus: StatementLineMatchStatus;
  matchedProviderRef: Record<string, unknown> | null;
  reviewReason: string | null;
  createdAt: Date;
}

export interface ProviderCapability {
  provider: string;
  edition: string;
  operation: string;
  supported: boolean;
  reason: string | null;
  unsupportedFields: string[];
}

export interface ProviderJob {
  id: number;
  tenantId: number;
  connectionId: number;
  proposalId: number | null;
  operation: ProviderJobOperation;
  requestPayload: Record<string, unknown>;
  responsePayload: Record<string, unknown> | null;
  status: ProviderJobStatus;
  idempotencyKey: string;
  leaseToken: string | null;
  leasedAt: Date | null;
  leaseExpiresAt: Date | null;
  attempts: number;
  errorCode: string | null;
  errorDetail: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ReplyDraft {
  id: number;
  tenantId: number;
  messageId: number;
  externalDraftId: string | null;
  threadId: string;
  toAddress: string;
  subject: string;
  bodyText: string;
  status: ReplyDraftStatus;
  reason: string | null;
  createdBy: number;
  createdAt: Date;
  updatedAt: Date;
}

export class InvalidAccountingContractError extends Error {
  constructor(field: string, value: unknown) {
    super(`Invalid ${field}: ${String(value)}`);
    this.name = 'InvalidAccountingContractError';
  }
}

export function assertContractValue<T extends string>(
  field: string,
  value: unknown,
  allowed: readonly T[],
): asserts value is T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new InvalidAccountingContractError(field, value);
  }
}
