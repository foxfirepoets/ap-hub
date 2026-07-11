import type PgBoss from 'pg-boss';
import type { Config } from '../config.js';
import { JOBS } from '../queue.js';

// Real implementation lands in CHUNK_3_INGEST. Signature is stable so register.ts
// and tests can depend on it now.
export interface PollJob {
  tenantId: number;
}

export async function pollHandler(_job: { data: PollJob }): Promise<void> {
  const { runPollCycle } = await import('../ingest/poll-cycle.js');
  await runPollCycle(_job.data.tenantId);
}

export async function schedulePoll(boss: PgBoss, cfg: Config): Promise<void> {
  const { query } = await import('../db/pool.js');
  const { rows } = await query<{ id: number }>('SELECT id FROM tenants WHERE paused=false');
  const everyMinutes = Math.max(1, Math.round(cfg.POLL_INTERVAL_SECONDS / 60));
  for (const t of rows) {
    await boss.schedule(JOBS.poll, `*/${everyMinutes} * * * *`, { tenantId: t.id });
  }
}
