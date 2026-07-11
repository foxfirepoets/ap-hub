import type { GmailClient } from '../gmail/client.js';
import { GmailAuthError } from '../gmail/client.js';
import { persistMessage, setTenantHistoryId, getTenantHistoryId } from './repo.js';
import { JOBS } from '../queue.js';
import { writeAudit } from '../audit.js';
import { raiseException } from '../exceptions.js';
import { logger } from '../logger.js';

/**
 * CHUNK_3 poll cycle. Incremental via historyId; dedup on gmail_message_id; each new
 * message enqueues a `classify` job and (when the gatekeeper is enabled) a `gatekeep`
 * job. Gmail access is READ-ONLY here. Idempotent: re-polling creates no duplicates.
 */

export interface PollDeps {
  gmail: GmailClient;
  enqueue: (job: string, data: unknown) => Promise<void>;
  gatekeeperEnabled: boolean;
  pauseTenant: (tenantId: number) => Promise<void>;
}

export interface PollResult {
  newMessages: number;
  attachments: number;
  enqueuedClassify: number;
  enqueuedGatekeep: number;
}

export async function ingestOnce(tenantId: number, deps: PollDeps): Promise<PollResult> {
  const startHistory = await getTenantHistoryId(tenantId);
  const result: PollResult = {
    newMessages: 0,
    attachments: 0,
    enqueuedClassify: 0,
    enqueuedGatekeep: 0,
  };

  let history;
  try {
    history = await deps.gmail.listHistory(startHistory);
  } catch (err) {
    if (err instanceof GmailAuthError) {
      await raiseException({
        tenantId,
        reasonCode: 'auth_failure',
        entityRef: 'gmail',
        detail: err.message,
      });
      await deps.pauseTenant(tenantId);
      return result;
    }
    throw err;
  }

  for (const header of history.messages) {
    let full;
    try {
      full = await deps.gmail.getMessage(header.id);
    } catch (err) {
      if (err instanceof GmailAuthError) {
        await raiseException({ tenantId, reasonCode: 'auth_failure', entityRef: 'gmail', detail: err.message });
        await deps.pauseTenant(tenantId);
        return result;
      }
      throw err;
    }

    const ingested = await persistMessage(tenantId, full);
    if (!ingested.isNew) continue;

    result.newMessages += 1;
    result.attachments += ingested.attachmentIds.length;

    await deps.enqueue(JOBS.classify, { tenantId, messageId: ingested.messageId });
    result.enqueuedClassify += 1;

    if (deps.gatekeeperEnabled) {
      await deps.enqueue(JOBS.gatekeep, { tenantId, messageId: ingested.messageId });
      result.enqueuedGatekeep += 1;
    }

    await writeAudit({
      tenantId,
      action: 'ingest.message',
      entity: `message:${ingested.messageId}`,
      detail: { attachments: ingested.attachmentIds.length, bodyOnly: ingested.bodyOnly },
    });
  }

  if (history.newHistoryId) {
    await setTenantHistoryId(tenantId, history.newHistoryId);
  }
  return result;
}

/** Resolve real dependencies and run one poll cycle for a tenant. */
export async function runPollCycle(tenantId: number): Promise<PollResult> {
  const { config } = await import('../config.js');
  const { getGmailClient } = await import('../gmail/adapter.js');
  const { getQueue } = await import('../queue.js');
  const { query } = await import('../db/pool.js');

  const cfg = config();
  const gmail = await getGmailClient(tenantId);
  return ingestOnce(tenantId, {
    gmail,
    gatekeeperEnabled: cfg.GATEKEEPER_ENABLED,
    enqueue: async (job, data) => {
      await getQueue().send(job, data as object);
    },
    pauseTenant: async (id) => {
      await query('UPDATE tenants SET paused=true WHERE id=$1', [id]);
      logger.warn({ tenantId: id }, 'tenant paused due to auth failure');
    },
  });
}
