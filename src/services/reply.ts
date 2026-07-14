import { getForward, setForwardStatus } from '../gatekeeper/repo.js';
import type { LockedForwarder } from '../gatekeeper/forwarder.js';
import { ensurePermission, withAudit, actorLabel, ServiceError, type ActorContext } from './index.js';

/**
 * sendReply — the human "release/send the gatekeeper forward" action. It invokes the
 * ONE send path (`src/gatekeeper/forwarder.ts`), which is bound to the single locked
 * recipient at construction. `sendReply` has NO recipient parameter: a caller can name
 * WHICH held forward to send, never WHERE it goes (send-lockdown, guarantee 2).
 */

export interface ReplyDeps {
  forwarder: LockedForwarder;
  resolveGmailMessageId: (messageId: number) => Promise<string | null>;
}

export async function defaultReplyDeps(tenantId: number): Promise<ReplyDeps> {
  const { config } = await import('../config.js');
  const { createLockedForwarder } = await import('../gatekeeper/forwarder.js');
  const { getGmailClient } = await import('../gmail/adapter.js');
  const { scopedQuery } = await import('../db/scoped.js');
  const cfg = config();
  const forwarder = createLockedForwarder(cfg.QBO_FORWARDING_ADDRESS, await getGmailClient(tenantId));
  return {
    forwarder,
    resolveGmailMessageId: async (messageId) => {
      const r = await scopedQuery<{ gmail_message_id: string }>(
        tenantId,
        'SELECT gmail_message_id FROM messages WHERE tenant_id=$1 AND id=$2',
        [messageId],
      );
      return r.rows[0]?.gmail_message_id ?? null;
    },
  };
}

export interface SendReplyResult {
  forwardId: number;
  to: string;
  sendId: string;
}

export async function sendReply(
  ctx: ActorContext,
  replyId: number,
  deps?: ReplyDeps,
): Promise<SendReplyResult> {
  ensurePermission(ctx, 'reply');
  return withAudit(
    ctx,
    'reply.send',
    `forward:${replyId}`,
    async () => {
      const fwd = await getForward(ctx.tenantId, replyId);
      if (!fwd) throw new ServiceError('reply_not_found', `reply ${replyId} not found`);
      const d = deps ?? (await defaultReplyDeps(ctx.tenantId));
      const gmailMessageId = await d.resolveGmailMessageId(fwd.message_id);
      if (!gmailMessageId) throw new ServiceError('source_message_missing', 'source message not found');
      // No recipient argument exists: the forwarder decides WHERE, we decide only WHICH.
      const sent = await d.forwarder.forward(gmailMessageId);
      await setForwardStatus(fwd.id, 'forwarded', { gmailSendId: sent.sendId, releasedBy: actorLabel(ctx) });
      return { forwardId: fwd.id, to: sent.to, sendId: sent.sendId };
    },
    (r) => ({ to: r.to }),
  );
}
