import { scopedQuery } from '../../db/scoped.js';
import { isValidId } from '../index.js';

/**
 * CHUNK_7_DIGEST — the notification feed. Read-only, tenant-scoped. Surfaces both
 * `daily_digest` and `risk_alert` rows written by `src/services/digest.ts`.
 */

export interface NotificationRow {
  id: number;
  kind: string;
  severity: string;
  payload: Record<string, unknown>;
  digestBatch: string | null;
  readAt: string | null;
  createdAt: string;
}

interface NotificationDbRow {
  id: number;
  kind: string;
  severity: string;
  payload: Record<string, unknown>;
  digest_batch: string | null;
  read_at: Date | null;
  created_at: Date;
}

function mapRow(r: NotificationDbRow): NotificationRow {
  return {
    id: r.id,
    kind: r.kind,
    severity: r.severity,
    payload: r.payload ?? {},
    digestBatch: r.digest_batch,
    readAt: r.read_at ? r.read_at.toISOString() : null,
    createdAt: r.created_at.toISOString(),
  };
}

const SELECT_COLS =
  "id, kind, severity, payload, digest_batch::text AS digest_batch, read_at, created_at";

export async function listNotifications(
  tenantId: number,
  opts: { unreadOnly?: boolean; limit?: number } = {},
): Promise<NotificationRow[]> {
  const params: unknown[] = [];
  let where = 'tenant_id = $1';
  if (opts.unreadOnly) {
    where += ' AND read_at IS NULL';
  }
  params.push(opts.limit ?? 100);
  const limitParam = `$${params.length + 1}`;
  const { rows } = await scopedQuery<NotificationDbRow>(
    tenantId,
    `SELECT ${SELECT_COLS} FROM notifications WHERE ${where} ORDER BY created_at DESC LIMIT ${limitParam}`,
    params,
  );
  return rows.map(mapRow);
}

export async function getNotificationById(tenantId: number, id: number): Promise<NotificationRow | null> {
  if (!isValidId(id)) return null;
  const { rows } = await scopedQuery<NotificationDbRow>(
    tenantId,
    `SELECT ${SELECT_COLS} FROM notifications WHERE tenant_id = $1 AND id = $2`,
    [id],
  );
  const r = rows[0];
  return r ? mapRow(r) : null;
}
