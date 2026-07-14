import { scopedQuery } from '../db/scoped.js';
import { ensurePermission, withAudit, actorLabel, ServiceError, type ActorContext } from './index.js';

/**
 * Mapping + correction learning. `remapMapping` upserts a reusable `mappings` rule (the
 * resolver reads this on the next matching item). `learnCorrection` records a `corrections`
 * row — `became_rule=true` when the human chose "remember" — and, when a mapping payload is
 * supplied with remember, upserts the same `mappings` rule via the shared path (no second
 * write path).
 */

export interface RemapInput {
  kind: string; // vendor|account|class|location|project|item|customer
  sourceKey: string;
  targetQboType?: string;
  targetQboId?: string;
  targetName?: string;
  /** false = one-off (audited only); true/omitted = persist the rule. */
  remember?: boolean;
}

/** The single mappings-write path, shared by remap and learn-with-remember. */
async function upsertMapping(tenantId: number, input: RemapInput, learnedFrom: string): Promise<void> {
  await scopedQuery(
    tenantId,
    `INSERT INTO mappings (tenant_id, kind, source_key, target_qbo_type, target_qbo_id, target_name, learned_from)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (tenant_id, kind, source_key) DO UPDATE SET
       target_qbo_type=EXCLUDED.target_qbo_type,
       target_qbo_id=EXCLUDED.target_qbo_id,
       target_name=EXCLUDED.target_name,
       learned_from=EXCLUDED.learned_from,
       updated_at=now()`,
    [input.kind, input.sourceKey, input.targetQboType ?? null, input.targetQboId ?? null, input.targetName ?? null, learnedFrom],
  );
}

export interface RemapResult {
  kind: string;
  sourceKey: string;
  becameRule: boolean;
}

export async function remapMapping(ctx: ActorContext, input: RemapInput): Promise<RemapResult> {
  ensurePermission(ctx, 'remap');
  return withAudit(
    ctx,
    'mapping.remap',
    `mapping:${input.kind}:${input.sourceKey}`,
    async () => {
      const becameRule = input.remember !== false;
      if (becameRule) await upsertMapping(ctx.tenantId, input, `remap:${actorLabel(ctx)}`);
      return { kind: input.kind, sourceKey: input.sourceKey, becameRule };
    },
    (r) => ({ kind: r.kind, sourceKey: r.sourceKey, becameRule: r.becameRule }),
  );
}

export interface LearnInput {
  proposalId?: number;
  exceptionId?: number;
  field: string;
  newValue: string;
  /** true → correction.became_rule and (if `mapping` present) the mapping rule is upserted. */
  remember?: boolean;
  mapping?: RemapInput;
}

export interface LearnResult {
  correctionId: number;
  becameRule: boolean;
  ruleApplied: boolean;
}

export async function learnCorrection(ctx: ActorContext, input: LearnInput): Promise<LearnResult> {
  ensurePermission(ctx, 'learn');
  const entity = input.proposalId
    ? `proposal:${input.proposalId}`
    : input.exceptionId
      ? `exception:${input.exceptionId}`
      : `correction:${input.field}`;
  return withAudit(
    ctx,
    'correction.learn',
    entity,
    async () => {
      const becameRule = Boolean(input.remember);

      // Tenant-scope guard: a referenced proposal/exception must belong to this tenant.
      if (input.proposalId !== undefined) {
        const p = await scopedQuery(
          ctx.tenantId,
          'SELECT id FROM proposals WHERE tenant_id=$1 AND id=$2',
          [input.proposalId],
        );
        if (p.rowCount === 0) throw new ServiceError('proposal_not_found', `proposal ${input.proposalId} not found`);
      }

      const res = await scopedQuery<{ id: number }>(
        ctx.tenantId,
        `INSERT INTO corrections (tenant_id, proposal_id, exception_id, field, new_value, became_rule)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [input.proposalId ?? null, input.exceptionId ?? null, input.field, input.newValue, becameRule],
      );
      const correctionId = res.rows[0]!.id;

      let ruleApplied = false;
      if (becameRule && input.mapping) {
        await upsertMapping(ctx.tenantId, input.mapping, `correction:${correctionId}`);
        ruleApplied = true;
      }
      return { correctionId, becameRule, ruleApplied };
    },
    (r) => ({ becameRule: r.becameRule, ruleApplied: r.ruleApplied }),
  );
}
