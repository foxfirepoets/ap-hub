import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  classifyHeldDocument,
  dispatchPendingClassifications,
  stageClassifiedDocument,
} from '../src/accounting/document-review.js';
import { ownerGateEnabled, setOwnerWriteGate } from '../src/accounting/write-gates.js';
import { query } from '../src/db/pool.js';
import { classifyOnce } from '../src/pipeline/extract.js';
import { createSession } from '../src/auth/session.js';
import { saveToken } from '../src/auth/tokens.js';
import { getQboConnector } from '../src/connectors/factory.js';
import { runSetOwnerWriteGate } from '../src/accounting/write-gates-http.js';
import { ServiceError } from '../src/services/index.js';
import { closeAll, countRows, createConnection, createTenant, createUser, insertAttachment, insertMessage, resetTables } from './helpers.js';

describe('operator classification and write controls', () => {
  beforeEach(resetTables);
  afterAll(closeAll);

  it('lets an owner classify a held document exactly once and audits the decision', async () => {
    const tenantId = await createTenant();
    const userId = await createUser(tenantId);
    const messageId = await insertMessage(tenantId, { subject: 'Please process' });
    const attachmentId = await insertAttachment(tenantId, messageId, { filename: '1234.pdf' });
    const documentId = Number((await query<{ id: number }>(
      `INSERT INTO accounting_documents
        (tenant_id,message_id,attachment_id,kind,sha256,status,hold_reason)
       VALUES ($1,$2,$3,'unknown','ambiguous','held','UNCLASSIFIED_ATTACHMENT') RETURNING id`,
      [tenantId, messageId, attachmentId],
    )).rows[0]!.id);
    const enqueue = vi.fn(async (_name: string, _data: Record<string, unknown>, _key: string) => undefined);
    const ctx = { tenantId, userId, role: 'owner_controller', email: 'owner@example.com' };
    await classifyHeldDocument(ctx, documentId, 'invoice', 'Reviewed source PDF', enqueue);
    await expect(classifyHeldDocument(ctx, documentId, 'invoice', 'again', enqueue))
      .rejects.toMatchObject({ code: 'accounting_document_not_found' });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0]?.[0]).toBe('extract');
    expect((await query('SELECT 1 FROM audit_log WHERE action=$1 AND entity=$2',
      ['accounting_document.classified', `accounting_document:${documentId}`])).rowCount).toBe(1);
  });

  it('keeps CPA classification read-only and owner gates company-bound', async () => {
    const tenantId = await createTenant();
    const ownerId = await createUser(tenantId);
    const connectionId = await createConnection(tenantId, { provider: 'qbo', externalCompany: 'realm-1' });
    await expect(setOwnerWriteGate(
      { tenantId, userId: ownerId, role: 'cpa', email: 'cpa@example.com' },
      connectionId,
      { enabled: false, confirmedCompanyId: 'realm-1', backupConfirmed: false, confirmation: '' },
    )).rejects.toBeDefined();
    await setOwnerWriteGate(
      { tenantId, userId: ownerId, role: 'owner_controller', email: 'owner@example.com' },
      connectionId,
      { enabled: false, confirmedCompanyId: 'realm-1', backupConfirmed: false, confirmation: '' },
    );
    const metadata = (await query<{ metadata: Record<string, unknown> }>(
      'SELECT metadata FROM connections WHERE tenant_id=$1 AND id=$2', [tenantId, connectionId],
    )).rows[0]!.metadata;
    expect(ownerGateEnabled(metadata, 'realm-1')).toBe(false);
    await expect(setOwnerWriteGate(
      { tenantId, userId: ownerId, role: 'owner_controller', email: 'owner@example.com' },
      connectionId,
      { enabled: true, confirmedCompanyId: 'wrong-realm', backupConfirmed: true, confirmation: 'ENABLE WRITES' },
    )).rejects.toBeInstanceOf(ServiceError);
    await setOwnerWriteGate(
      { tenantId, userId: ownerId, role: 'owner_controller', email: 'owner@example.com' },
      connectionId,
      { enabled: true, confirmedCompanyId: 'realm-1', backupConfirmed: true, confirmation: 'ENABLE WRITES' },
    );
    const enabled = (await query<{ metadata: Record<string, unknown> }>(
      'SELECT metadata FROM connections WHERE tenant_id=$1 AND id=$2', [tenantId, connectionId],
    )).rows[0]!.metadata;
    expect(ownerGateEnabled(enabled, 'realm-1')).toBe(true);
  });

  it('recovers a classification dispatch process gap and deduplicates redelivery', async () => {
    const tenantId = await createTenant();
    const messageId = await insertMessage(tenantId, { subject: 'Invoice attached' });
    const attachmentId = await insertAttachment(tenantId, messageId, { filename: 'invoice.pdf', sha256: 'dispatch-gap' });
    const stage = {
      tenantId, messageId, attachmentId, sha256: 'dispatch-gap',
      kind: 'invoice' as const, confidence: '0.9900',
    };
    await stageClassifiedDocument(stage);
    await stageClassifiedDocument(stage);
    expect((await query('SELECT 1 FROM classification_dispatches WHERE tenant_id=$1', [tenantId])).rowCount).toBe(1);
    const failed = vi.fn(async () => { throw new Error('process stopped before queue confirmation'); });
    await expect(dispatchPendingClassifications(failed)).rejects.toThrow('process stopped');
    expect((await query<{ status: string }>(
      `SELECT status FROM accounting_documents WHERE tenant_id=$1 AND sha256='dispatch-gap'`, [tenantId],
    )).rows[0]!.status).toBe('held');
    const enqueue = vi.fn(async (_name: string, _data: Record<string, unknown>, _key: string) => undefined);
    expect(await dispatchPendingClassifications(enqueue)).toBe(1);
    expect(await dispatchPendingClassifications(enqueue)).toBe(0);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect((await query<{ status: string }>(
      `SELECT status FROM accounting_documents WHERE tenant_id=$1 AND sha256='dispatch-gap'`, [tenantId],
    )).rows[0]!.status).toBe('received');
  });

  it('routes a body-only classify redelivery through one durable dispatch', async () => {
    const tenantId = await createTenant();
    const messageId = await insertMessage(tenantId, { subject: 'Invoice INV-9' });
    const enqueue = vi.fn(async () => undefined);
    await classifyOnce({ data: { tenantId, messageId } }, enqueue);
    await classifyOnce({ data: { tenantId, messageId } }, enqueue);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(await countRows('classification_dispatches', 'tenant_id=$1', [tenantId])).toBe(1);
    expect(await countRows('accounting_documents', 'tenant_id=$1 AND attachment_id IS NULL', [tenantId])).toBe(1);
  });

  it('enables and disables sandbox writes through the owner HTTP route and connector gate', async () => {
    const tenantId = await createTenant();
    const ownerId = await createUser(tenantId, {
      role: 'owner_controller', email: 'sandbox-owner@example.com',
    });
    const bookkeeperId = await createUser(tenantId, {
      role: 'bookkeeper', email: 'sandbox-bookkeeper@example.com',
    });
    const ownerBearer = (await createSession(ownerId)).token;
    const bookkeeperBearer = (await createSession(bookkeeperId)).token;
    const connectionId = await createConnection(tenantId, {
      provider: 'qbo', externalCompany: 'sandbox-route-realm',
    });
    await saveToken(tenantId, 'qbo', {
      accessToken: 'sandbox-access', refreshToken: 'sandbox-refresh',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000), scope: 'com.intuit.quickbooks.accounting',
      realm: 'sandbox-route-realm',
    });
    const request = (bearer: string, body: Record<string, unknown>) => new Request(
      `http://localhost/api/provider-connections/${connectionId}/write-gate`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    const enable = {
      enabled: true, confirmedCompanyId: 'sandbox-route-realm',
      backupConfirmed: true, confirmation: 'ENABLE WRITES',
    };
    expect((await runSetOwnerWriteGate(request(bookkeeperBearer, enable), connectionId)).status).toBe(403);
    expect((await runSetOwnerWriteGate(request(ownerBearer, enable), connectionId)).status).toBe(200);
    await expect(getQboConnector(tenantId)).resolves.toMatchObject({
      provider: 'qbo', companyId: 'sandbox-route-realm',
    });
    expect((await runSetOwnerWriteGate(request(ownerBearer, {
      enabled: false, confirmedCompanyId: 'sandbox-route-realm',
      backupConfirmed: false, confirmation: '',
    }), connectionId)).status).toBe(200);
    await expect(getQboConnector(tenantId)).rejects.toThrow('QBO_OWNER_WRITE_GATE_DISABLED');
  });
});
