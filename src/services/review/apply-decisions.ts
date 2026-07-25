import { scopedQuery } from '../../db/scoped.js';
import type { PostDeps } from '../../pipeline/posting.js';
import { approveProposal, defaultPostDeps } from '../approve.js';
import { rejectProposal } from '../proposals.js';
import { isValidId, type ActorContext } from '../index.js';

/**
 * CHUNK_8_REVIEWDASH — replay layer. Applies a reviewer's exported decisions
 * ONLY through the existing guarded services (`approveProposal` → postOnce →
 * src/qbo/write.ts sandbox; `rejectProposal`). No second write path is ever
 * created here — this file calls into ../approve.js and ../proposals.js and
 * nothing else touches the DB write surface.
 *
 * Every decision id is resolved under the caller's tenant via `scopedQuery`
 * BEFORE any action runs: a foreign-tenant id (or an id that does not exist)
 * is skipped, never applied. `approved` items already `posted_sandbox` (a
 * replay of the same file) are idempotent no-ops — postOnce's own status gate
 * makes zero additional postings; that is reported as "already posted", not
 * as an error. Any other `held` outcome (e.g. missing proof coverage) is a
 * genuine failure to post safely and is surfaced as an error, driving a
 * non-zero CLI exit.
 */

export type DecisionValue = 'approved' | 'rejected' | 'pending' | (string & {});

/**
 * `id` accepts a number or a numeric string — a real decisions.json exported
 * from the dashboard always carries a JSON number, but ids threaded through the
 * DB layer (bigint columns) arrive as strings; both are validated identically
 * via `isValidId` (src/services/index.ts), matching the read/action layers.
 */
export interface Decision {
  id: number | string;
  decision: DecisionValue;
  finding?: string;
}

export interface DecisionsFile {
  run?: string;
  tenant?: number;
  exported?: string;
  summary?: unknown;
  decisions: Decision[];
}

export interface ApplyResultError {
  id: number | string;
  reason: string;
}

export interface ApplyDecisionsResult {
  approved_posted: number;
  approved_held: number;
  rejected: number;
  skipped: number;
  errors: ApplyResultError[];
}

/** True when a proposal is already posted — postOnce's own idempotency gate. */
function isAlreadyPostedHold(reason: string): boolean {
  return reason === 'status=posted_sandbox' || reason === 'status=posted';
}

export async function applyDecisions(
  ctx: ActorContext,
  file: DecisionsFile,
  deps?: PostDeps,
): Promise<ApplyDecisionsResult> {
  const result: ApplyDecisionsResult = {
    approved_posted: 0,
    approved_held: 0,
    rejected: 0,
    skipped: 0,
    errors: [],
  };
  // Lazy + cached: only ever built if an `approved` decision is actually reached,
  // so a reject-only (or all-skipped) replay never requires a connected QBO writer.
  let postDeps: PostDeps | undefined = deps;
  async function getPostDeps(): Promise<PostDeps> {
    if (!postDeps) postDeps = await defaultPostDeps(ctx.tenantId);
    return postDeps;
  }

  for (const decision of file.decisions ?? []) {
    if (!isValidId(decision.id)) {
      result.skipped += 1;
      continue;
    }

    // Resolve every id under the CALLER's tenant scope before doing anything —
    // an id belonging to another tenant (or that does not exist) never resolves.
    const owned = (
      await scopedQuery<{ id: number }>(
        ctx.tenantId,
        'SELECT id FROM proposals WHERE tenant_id = $1 AND id = $2',
        [decision.id],
      )
    ).rows[0];
    if (!owned) {
      result.skipped += 1;
      continue;
    }

    const proposalId = Number(decision.id);
    if (decision.decision === 'approved') {
      const res = await approveProposal(ctx, proposalId, await getPostDeps());
      if (res.status === 'posted' || res.status === 'duplicate') {
        result.approved_posted += 1;
      } else if (res.status === 'held') {
        if (isAlreadyPostedHold(res.reason)) {
          result.approved_posted += 1; // idempotent replay — zero additional postings
        } else {
          result.approved_held += 1;
          result.errors.push({ id: decision.id, reason: res.reason });
        }
      } else {
        result.errors.push({ id: decision.id, reason: res.status === 'skipped' ? res.reason : res.status });
      }
    } else if (decision.decision === 'rejected') {
      await rejectProposal(ctx, proposalId, { reason: decision.finding ?? 'reviewer rejected' });
      result.rejected += 1;
    } else {
      // pending / unknown → skip, no write
      result.skipped += 1;
    }
  }

  return result;
}
