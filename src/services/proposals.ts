import { scopedQuery } from '../db/scoped.js';
import { raiseException } from '../exceptions.js';
import type { PostDeps } from '../pipeline/posting.js';
import { defaultPostDeps, runPostAndMap, type ApproveResult } from './approve.js';
import { ensurePermission, withAudit, ServiceError, assertEntityId, type ActorContext } from './index.js';
import { assertNotDryRunLocked } from './onboarding.js';

/**
 * Proposal lifecycle actions other than approve. `rejectProposal` marks a proposal
 * rejected (optionally recording a duplicate exception); `retryProposal` re-posts via
 * the SAME idempotency key through the shared posting path — a safe, idempotent re-post.
 */

export interface RejectResult {
  proposalId: number;
  status: 'rejected';
}

export async function rejectProposal(
  ctx: ActorContext,
  proposalId: number,
  opts: { reason: string; markDuplicate?: boolean },
): Promise<RejectResult> {
  assertEntityId(proposalId);
  ensurePermission(ctx, 'reject');
  return withAudit(
    ctx,
    'proposal.reject',
    `proposal:${proposalId}`,
    async () => {
      const res = await scopedQuery(
        ctx.tenantId,
        "UPDATE proposals SET status='rejected' WHERE tenant_id=$1 AND id=$2 RETURNING id",
        [proposalId],
      );
      if (res.rowCount === 0) throw new ServiceError('proposal_not_found', `proposal ${proposalId} not found`);
      if (opts.markDuplicate) {
        await raiseException({
          tenantId: ctx.tenantId,
          reasonCode: 'duplicate',
          entityRef: `proposal:${proposalId}`,
          detail: opts.reason,
        });
      }
      return { proposalId, status: 'rejected' as const };
    },
    () => ({ reason: opts.reason, markDuplicate: Boolean(opts.markDuplicate) }),
  );
}

export async function retryProposal(
  ctx: ActorContext,
  proposalId: number,
  deps?: PostDeps,
): Promise<ApproveResult> {
  assertEntityId(proposalId);
  ensurePermission(ctx, 'retry');
  return withAudit(
    ctx,
    'proposal.retry',
    `proposal:${proposalId}`,
    async () => {
      // CHUNK_6_ONBOARDING: DRY_RUN_LOCKED — no post while automation_level is 'off'.
      await assertNotDryRunLocked(ctx.tenantId);
      const postDeps = deps ?? (await defaultPostDeps(ctx.tenantId));
      return runPostAndMap(ctx.tenantId, proposalId, postDeps);
    },
    (r) => ({ result: r.status, ...(r.status === 'posted' ? { qboId: r.qboId } : {}) }),
  );
}
