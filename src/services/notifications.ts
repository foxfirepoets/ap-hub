import { scopedQuery } from '../db/scoped.js';
import { ensurePermission, withAudit, ServiceError, assertEntityId, type ActorContext } from './index.js';

/**
 * CHUNK_7_DIGEST — the one mutation this chunk owns: marking a notification read.
 * Any authenticated role holds the base `read` permission, so this is available to
 * all three roles; it is still audited (append-only `audit_log` row) per guardrail.
 */

export interface MarkReadResult {
  notificationId: number;
  readAt: string;
}

export async function markNotificationRead(ctx: ActorContext, notificationId: number): Promise<MarkReadResult> {
  ensurePermission(ctx, 'read');
  assertEntityId(notificationId);
  return withAudit(
    ctx,
    'notification.read',
    `notification:${notificationId}`,
    async () => {
      const res = await scopedQuery<{ id: number; read_at: Date }>(
        ctx.tenantId,
        `UPDATE notifications SET read_at = COALESCE(read_at, now())
         WHERE tenant_id = $1 AND id = $2
         RETURNING id, read_at`,
        [notificationId],
      );
      const row = res.rows[0];
      if (!row) throw new ServiceError('notification_not_found', `notification ${notificationId} not found`);
      return { notificationId: row.id, readAt: row.read_at.toISOString() };
    },
    (r) => ({ notificationId: r.notificationId, readAt: r.readAt }),
  );
}
