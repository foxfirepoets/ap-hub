import { config } from '../config.js';
import { gatekeepOnce, type GatekeepOutcome } from '../gatekeeper/gatekeep.js';
import { createLockedForwarder } from '../gatekeeper/forwarder.js';
import { createTelegramSender } from '../gatekeeper/telegram.js';
import { swarmsync } from '../services.js';
import { getSwarmSyncPolicyForTenant } from '../accounting/swarmsync-policy.js';

export interface GatekeepJob {
  tenantId: number;
  messageId: number;
}

export async function gatekeepHandler(job: { data: GatekeepJob }): Promise<GatekeepOutcome> {
  const cfg = config();
  if (!cfg.GATEKEEPER_ENABLED) return { action: 'noop' };

  // SwarmSync off: policy-aware (architecture-decision-packet §5). The gatekeeper's
  // whole job is the InvoiceProof scan, so with SwarmSync disabled there is nothing to
  // scan against. Whether that is fine or must hold depends on the company's own
  // swarmSyncPolicy, not SwarmSync's availability alone: 'optional' (default) → clean
  // noop, no fail-open forward (rule 1). 'required' → the scan is unavailable, so the
  // message must hold rather than silently forward unscanned (rule 2); reused below via
  // gatekeepOnce's own existing scan-failure hold path (proof_scan_unavailable) instead
  // of inventing a new outcome shape.
  let requiredButUnavailable = false;
  if (!cfg.SWARMSYNC_ENABLED) {
    const policy = await getSwarmSyncPolicyForTenant(job.data.tenantId);
    if (policy !== 'required') return { action: 'noop' };
    requiredButUnavailable = true;
  }

  const { getGmailClient } = await import('../gmail/adapter.js');
  const gmail = await getGmailClient(job.data.tenantId);
  const forwarder = createLockedForwarder(cfg.QBO_FORWARDING_ADDRESS, gmail);
  const telegram = createTelegramSender({
    botToken: cfg.TELEGRAM_BOT_TOKEN,
    chatId: cfg.TELEGRAM_CHAT_ID,
  });

  return gatekeepOnce(job.data.tenantId, job.data.messageId, {
    scan: requiredButUnavailable
      ? async () => {
          throw new Error('SwarmSync is disabled but this company\'s policy requires verification');
        }
      : (input) => swarmsync().scanInvoices(input),
    forwarder,
    telegram,
  });
}
