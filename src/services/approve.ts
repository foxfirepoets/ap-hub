import { query } from '../db/pool.js';
import { postOnce, type PostDeps, type PostResult } from '../pipeline/posting.js';
import { ensurePermission, withAudit, assertEntityId, type ActorContext } from './index.js';

/**
 * approveProposal — the human "approve → post to QBO sandbox" action. It routes through
 * the EXISTING propose/post_sandbox path (`postOnce` → `src/qbo/write.ts`); no new
 * QBO-write code exists here. `postOnce` is idempotent and fail-safe: a SwarmSync outage
 * (missing/unavailable proof coverage) makes it return `held`, never fail-open.
 */

export interface ApprovePosted {
  status: 'posted';
  postingId: number;
  qboType: string;
  qboId: string;
  qboLink: string;
  mode: 'sandbox';
}
export type ApproveResult =
  | ApprovePosted
  | { status: 'held'; reason: string }
  | { status: 'duplicate' }
  | { status: 'skipped'; reason: string };

/** Build the real post dependencies from the composition roots (same wiring as the job). */
export async function defaultPostDeps(tenantId: number): Promise<PostDeps> {
  const { getQboWriteClient } = await import('../qbo/write.js');
  const { swarmsync } = await import('../services.js');
  const { loadAttachmentBytes } = await import('../ingest/repo.js');
  const { config } = await import('../config.js');
  const cfg = config();
  const writer = await getQboWriteClient(tenantId);
  return {
    writer,
    anchor: (output) => swarmsync().auditProof(output),
    loadPdf: async (attachmentId) => {
      const sha = (
        await query<{ sha256: string }>(
          'SELECT sha256 FROM attachments WHERE tenant_id=$1 AND id=$2',
          [tenantId, attachmentId],
        )
      ).rows[0]?.sha256;
      return sha ? loadAttachmentBytes(sha) : null;
    },
    amountCeiling: cfg.AMOUNT_CEILING,
    autoThreshold: cfg.AUTO_THRESHOLD,
  };
}

function sandboxLink(realm: string, qboType: string, qboId: string): string {
  return `https://app.sandbox.qbo.intuit.com/app/${qboType.toLowerCase()}?txnId=${qboId}&realm=${realm}`;
}

/**
 * Run the single posting path and shape the result (adds the sandbox QBO link). Shared
 * by `approveProposal` and `retryProposal` so retry re-posts via the same idempotency key.
 */
export async function runPostAndMap(
  tenantId: number,
  proposalId: number,
  deps: PostDeps,
): Promise<ApproveResult> {
  const res: PostResult = await postOnce(tenantId, proposalId, deps);
  if (res.status !== 'posted') return res;
  const row = (
    await query<{ id: number; qbo_type: string | null; qbo_id: string | null }>(
      'SELECT id, qbo_type, qbo_id FROM postings WHERE tenant_id=$1 AND proposal_id=$2 ORDER BY id DESC LIMIT 1',
      [tenantId, proposalId],
    )
  ).rows[0];
  const qboType = row?.qbo_type ?? '';
  const qboId = row?.qbo_id ?? res.qboId;
  return {
    status: 'posted',
    postingId: row?.id ?? res.postingId,
    qboType,
    qboId,
    qboLink: sandboxLink(deps.writer.realm, qboType, qboId),
    mode: 'sandbox',
  };
}

export async function approveProposal(
  ctx: ActorContext,
  proposalId: number,
  deps?: PostDeps,
): Promise<ApproveResult> {
  assertEntityId(proposalId);
  ensurePermission(ctx, 'approve');
  return withAudit(
    ctx,
    'proposal.approve',
    `proposal:${proposalId}`,
    async () => {
      const postDeps = deps ?? (await defaultPostDeps(ctx.tenantId));
      return runPostAndMap(ctx.tenantId, proposalId, postDeps);
    },
    (r) => ({ result: r.status, ...(r.status === 'posted' ? { qboId: r.qboId, postingId: r.postingId } : {}) }),
  );
}
