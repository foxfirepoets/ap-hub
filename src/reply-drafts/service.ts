import type { PoolClient } from 'pg';
import { hashOf, writeAudit } from '../audit.js';
import { scopedQuery } from '../db/scoped.js';
import { withTransaction } from '../db/pool.js';
import {
  deriveReplyRecipient,
  getGmailDraftClient,
  GmailDraftResultUnknownError,
  type GmailDraftClient,
  type GmailDraftProjection,
  type SourceConversation,
} from '../gmail/drafts.js';
import {
  actorLabel,
  assertEntityId,
  ensurePermission,
  ServiceError,
  type ActorContext,
} from '../services/index.js';

type DraftStatus = 'proposed' | 'result_unknown' | 'created' | 'updated' | 'discarded' | 'sent_external';

interface DraftRow {
  id: number;
  tenant_id: number;
  message_id: number;
  gmail_draft_id: string | null;
  thread_id: string;
  to_addr: string;
  subject: string;
  body_text: string;
  status: DraftStatus;
  reason: string | null;
  created_by: number;
  created_at: Date;
  updated_at: Date;
}

interface MessageRow {
  id: number;
  gmail_message_id: string;
  thread_id: string | null;
  from_addr: string | null;
  subject: string | null;
}

export interface ReplyDraftView {
  id: number;
  messageId: number;
  externalDraftId: string | null;
  threadId: string;
  toAddress: string;
  subject: string;
  bodyText: string;
  status: DraftStatus;
  reason: string | null;
  createdBy: number;
  createdAt: Date;
  updatedAt: Date;
  sendControl: 'human_in_gmail';
}

export interface ReplyDraftDependencies {
  getClient(tenantId: number): Promise<GmailDraftClient>;
}

const defaultDependencies: ReplyDraftDependencies = { getClient: getGmailDraftClient };

function mapDraft(row: DraftRow): ReplyDraftView {
  return {
    id: Number(row.id),
    messageId: Number(row.message_id),
    externalDraftId: row.gmail_draft_id,
    threadId: row.thread_id,
    toAddress: row.to_addr,
    subject: row.subject,
    bodyText: row.body_text,
    status: row.status,
    reason: row.reason,
    createdBy: Number(row.created_by),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sendControl: 'human_in_gmail',
  };
}

function requireCopy(value: string, field: string, max: number): string {
  const normalized = value.trim();
  if (!normalized) throw new ServiceError('VALIDATION', `${field} is required`);
  if (normalized.length > max) throw new ServiceError('VALIDATION', `${field} is too long`);
  return normalized;
}

async function sourceMessage(tenantId: number, messageId: number): Promise<SourceConversation> {
  assertEntityId(messageId);
  const { rows } = await scopedQuery<MessageRow>(
    tenantId,
    `SELECT id,gmail_message_id,thread_id,from_addr,subject
       FROM messages WHERE tenant_id=$1 AND id=$2`,
    [messageId],
  );
  const row = rows[0];
  if (!row) throw new ServiceError('message_not_found');
  if (!row.thread_id || !row.from_addr) {
    throw new ServiceError('source_message_missing', 'source Gmail thread or sender is unavailable');
  }
  return {
    messageId: row.gmail_message_id,
    threadId: row.thread_id,
    from: row.from_addr,
    subject: row.subject ?? '',
  };
}

async function getDraftRow(tenantId: number, id: number): Promise<DraftRow | null> {
  assertEntityId(id);
  const { rows } = await scopedQuery<DraftRow>(
    tenantId,
    'SELECT * FROM reply_drafts WHERE tenant_id=$1 AND id=$2',
    [id],
  );
  return rows[0] ?? null;
}

async function auditMutation(
  client: PoolClient,
  ctx: ActorContext,
  action: string,
  draft: DraftRow,
  before: unknown,
): Promise<void> {
  await writeAudit({
    tenantId: ctx.tenantId,
    actor: actorLabel(ctx),
    action,
    entity: `reply_draft:${draft.id}`,
    beforeHash: hashOf(before),
    afterHash: hashOf(mapDraft(draft)),
    detail: {
      role: ctx.role,
      messageId: Number(draft.message_id),
      status: draft.status,
      humanSendsInGmail: true,
    },
  }, client);
}

async function persistProviderProjection(
  tenantId: number,
  draftId: number,
  projection: GmailDraftProjection,
  successStatus: 'created' | 'updated',
): Promise<ReplyDraftView> {
  const status = projection.status === 'sent_external' ? 'sent_external' : successStatus;
  const { rows } = await scopedQuery<DraftRow>(
    tenantId,
    `UPDATE reply_drafts
        SET gmail_draft_id=$3, status=$4, updated_at=now()
      WHERE tenant_id=$1 AND id=$2 RETURNING *`,
    [draftId, projection.providerDraftId, status],
  );
  const row = rows[0];
  if (!row) throw new ServiceError('reply_draft_not_found');
  return mapDraft(row);
}

async function markResultUnknown(tenantId: number, draftId: number): Promise<void> {
  await scopedQuery(
    tenantId,
    `UPDATE reply_drafts SET status='result_unknown',updated_at=now()
      WHERE tenant_id=$1 AND id=$2 AND status='proposed'`,
    [draftId],
  );
}

export async function readReplyDraft(
  tenantId: number,
  messageId: number,
  deps: ReplyDraftDependencies = defaultDependencies,
): Promise<ReplyDraftView | null> {
  assertEntityId(messageId);
  const { rows } = await scopedQuery<DraftRow>(
    tenantId,
    `SELECT * FROM reply_drafts
      WHERE tenant_id=$1 AND message_id=$2
      ORDER BY updated_at DESC, id DESC LIMIT 1`,
    [messageId],
  );
  const row = rows[0];
  if (!row) return null;
  if (row.status === 'result_unknown') {
    const client = await deps.getClient(tenantId);
    const adopted = row.gmail_draft_id
      ? await client.readStatus(row.gmail_draft_id, row.thread_id)
      : await client.reconcileCreateInSourceThread(
        await sourceMessage(tenantId, Number(row.message_id)),
        { subject: row.subject, bodyText: row.body_text },
      );
    if (adopted) {
      return persistProviderProjection(
        tenantId,
        Number(row.id),
        adopted,
        row.gmail_draft_id ? 'updated' : 'created',
      );
    }
  } else if (row.gmail_draft_id && ['created', 'updated'].includes(row.status)) {
    const client = await deps.getClient(tenantId);
    const projection = await client.readStatus(row.gmail_draft_id, row.thread_id);
    if (projection.status === 'sent_external') {
      return persistProviderProjection(tenantId, Number(row.id), projection, 'updated');
    }
  }
  return mapDraft(row);
}

export async function createReplyDraft(
  ctx: ActorContext,
  input: { messageId: number; subject: string; bodyText: string; reason?: string | null },
  deps: ReplyDraftDependencies = defaultDependencies,
): Promise<ReplyDraftView> {
  ensurePermission(ctx, 'draft_reply');
  const source = await sourceMessage(ctx.tenantId, input.messageId);
  const subject = requireCopy(input.subject, 'subject', 998);
  const bodyText = requireCopy(input.bodyText, 'bodyText', 100_000);
  const reason = input.reason?.trim() || null;
  const toAddress = deriveReplyRecipient(source);

  let prepared: DraftRow;
  try {
    prepared = await withTransaction(async (client) => {
      const existing = await client.query<DraftRow>(
        `SELECT * FROM reply_drafts
          WHERE tenant_id=$1 AND message_id=$2
            AND status IN ('proposed','result_unknown','created','updated')
          FOR UPDATE`,
        [ctx.tenantId, input.messageId],
      );
      if (existing.rows[0]) throw new ServiceError('reply_draft_exists');
      const { rows } = await client.query<DraftRow>(
        `INSERT INTO reply_drafts
           (tenant_id,message_id,thread_id,to_addr,subject,body_text,status,reason,created_by)
         VALUES ($1,$2,$3,$4,$5,$6,'proposed',$7,$8) RETURNING *`,
        [ctx.tenantId, input.messageId, source.threadId, toAddress, subject, bodyText, reason, ctx.userId],
      );
      const row = rows[0]!;
      await auditMutation(client, ctx, 'reply_draft.prepared', row, null);
      return row;
    });
  } catch (error: any) {
    if (error instanceof ServiceError) throw error;
    if (error?.code === '23505') throw new ServiceError('reply_draft_exists');
    throw error;
  }

  const gmail = await deps.getClient(ctx.tenantId);
  try {
    const projection = await gmail.createInSourceThread(source, { subject, bodyText });
    return persistProviderProjection(ctx.tenantId, Number(prepared.id), projection, 'created');
  } catch (error) {
    if (error instanceof GmailDraftResultUnknownError) {
      await markResultUnknown(ctx.tenantId, Number(prepared.id));
    }
    throw error;
  }
}

export async function updateReplyDraft(
  ctx: ActorContext,
  draftId: number,
  input: { subject: string; bodyText: string; reason?: string | null },
  deps: ReplyDraftDependencies = defaultDependencies,
): Promise<ReplyDraftView> {
  ensurePermission(ctx, 'draft_reply');
  const existing = await getDraftRow(ctx.tenantId, draftId);
  if (!existing) throw new ServiceError('reply_draft_not_found');
  if (existing.status === 'sent_external') throw new ServiceError('reply_draft_already_sent');
  if (existing.status === 'discarded') throw new ServiceError('reply_draft_discarded');
  const source = await sourceMessage(ctx.tenantId, Number(existing.message_id));
  const subject = requireCopy(input.subject, 'subject', 998);
  const bodyText = requireCopy(input.bodyText, 'bodyText', 100_000);
  const reason = input.reason?.trim() || null;
  const gmail = await deps.getClient(ctx.tenantId);
  let resolvedProviderDraftId = existing.gmail_draft_id;
  if (existing.status === 'result_unknown') {
    const adopted = resolvedProviderDraftId
      ? await gmail.readStatus(resolvedProviderDraftId, existing.thread_id)
      : await gmail.reconcileCreateInSourceThread(source, {
        subject: existing.subject,
        bodyText: existing.body_text,
      });
    resolvedProviderDraftId = adopted?.providerDraftId ?? null;
    if (!resolvedProviderDraftId) {
      throw new GmailDraftResultUnknownError(
        'Gmail draft result remains unknown; no further remote mutation was attempted.',
      );
    }
  }

  const prepared = await withTransaction(async (client) => {
    const { rows } = await client.query<DraftRow>(
      `UPDATE reply_drafts
          SET subject=$3,body_text=$4,reason=$5,status='proposed',updated_at=now()
        WHERE tenant_id=$1 AND id=$2
          AND status IN ('proposed','result_unknown','created','updated')
        RETURNING *`,
      [ctx.tenantId, draftId, subject, bodyText, reason],
    );
    const row = rows[0];
    if (!row) throw new ServiceError('reply_draft_conflict');
    await auditMutation(client, ctx, 'reply_draft.updated', row, mapDraft(existing));
    return row;
  });

  const providerDraftId = resolvedProviderDraftId ?? prepared.gmail_draft_id;
  try {
    const projection = providerDraftId
      ? await gmail.updateInSourceThread(providerDraftId, source, { subject, bodyText })
      : await gmail.createInSourceThread(source, { subject, bodyText });
    return persistProviderProjection(ctx.tenantId, draftId, projection, 'updated');
  } catch (error) {
    if (error instanceof GmailDraftResultUnknownError) {
      await markResultUnknown(ctx.tenantId, draftId);
    }
    throw error;
  }
}

export async function discardReplyDraft(
  ctx: ActorContext,
  draftId: number,
  deps: ReplyDraftDependencies = defaultDependencies,
): Promise<ReplyDraftView> {
  ensurePermission(ctx, 'draft_reply');
  const existing = await getDraftRow(ctx.tenantId, draftId);
  if (!existing) throw new ServiceError('reply_draft_not_found');
  if (existing.status === 'sent_external') throw new ServiceError('reply_draft_already_sent');
  if (existing.status === 'discarded') return mapDraft(existing);

  let providerDraftId = existing.gmail_draft_id;
  if (existing.status === 'result_unknown' && !providerDraftId) {
    const source = await sourceMessage(ctx.tenantId, Number(existing.message_id));
    const gmail = await deps.getClient(ctx.tenantId);
    const adopted = await gmail.reconcileCreateInSourceThread(source, {
      subject: existing.subject,
      bodyText: existing.body_text,
    });
    providerDraftId = adopted?.providerDraftId ?? null;
    if (!providerDraftId) {
      throw new GmailDraftResultUnknownError(
        'Gmail draft result remains unknown; discard was not attempted.',
      );
    }
  }
  if (providerDraftId) {
    const gmail = await deps.getClient(ctx.tenantId);
    await gmail.discard(providerDraftId, existing.thread_id);
  }
  return withTransaction(async (client) => {
    const { rows } = await client.query<DraftRow>(
      `UPDATE reply_drafts SET status='discarded',updated_at=now()
        WHERE tenant_id=$1 AND id=$2
          AND status IN ('proposed','result_unknown','created','updated')
        RETURNING *`,
      [ctx.tenantId, draftId],
    );
    const row = rows[0];
    if (!row) throw new ServiceError('reply_draft_conflict');
    await auditMutation(client, ctx, 'reply_draft.discarded', row, mapDraft(existing));
    return mapDraft(row);
  });
}
