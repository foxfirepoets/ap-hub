import { query, withTransaction } from '../db/pool.js';
import { writeAudit } from '../audit.js';
import { actorLabel, assertEntityId, ensurePermission, ServiceError, type ActorContext } from '../services/index.js';
import { getQueue, JOBS } from '../queue.js';

export type HumanDocumentClassification = 'invoice' | 'bank_statement' | 'irrelevant';

export interface ClassificationReviewItem {
  id: number;
  messageId: number;
  attachmentId: number | null;
  filename: string | null;
  subject: string | null;
  holdReason: string | null;
  createdAt: string;
}

export async function stageClassifiedDocument(input: {
  tenantId: number; messageId: number; attachmentId: number | null; sha256: string;
  kind: 'invoice' | 'bank_statement'; confidence: string;
}): Promise<void> {
  await withTransaction(async (client) => {
    const document = (await client.query<{ id: number }>(
      `INSERT INTO accounting_documents
        (tenant_id,message_id,attachment_id,kind,sha256,status,classification_confidence)
       VALUES ($1,$2,$3,$4,$5,'held',$6)
       ON CONFLICT (tenant_id,sha256,kind) DO NOTHING RETURNING id`,
      [input.tenantId, input.messageId, input.attachmentId, input.kind, input.sha256, input.confidence],
    )).rows[0] ?? (await client.query<{ id: number }>(
      `SELECT id FROM accounting_documents WHERE tenant_id=$1 AND sha256=$2 AND kind=$3`,
      [input.tenantId, input.sha256, input.kind],
    )).rows[0];
    if (!document) throw new Error('CLASSIFICATION_DOCUMENT_CLAIM_FAILED');
    const jobName = input.kind === 'invoice' ? JOBS.extract : JOBS.extract_statement;
    await client.query(
      `INSERT INTO classification_dispatches (tenant_id,document_id,job_name,payload)
       VALUES ($1,$2,$3,$4) ON CONFLICT (tenant_id,document_id) DO NOTHING`,
      [input.tenantId, document.id, jobName, {
        tenantId: input.tenantId, messageId: input.messageId, attachmentId: input.attachmentId,
      }],
    );
  });
}

export async function dispatchPendingClassifications(
  enqueue: (name: string, data: Record<string, unknown>, singletonKey: string) => Promise<void> =
    async (name, data, singletonKey) => { await getQueue().send(name, data, { singletonKey }); },
): Promise<number> {
  const pending = (await query<{
    id: number; tenant_id: number; document_id: number; job_name: string; payload: Record<string, unknown>;
  }>(
    `SELECT id,tenant_id,document_id,job_name,payload FROM classification_dispatches
      WHERE status='pending' ORDER BY id LIMIT 100`,
  )).rows;
  let dispatched = 0;
  for (const row of pending) {
    await enqueue(row.job_name, row.payload, `classification-document:${row.document_id}`);
    await withTransaction(async (client) => {
      const changed = await client.query(
        `UPDATE classification_dispatches SET status='dispatched',attempts=attempts+1,
          dispatched_at=now(),updated_at=now() WHERE id=$1 AND status='pending'`,
        [row.id],
      );
      if (!changed.rowCount) return;
      await client.query(
        `UPDATE accounting_documents SET status='received',hold_reason=NULL,updated_at=now()
          WHERE tenant_id=$1 AND id=$2 AND status='held'`,
        [row.tenant_id, row.document_id],
      );
      dispatched += 1;
    });
  }
  return dispatched;
}

export async function listClassificationReview(tenantId: number): Promise<ClassificationReviewItem[]> {
  const { rows } = await query<{
    id: number; message_id: number; attachment_id: number | null; filename: string | null;
    subject: string | null; hold_reason: string | null; created_at: Date;
  }>(
    `SELECT d.id,d.message_id,d.attachment_id,a.filename,m.subject,d.hold_reason,d.created_at
       FROM accounting_documents d
       JOIN messages m ON m.tenant_id=d.tenant_id AND m.id=d.message_id
       LEFT JOIN attachments a ON a.tenant_id=d.tenant_id AND a.id=d.attachment_id
      WHERE d.tenant_id=$1 AND d.kind='unknown' AND d.status='held'
      ORDER BY d.created_at`,
    [tenantId],
  );
  return rows.map((row) => ({
    id: Number(row.id), messageId: Number(row.message_id),
    attachmentId: row.attachment_id == null ? null : Number(row.attachment_id),
    filename: row.filename, subject: row.subject, holdReason: row.hold_reason,
    createdAt: row.created_at.toISOString(),
  }));
}

export async function classifyHeldDocument(
  ctx: ActorContext,
  documentId: number,
  classification: HumanDocumentClassification,
  reason: string,
  enqueue: (name: string, data: Record<string, unknown>, singletonKey: string) => Promise<void> = async (name, data, singletonKey) => {
    await getQueue().send(name, data, { singletonKey });
  },
): Promise<{ classification: HumanDocumentClassification; queued: boolean }> {
  ensurePermission(ctx, 'remap');
  assertEntityId(documentId);
  const why = reason.trim();
  if (!why || why.length > 1000) throw new ServiceError('VALIDATION', 'reason is required and must be at most 1000 characters');
  if (!['invoice', 'bank_statement', 'irrelevant'].includes(classification)) {
    throw new ServiceError('VALIDATION', 'unsupported classification');
  }

  await withTransaction(async (client) => {
    const row = (await client.query<{ message_id: number; attachment_id: number | null }>(
      `UPDATE accounting_documents
          SET kind=$3,status=$4,classification_confidence=1,hold_reason=$5,updated_at=now()
        WHERE tenant_id=$1 AND id=$2 AND kind='unknown' AND status='held'
        RETURNING message_id,attachment_id`,
      [ctx.tenantId, documentId, classification === 'irrelevant' ? 'unknown' : classification,
        classification === 'irrelevant' ? 'rejected' : 'held',
        classification === 'irrelevant' ? null : 'CLASSIFICATION_DISPATCH_PENDING'],
    )).rows[0];
    if (!row) throw new ServiceError('accounting_document_not_found', 'held document not found');
    await writeAudit({
      tenantId: ctx.tenantId, actor: actorLabel(ctx), action: 'accounting_document.classified',
      entity: `accounting_document:${documentId}`,
      detail: { role: ctx.role, classification, reason: why },
    }, client);
    if (classification !== 'irrelevant') {
      await client.query(
        `INSERT INTO classification_dispatches (tenant_id,document_id,job_name,payload)
         VALUES ($1,$2,$3,$4) ON CONFLICT (tenant_id,document_id) DO NOTHING`,
        [ctx.tenantId, documentId, classification === 'invoice' ? JOBS.extract : JOBS.extract_statement, {
          tenantId: ctx.tenantId, messageId: Number(row.message_id),
          attachmentId: row.attachment_id == null ? null : Number(row.attachment_id),
        }],
      );
    }
    return row;
  });

  if (classification !== 'irrelevant') {
    await dispatchPendingClassifications(enqueue);
  }
  return { classification, queued: classification !== 'irrelevant' };
}
