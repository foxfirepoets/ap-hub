import { config } from '../config.js';
import { gatekeepOnce, type GatekeepOutcome } from '../gatekeeper/gatekeep.js';
import { createLockedForwarder } from '../gatekeeper/forwarder.js';
import { createTelegramSender } from '../gatekeeper/telegram.js';
import { swarmsync } from '../services.js';

export interface GatekeepJob {
  tenantId: number;
  messageId: number;
}

export async function gatekeepHandler(job: { data: GatekeepJob }): Promise<GatekeepOutcome> {
  const cfg = config();
  if (!cfg.GATEKEEPER_ENABLED) return { action: 'noop' };

  const { getGmailClient } = await import('../gmail/adapter.js');
  const gmail = await getGmailClient(job.data.tenantId);
  const forwarder = createLockedForwarder(cfg.QBO_FORWARDING_ADDRESS, gmail);
  const telegram = createTelegramSender({
    botToken: cfg.TELEGRAM_BOT_TOKEN,
    chatId: cfg.TELEGRAM_CHAT_ID,
  });

  return gatekeepOnce(job.data.tenantId, job.data.messageId, {
    scan: (input) => swarmsync().scanInvoices(input),
    forwarder,
    telegram,
  });
}
