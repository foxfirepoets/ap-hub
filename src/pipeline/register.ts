import type PgBoss from 'pg-boss';
import type { Config } from '../config.js';
import { JOBS } from '../queue.js';
import { logger } from '../logger.js';
import type { PostJob } from './posting.js';

/**
 * Wires every pipeline job handler onto pg-boss. Each chunk contributes its jobs:
 * CHUNK_3 poll, CHUNK_4 gatekeep, CHUNK_5 classify/extract, CHUNK_6 map/propose,
 * CHUNK_7 post_sandbox + digest, CHUNK_8 audit_anchor.
 */

/**
 * HKO-audit HIGH finding (2026-07-15): the automatic propose->post_sandbox path
 * bypassed CHUNK_6's DRY_RUN_LOCKED guard, which was wired only into the manual
 * approveProposal/retryProposal service calls (src/services/approve.ts,
 * src/services/proposals.ts). Every post_sandbox job — manual or automatic —
 * funnels through this one job handler, so gating it here closes the automatic
 * path without touching pipeline/mapping.ts or pipeline/posting.ts (out of scope
 * for this UX build). Exported (rather than an inline boss.work closure) so it is
 * directly unit-testable.
 */
export async function guardedPostSandboxHandler(job: { data: PostJob }): Promise<void> {
  const { isDryRunLocked } = await import('../services/onboarding.js');
  const { postSandboxHandler } = await import('./posting.js');
  if (await isDryRunLocked(job.data.tenantId)) {
    const { raiseException } = await import('../exceptions.js');
    await raiseException({
      tenantId: job.data.tenantId,
      reasonCode: 'dry_run_locked',
      entityRef: `proposal:${job.data.proposalId}`,
      detail: 'auto-post skipped — onboarding automation_level is off',
    });
    logger.warn(
      { tenantId: job.data.tenantId, proposalId: job.data.proposalId },
      'post_sandbox skipped — DRY_RUN_LOCKED',
    );
    return;
  }
  return postSandboxHandler(job);
}

export async function registerPipelineJobs(boss: PgBoss, cfg: Config): Promise<void> {
  const { pollHandler, schedulePoll } = await import('./poll.js');
  const { gatekeepHandler } = await import('./gatekeep.js');
  const { classifyHandler, extractHandler } = await import('./extract.js');
  const { mapHandler, proposeHandler } = await import('./mapping.js');
  const { auditAnchorHandler, scheduleAuditAnchor } = await import('./audit-anchor.js');
  const { digestHandler, scheduleDigest } = await import('../services/digest.js');

  // pg-boss v10 requires each queue to be explicitly created before .work()/.send()/.schedule()
  // can target it (no more implicit auto-create on first use). createQueue is idempotent.
  for (const name of [
    JOBS.poll,
    JOBS.gatekeep,
    JOBS.classify,
    JOBS.extract,
    JOBS.map,
    JOBS.propose,
    JOBS.post_sandbox,
    JOBS.audit_anchor,
    JOBS.digest,
  ]) {
    await boss.createQueue(name);
  }

  await boss.work(JOBS.poll, (job: any) => pollHandler(job));
  await boss.work(JOBS.gatekeep, (job: any) => gatekeepHandler(job));
  await boss.work(JOBS.classify, (job: any) => classifyHandler(job));
  await boss.work(JOBS.extract, (job: any) => extractHandler(job));
  await boss.work(JOBS.map, (job: any) => mapHandler(job));
  await boss.work(JOBS.propose, (job: any) => proposeHandler(job));
  await boss.work(JOBS.post_sandbox, (job: any) => guardedPostSandboxHandler(job));
  await boss.work(JOBS.audit_anchor, (job: any) => auditAnchorHandler(job));
  await boss.work(JOBS.digest, (job: any) => digestHandler(job));

  await schedulePoll(boss, cfg);
  await scheduleAuditAnchor(boss);
  await scheduleDigest(boss);

  logger.info('pipeline jobs registered');
}
