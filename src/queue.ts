import PgBoss from 'pg-boss';
import { logger } from './logger.js';

/**
 * pg-boss job queue wrapper. Rides the same Postgres as the system of record, so
 * the next job can be enqueued in the same transaction that writes extracted data —
 * which is what makes idempotency actually hold. Provides retries, backoff, and DLQ.
 */

let boss: PgBoss | null = null;

export async function startQueue(connectionString: string): Promise<PgBoss> {
  if (boss) return boss;
  boss = new PgBoss({ connectionString, retryLimit: 3, retryBackoff: true });
  boss.on('error', (err) => logger.error({ err: String(err) }, 'pg-boss error'));
  await boss.start();
  return boss;
}

export function getQueue(): PgBoss {
  if (!boss) throw new Error('queue not started — call startQueue() first');
  return boss;
}

export async function stopQueue(): Promise<void> {
  if (boss) {
    await boss.stop({ graceful: true });
    boss = null;
  }
}

export const JOBS = {
  poll: 'poll',
  gatekeep: 'gatekeep',
  classify: 'classify',
  extract: 'extract',
  map: 'map',
  propose: 'propose',
  post_sandbox: 'post_sandbox',
  audit_anchor: 'audit_anchor',
  noop: 'noop',
} as const;
