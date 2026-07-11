import type PgBoss from 'pg-boss';
import type { Config } from '../config.js';
import { JOBS } from '../queue.js';
import { logger } from '../logger.js';

/**
 * Wires every pipeline job handler onto pg-boss. Each chunk contributes its jobs:
 * CHUNK_3 poll, CHUNK_4 gatekeep, CHUNK_5 classify/extract, CHUNK_6 map/propose,
 * CHUNK_7 post_sandbox, CHUNK_8 audit_anchor.
 */
export async function registerPipelineJobs(boss: PgBoss, cfg: Config): Promise<void> {
  const { pollHandler, schedulePoll } = await import('./poll.js');
  const { gatekeepHandler } = await import('./gatekeep.js');
  const { classifyHandler, extractHandler } = await import('./extract.js');
  const { mapHandler, proposeHandler } = await import('./mapping.js');
  const { postSandboxHandler } = await import('./posting.js');
  const { auditAnchorHandler, scheduleAuditAnchor } = await import('./audit-anchor.js');

  await boss.work(JOBS.poll, (job: any) => pollHandler(job));
  await boss.work(JOBS.gatekeep, (job: any) => gatekeepHandler(job));
  await boss.work(JOBS.classify, (job: any) => classifyHandler(job));
  await boss.work(JOBS.extract, (job: any) => extractHandler(job));
  await boss.work(JOBS.map, (job: any) => mapHandler(job));
  await boss.work(JOBS.propose, (job: any) => proposeHandler(job));
  await boss.work(JOBS.post_sandbox, (job: any) => postSandboxHandler(job));
  await boss.work(JOBS.audit_anchor, (job: any) => auditAnchorHandler(job));

  await schedulePoll(boss, cfg);
  await scheduleAuditAnchor(boss);

  logger.info('pipeline jobs registered');
}
