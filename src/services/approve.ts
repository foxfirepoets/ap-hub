import { query } from '../db/pool.js';
import { postOnce, type PostDeps, type PostResult } from '../pipeline/posting.js';
import { ensurePermission, withAudit, assertEntityId, type ActorContext } from './index.js';
import { assertNotDryRunLocked } from './onboarding.js';

/**
 * approveProposal — the human "approve → post to configured QBO" action. It routes through
 * the existing queue/posting path (`postOnce` → `src/qbo/write.ts`); no new
 * QBO-write code exists here. `postOnce` is idempotent and fail-safe: a SwarmSync outage
 * (missing/unavailable proof coverage) makes it return `held`, never fail-open.
 */

export interface ApprovePosted {
  status: 'posted';
  postingId: number;
  qboType: string;
  qboId: string;
  qboLink: string;
  mode: 'sandbox' | 'production';
}
export type ApproveResult =
  | ApprovePosted
  | { status: 'queued'; provider: 'qbd'; providerJobId: number }
  | { status: 'held'; reason: string }
  | { status: 'duplicate' }
  | { status: 'skipped'; reason: string };

/** Build the real post dependencies from the composition roots (same wiring as the job). */
export async function defaultPostDeps(tenantId: number): Promise<PostDeps> {
  const { getQboConnector } = await import('../connectors/factory.js');
  const { swarmsync } = await import('../services.js');
  const { loadAttachmentBytes } = await import('../ingest/repo.js');
  const { config } = await import('../config.js');
  const cfg = config();
  const connector = await getQboConnector(tenantId);
  return {
    connector,
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
    accountingMode: cfg.QBO_ENV,
    expectedCompanyName: (cfg.QBO_ENV === 'production'
      ? cfg.QBO_PRODUCTION_COMPANY_NAME : cfg.QBO_SANDBOX_COMPANY_NAME).trim() || undefined,
    swarmSyncEnabled: cfg.SWARMSYNC_ENABLED,
  };
}

function qboLink(mode: 'sandbox' | 'production', realm: string, qboType: string, qboId: string): string {
  const host = mode === 'production' ? 'https://app.qbo.intuit.com' : 'https://app.sandbox.qbo.intuit.com';
  return `${host}/app/${qboType.toLowerCase()}?txnId=${qboId}&realm=${realm}`;
}

/**
 * Run the single posting path and shape the result (adds the environment-correct QBO link). Shared
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
  const mode = deps.accountingMode ?? 'sandbox';
  return {
    status: 'posted',
    postingId: row?.id ?? res.postingId,
    qboType,
    qboId,
    qboLink: qboLink(mode, deps.connector.companyId, qboType, qboId),
    mode,
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
      // CHUNK_6_ONBOARDING: DRY_RUN_LOCKED — no post while automation_level is 'off'.
      await assertNotDryRunLocked(ctx.tenantId);
      if (!deps) {
        const { activeQbdConnection, enqueueApprovedQbdBill } = await import('../qbdesktop/production.js');
        if (await activeQbdConnection(ctx.tenantId)) {
          const queued = await enqueueApprovedQbdBill(ctx.tenantId, proposalId);
          return { ...queued, provider: 'qbd' as const };
        }
      }
      const postDeps = deps ?? (await defaultPostDeps(ctx.tenantId));
      return runPostAndMap(ctx.tenantId, proposalId, postDeps);
    },
    (r) => ({ result: r.status, ...(r.status === 'posted' ? { qboId: r.qboId, postingId: r.postingId } : {}) }),
  );
}
