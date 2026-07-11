import { query } from '../db/pool.js';

/** forwards-table persistence (Phase 0.5). UNIQUE(tenant_id, sha256) is the double-forward guard. */

export interface ForwardRow {
  id: number;
  tenant_id: number;
  message_id: number;
  attachment_id: number | null;
  sha256: string | null;
  status: string;
  hold_reason: string | null;
  gmail_send_id: string | null;
  subject_tag: string;
  released_by: string | null;
}

export type ForwardStatus =
  | 'pending'
  | 'scanning'
  | 'held'
  | 'released'
  | 'forwarding'
  | 'forwarded'
  | 'failed';

/**
 * Insert-or-fetch the forward intent for a message. The UNIQUE(tenant_id, sha256)
 * constraint means a retry returns the existing row rather than creating a second.
 * Returns the row and whether it was freshly created.
 */
export async function upsertForwardIntent(input: {
  tenantId: number;
  messageId: number;
  attachmentId: number | null;
  sha256: string;
  subjectTag: string;
  status: ForwardStatus;
}): Promise<{ row: ForwardRow; created: boolean }> {
  const ins = await query<ForwardRow>(
    `INSERT INTO forwards (tenant_id, message_id, attachment_id, sha256, subject_tag, status)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (tenant_id, sha256) DO NOTHING
     RETURNING *`,
    [input.tenantId, input.messageId, input.attachmentId, input.sha256, input.subjectTag, input.status],
  );
  if (ins.rows[0]) return { row: ins.rows[0], created: true };

  const existing = await query<ForwardRow>(
    'SELECT * FROM forwards WHERE tenant_id=$1 AND sha256=$2',
    [input.tenantId, input.sha256],
  );
  return { row: existing.rows[0]!, created: false };
}

export async function setForwardStatus(
  id: number,
  status: ForwardStatus,
  extra: { holdReason?: string; gmailSendId?: string; releasedBy?: string; alerted?: boolean } = {},
): Promise<void> {
  await query(
    `UPDATE forwards SET status=$2,
       hold_reason = COALESCE($3, hold_reason),
       gmail_send_id = COALESCE($4, gmail_send_id),
       released_by = COALESCE($5, released_by),
       alerted_at = CASE WHEN $6 THEN now() ELSE alerted_at END,
       updated_at = now()
     WHERE id=$1`,
    [id, status, extra.holdReason ?? null, extra.gmailSendId ?? null, extra.releasedBy ?? null, extra.alerted ?? false],
  );
}

export async function markAlerted(id: number): Promise<void> {
  await query('UPDATE forwards SET alerted_at=now(), updated_at=now() WHERE id=$1', [id]);
}

export async function getForward(tenantId: number, id: number): Promise<ForwardRow | null> {
  const { rows } = await query<ForwardRow>('SELECT * FROM forwards WHERE tenant_id=$1 AND id=$2', [
    tenantId,
    id,
  ]);
  return rows[0] ?? null;
}

export async function listHeld(tenantId: number): Promise<ForwardRow[]> {
  const { rows } = await query<ForwardRow>(
    `SELECT * FROM forwards WHERE tenant_id=$1 AND status IN ('held','failed') ORDER BY id`,
    [tenantId],
  );
  return rows;
}
