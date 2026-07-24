import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import balanced from './fixtures/bank-statements/balanced.json';
import multiPage from './fixtures/bank-statements/multi-page.json';
import missingRunningBalance from './fixtures/bank-statements/missing-running-balance.json';
import parenthesesNegative from './fixtures/bank-statements/parentheses-negative.json';
import duplicateLine from './fixtures/bank-statements/duplicate-line.json';
import imbalanced from './fixtures/bank-statements/imbalanced.json';
import existingInvoice from './fixtures/bank-statements/existing-invoice.json';
import {
  classifyAccountingAttachment,
  holdUnreadableStatement,
  importBankStatement,
  StatementInputError,
  type RawBankStatement,
  type StatementSource,
} from '../src/statements/ingest.js';
import { query } from '../src/db/pool.js';
import { classifyOnce } from '../src/pipeline/extract.js';
import {
  closeAll,
  countRows,
  createTenant,
  insertAttachment,
  insertMessage,
  resetTables,
} from './helpers.js';

async function source(sha = `statement-${performance.now()}`): Promise<StatementSource> {
  const tenantId = await createTenant();
  const messageId = await insertMessage(tenantId, { subject: 'June Bank Statement' });
  const attachmentId = await insertAttachment(tenantId, messageId, {
    sha256: sha,
    filename: 'statement.pdf',
  });
  return { tenantId, messageId, attachmentId, sha256: sha };
}

describe('CHUNK_3 bank statement ingestion', () => {
  beforeEach(resetTables);
  afterAll(closeAll);

  it('imports a balanced statement as one transactional header plus ordered source lines', async () => {
    const src = await source('balanced-sha');
    const result = await importBankStatement(src, balanced as RawBankStatement);
    expect(result).toMatchObject({ outcome: 'created', status: 'review' });
    expect(await countRows('accounting_documents')).toBe(1);
    expect(await countRows('bank_statements')).toBe(1);
    expect(await countRows('bank_statement_lines')).toBe(1);

    const rows = (await query<{
      line_no: number;
      amount: string;
      balance: string | null;
      match_status: string;
    }>(
      `SELECT line_no,amount::text,balance::text,match_status
       FROM bank_statement_lines WHERE tenant_id=$1 ORDER BY line_no`,
      [src.tenantId],
    )).rows;
    expect(rows).toEqual([{ line_no: 1, amount: '-100.00', balance: '900.00', match_status: 'unmatched' }]);
  });

  it('preserves multi-page ordering and records page evidence', async () => {
    const src = await source('multi-page-sha');
    const result = await importBankStatement(src, multiPage as RawBankStatement);
    expect(result.outcome).toBe('created');
    if (result.outcome !== 'created') throw new Error('expected created statement');
    expect(result.validation.pageCount).toBe(3);
    expect((await query<{ line_no: number }>(
      'SELECT line_no FROM bank_statement_lines WHERE statement_id=$1 ORDER BY line_no',
      [result.statementId],
    )).rows.map((row) => row.line_no)).toEqual([1, 2]);
  });

  it('accepts missing running balances but makes the absence visible', async () => {
    const result = await importBankStatement(
      await source('missing-running-sha'),
      missingRunningBalance as RawBankStatement,
    );
    expect(result.outcome).toBe('created');
    if (result.outcome !== 'created') throw new Error('expected created statement');
    expect(result.validation).toMatchObject({ valid: true, missingRunningBalances: 1 });
    expect((await query<{ balance: string | null }>(
      'SELECT balance::text FROM bank_statement_lines WHERE statement_id=$1',
      [result.statementId],
    )).rows[0]?.balance).toBeNull();
  });

  it('normalizes parentheses negatives and formatted money without floating-point arithmetic', async () => {
    const result = await importBankStatement(
      await source('parentheses-sha'),
      parenthesesNegative as RawBankStatement,
    );
    expect(result.outcome).toBe('created');
    if (result.outcome !== 'created') throw new Error('expected created statement');
    expect(result.validation).toMatchObject({
      openingCents: 100000,
      activityCents: -12500,
      closingCents: 87500,
      valid: true,
    });
  });

  it('detects a duplicate file deterministically and inserts nothing on replay', async () => {
    const src = await source('duplicate-document-sha');
    const first = await importBankStatement(src, balanced as RawBankStatement);
    const second = await importBankStatement(src, balanced as RawBankStatement);
    expect(first.outcome).toBe('created');
    expect(second).toMatchObject({
      outcome: 'duplicate',
      documentId: first.documentId,
      statementId: first.outcome === 'created' ? first.statementId : null,
    });
    expect(await countRows('accounting_documents')).toBe(1);
    expect(await countRows('bank_statements')).toBe(1);
    expect(await countRows('bank_statement_lines')).toBe(1);
  });

  it('rejects duplicate lines and period errors before any partial database write', async () => {
    const duplicateSource = await source('duplicate-line-sha');
    await expect(importBankStatement(duplicateSource, duplicateLine as RawBankStatement))
      .rejects.toMatchObject({ code: 'DUPLICATE_LINE' });
    expect(await countRows('accounting_documents')).toBe(0);
    expect(await countRows('bank_statements')).toBe(0);
    expect(await countRows('bank_statement_lines')).toBe(0);

    const badPeriodSource = await source('bad-period-sha');
    await expect(importBankStatement(badPeriodSource, {
      ...balanced,
      periodStart: '2026-07-01',
      periodEnd: '2026-06-30',
    } as RawBankStatement)).rejects.toBeInstanceOf(StatementInputError);
    expect(await countRows('accounting_documents')).toBe(0);
  });

  it('persists an imbalanced statement in review hold with the exact failing equation', async () => {
    const src = await source('imbalanced-sha');
    const result = await importBankStatement(src, imbalanced as RawBankStatement);
    expect(result.outcome).toBe('created');
    if (result.outcome !== 'created') throw new Error('expected created statement');
    expect(result.status).toBe('unbalanced');
    expect(result.validation).toMatchObject({
      valid: false,
      code: 'STATEMENT_UNBALANCED',
      expectedClosingCents: 90000,
      closingCents: 95000,
    });
    expect((await query<{ status: string; hold_reason: string }>(
      'SELECT status,hold_reason FROM accounting_documents WHERE tenant_id=$1',
      [src.tenantId],
    )).rows[0]).toEqual({ status: 'held', hold_reason: 'STATEMENT_UNBALANCED' });
  });

  it('holds encrypted input without invented statement facts', async () => {
    const src = await source('encrypted-sha');
    const held = await holdUnreadableStatement(src, 'DOCUMENT_UNREADABLE:ENCRYPTED_PDF');
    expect(held.status).toBe('held');
    expect(await countRows('accounting_documents', "status='held' AND hold_reason='DOCUMENT_UNREADABLE:ENCRYPTED_PDF'")).toBe(1);
    expect(await countRows('bank_statements')).toBe(0);
    expect(await countRows('bank_statement_lines')).toBe(0);
  });

  it('routes an existing invoice unchanged and holds ambiguous attachments', () => {
    expect(classifyAccountingAttachment(existingInvoice)).toMatchObject({
      kind: 'invoice',
      status: 'received',
      holdReason: null,
    });
    expect(classifyAccountingAttachment({
      subject: 'Documents',
      filename: 'scan.pdf',
      mime: 'application/pdf',
    })).toMatchObject({
      kind: 'unknown',
      status: 'held',
    });
  });

  it('keeps invoice extraction active while statements and unknowns cannot enter it', async () => {
    const tenantId = await createTenant();
    const invoiceMessage = await insertMessage(tenantId, { subject: 'Invoice INV-200' });
    const invoiceAttachment = await insertAttachment(tenantId, invoiceMessage, {
      sha256: 'invoice-route-sha',
      filename: 'invoice-200.pdf',
    });
    const statementMessage = await insertMessage(tenantId, { subject: 'June Bank Statement' });
    await insertAttachment(tenantId, statementMessage, {
      sha256: 'statement-route-sha',
      filename: 'statement.pdf',
    });
    const unknownMessage = await insertMessage(tenantId, { subject: 'Documents' });
    await insertAttachment(tenantId, unknownMessage, {
      sha256: 'unknown-route-sha',
      filename: 'scan.pdf',
    });
    const enqueue = vi.fn().mockResolvedValue(undefined);

    await classifyOnce({ data: { tenantId, messageId: invoiceMessage } }, enqueue);
    await classifyOnce({ data: { tenantId, messageId: statementMessage } }, enqueue);
    await classifyOnce({ data: { tenantId, messageId: unknownMessage } }, enqueue);

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith('extract', {
      tenantId,
      messageId: invoiceMessage,
      attachmentId: invoiceAttachment,
    });
    expect((await query<{ kind: string; status: string }>(
      'SELECT kind,status FROM accounting_documents WHERE tenant_id=$1 ORDER BY id',
      [tenantId],
    )).rows).toEqual([
      { kind: 'invoice', status: 'received' },
      { kind: 'bank_statement', status: 'received' },
      { kind: 'unknown', status: 'held' },
    ]);
  });

  it('adopts a canonical statement document created by routing before normalization', async () => {
    const src = await source('pre-routed-sha');
    const documentId = Number((await query<{ id: number }>(
      `INSERT INTO accounting_documents
         (tenant_id,message_id,attachment_id,kind,sha256,status,classification_confidence)
       VALUES ($1,$2,$3,'bank_statement',$4,'received',0.99) RETURNING id`,
      [src.tenantId, src.messageId, src.attachmentId, src.sha256],
    )).rows[0]!.id);
    const result = await importBankStatement(src, balanced as RawBankStatement);
    expect(result).toMatchObject({ outcome: 'created', documentId });
    expect(await countRows('accounting_documents')).toBe(1);
    expect(await countRows('bank_statements')).toBe(1);
  });
});
