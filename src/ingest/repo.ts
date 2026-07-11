import { withTransaction } from '../db/pool.js';
import { sha256Hex } from '../crypto.js';
import type { GmailMessage, GmailAttachment } from '../gmail/client.js';

/**
 * Ingest persistence (CHUNK_3). Idempotent at the source: dedup on gmail_message_id
 * and on attachment sha256. Re-polling never creates duplicate messages/attachments.
 */

export interface IngestedMessage {
  messageId: number;
  isNew: boolean;
  bodyOnly: boolean;
  attachmentIds: number[];
}

export async function persistMessage(
  tenantId: number,
  msg: GmailMessage,
): Promise<IngestedMessage> {
  return withTransaction(async (client) => {
    // Dedup on gmail_message_id.
    const existing = await client.query<{ id: number }>(
      'SELECT id FROM messages WHERE tenant_id=$1 AND gmail_message_id=$2',
      [tenantId, msg.id],
    );
    if (existing.rows[0]) {
      return { messageId: existing.rows[0].id, isNew: false, bodyOnly: false, attachmentIds: [] };
    }

    const bodyOnly = msg.attachments.length === 0;
    const inserted = await client.query<{ id: number }>(
      `INSERT INTO messages (tenant_id, gmail_message_id, thread_id, from_addr, subject, received_at, body_only, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'ingested') RETURNING id`,
      [tenantId, msg.id, msg.threadId, msg.from, msg.subject, msg.receivedAt, bodyOnly],
    );
    const messageId = inserted.rows[0]!.id;

    const attachmentIds: number[] = [];
    for (const att of msg.attachments) {
      const id = await insertAttachment(client, tenantId, messageId, att);
      attachmentIds.push(id);
    }
    return { messageId, isNew: true, bodyOnly, attachmentIds };
  });
}

async function insertAttachment(
  client: import('pg').PoolClient,
  tenantId: number,
  messageId: number,
  att: GmailAttachment,
): Promise<number> {
  const sha = sha256Hex(att.data);

  // Store bytes once, keyed by hash.
  await client.query(
    `INSERT INTO attachment_blobs (sha256, bytes, mime, size)
     VALUES ($1,$2,$3,$4) ON CONFLICT (sha256) DO NOTHING`,
    [sha, att.data, att.mimeType, att.data.length],
  );

  // If this hash already exists for the tenant, the new link is a duplicate.
  const dup = await client.query<{ id: number }>(
    'SELECT id FROM attachments WHERE tenant_id=$1 AND sha256=$2',
    [tenantId, sha],
  );
  const isDuplicate = Boolean(dup.rows[0]);

  const res = await client.query<{ id: number }>(
    `INSERT INTO attachments (tenant_id, message_id, filename, mime, sha256, storage_key, size, is_duplicate)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (tenant_id, sha256) DO UPDATE SET is_duplicate = true
     RETURNING id`,
    [tenantId, messageId, att.filename, att.mimeType, sha, sha, att.data.length, isDuplicate],
  );
  return res.rows[0]!.id;
}

export async function loadAttachmentBytes(sha256: string): Promise<Buffer | null> {
  const { query } = await import('../db/pool.js');
  const { rows } = await query<{ bytes: Buffer }>(
    'SELECT bytes FROM attachment_blobs WHERE sha256=$1',
    [sha256],
  );
  return rows[0]?.bytes ?? null;
}

export async function setTenantHistoryId(tenantId: number, historyId: string): Promise<void> {
  const { query } = await import('../db/pool.js');
  await query('UPDATE tenants SET gmail_history_id=$2 WHERE id=$1', [tenantId, historyId]);
}

export async function getTenantHistoryId(tenantId: number): Promise<string | null> {
  const { query } = await import('../db/pool.js');
  const { rows } = await query<{ gmail_history_id: string | null }>(
    'SELECT gmail_history_id FROM tenants WHERE id=$1',
    [tenantId],
  );
  return rows[0]?.gmail_history_id ?? null;
}
