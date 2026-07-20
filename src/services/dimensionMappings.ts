import { withTransaction } from '../db/pool.js';
import * as store from '../mapping/dimensionMappingStore.js';
import { normalize } from '../mapping/resolve.js';
import { ensurePermission, withAudit, assertEntityId, isValidId, ServiceError, type ActorContext } from './index.js';

/**
 * F_DIMENSION_MAPPING_API — service layer for `dimension_mappings` / `dimension_mapping_rules`.
 * Every mutation:
 *   1. checks the `dimension_mapping` permission (owner_controller only, same as tax_mapping),
 *   2. runs inside one DB transaction (the row write),
 *   3. re-reads the row back from the DB (outside the transaction, via `scopedQuery`) and
 *      verifies it matches what was just written, BEFORE returning success — same
 *      fail-closed "never claim success without proof" pattern as `taxMappings.ts`.
 * `withAudit` appends the generic operational `audit_log` row. Migration 007 has no
 * `dimension_mapping_audit` table (unlike tax_mappings), so `audit_log.detail` (jsonb) is
 * the ONLY durable who/when/why/reason trail for these mutations — every reason string
 * threads into `detailOf` below rather than being dropped.
 *
 * Resolution states are NEVER guessed or collapsed: only `accept` and `select-alternate`
 * ever move `resolution_state` to 'mapped' (because only those attach a caller-confirmed
 * provider_id); `correct`, `reject`, and `held` leave `resolution_state` exactly as the
 * extraction pipeline computed it.
 */

const DIMENSION_TYPES = new Set<store.DimensionType>([
  'account', 'item', 'class', 'location', 'department', 'customer',
  'project', 'job', 'tracking_category', 'entity', 'tax_code', 'currency',
]);
const REVIEW_STATUSES = new Set<store.ReviewStatus>(['pending', 'accepted', 'corrected', 'rejected', 'held']);
const RESOLUTION_STATES = new Set<store.ResolutionState>([
  'mapped', 'not_provided', 'not_mapped', 'unsupported_by_provider', 'intentionally_blank',
]);

function assertNonEmptyString(v: unknown, field: string): string {
  if (typeof v !== 'string' || v.trim() === '') {
    throw new ServiceError('VALIDATION', `${field} is required`);
  }
  return v.trim();
}

function assertReason(v: unknown): string {
  if (typeof v !== 'string' || v.trim() === '') {
    throw new ServiceError('VALIDATION', 'reason is required');
  }
  return v.trim();
}

function assertDimensionType(v: unknown): store.DimensionType {
  const s = assertNonEmptyString(v, 'dimensionType');
  if (!DIMENSION_TYPES.has(s as store.DimensionType)) throw new ServiceError('VALIDATION', `invalid dimensionType '${s}'`);
  return s as store.DimensionType;
}

function assertReviewStatus(v: unknown): store.ReviewStatus {
  const s = assertNonEmptyString(v, 'reviewStatus');
  if (!REVIEW_STATUSES.has(s as store.ReviewStatus)) throw new ServiceError('VALIDATION', `invalid reviewStatus '${s}'`);
  return s as store.ReviewStatus;
}

function assertResolutionState(v: unknown): store.ResolutionState {
  const s = assertNonEmptyString(v, 'resolutionState');
  if (!RESOLUTION_STATES.has(s as store.ResolutionState)) throw new ServiceError('VALIDATION', `invalid resolutionState '${s}'`);
  return s as store.ResolutionState;
}

/** Post-write read-back verification: re-fetch from the DB and assert the expectation holds. */
async function verifyReadBack(
  tenantId: number,
  id: number,
  check: (row: store.DimensionMappingRow) => boolean,
  context: string,
): Promise<store.DimensionMappingRow> {
  const row = await store.getDimensionMappingById(tenantId, id);
  if (!row || !check(row)) {
    throw new ServiceError('read_back_failed', `post-write read-back verification failed (${context})`);
  }
  return row;
}

async function verifyRuleReadBack(
  tenantId: number,
  id: number,
  check: (row: store.DimensionMappingRuleRow) => boolean,
  context: string,
): Promise<store.DimensionMappingRuleRow> {
  const row = await store.getDimensionMappingRuleById(tenantId, id);
  if (!row || !check(row)) {
    throw new ServiceError('read_back_failed', `post-write read-back verification failed (${context})`);
  }
  return row;
}

// --- reads ----------------------------------------------------------------------------------

export interface ListDimensionMappingsInput {
  connectionId?: number;
  dimensionType?: string;
  reviewStatus?: string;
  resolutionState?: string;
  provider?: string;
}

export async function listDimensionMappings(
  ctx: ActorContext,
  input: ListDimensionMappingsInput,
): Promise<store.DimensionMappingRow[]> {
  ensurePermission(ctx, 'dimension_mapping');
  const opts: store.ListDimensionMappingsOpts = {
    connectionId: input.connectionId,
    provider: input.provider,
    dimensionType: input.dimensionType !== undefined ? assertDimensionType(input.dimensionType) : undefined,
    reviewStatus: input.reviewStatus !== undefined ? assertReviewStatus(input.reviewStatus) : undefined,
    resolutionState: input.resolutionState !== undefined ? assertResolutionState(input.resolutionState) : undefined,
  };
  return store.listDimensionMappings(ctx.tenantId, opts);
}

export async function getDimensionMapping(ctx: ActorContext, id: number): Promise<store.DimensionMappingRow | null> {
  ensurePermission(ctx, 'dimension_mapping');
  if (!isValidId(id)) return null;
  return store.getDimensionMappingById(ctx.tenantId, id);
}

// --- accept -----------------------------------------------------------------------------------

export interface AcceptDimensionMappingInput {
  reason?: string;
}

export async function acceptDimensionMapping(
  ctx: ActorContext,
  id: number,
  input: AcceptDimensionMappingInput,
): Promise<store.DimensionMappingRow> {
  ensurePermission(ctx, 'dimension_mapping');
  assertEntityId(id);

  return withAudit(
    ctx,
    'dimension_mapping.accept',
    `dimension_mapping:${id}`,
    async () => {
      const updated = await withTransaction(async (client) => {
        const existing = await store.getDimensionMappingByIdTx(client, ctx.tenantId, id);
        if (!existing) throw new ServiceError('dimension_mapping_not_found', `dimension mapping ${id} not found`);
        if (!existing.proposedProviderId) {
          throw new ServiceError('VALIDATION', 'this mapping has no proposed_provider_id to accept');
        }
        const row = await store.resolveDimensionMappingTx(client, ctx.tenantId, id, {
          providerId: existing.proposedProviderId,
          mappingMethod: 'exact',
        });
        if (!row) throw new ServiceError('dimension_mapping_not_found', `dimension mapping ${id} not found`);
        return row;
      });
      return verifyReadBack(
        ctx.tenantId,
        updated.id,
        (r) => r.reviewStatus === 'accepted' && r.providerId === updated.providerId && r.resolutionState === 'mapped',
        'accept',
      );
    },
    (r) => ({ id: r.id, providerId: r.providerId, reviewStatus: r.reviewStatus, reason: input.reason ?? null }),
  );
}

// --- select-alternate ---------------------------------------------------------------------------

/** Re-runs provider discovery for a caller-chosen alternate (by id or by label). Injectable for testability. */
export type DimensionProviderValidator = (
  tenantId: number,
  connectionId: number,
  provider: string,
  dimensionType: string,
  choice: { providerId?: string; providerLabel?: string },
) => Promise<{ valid: boolean; providerId?: string; detail?: string }>;

export interface SelectAlternateDimensionMappingInput {
  providerId?: string;
  providerLabel?: string;
  reason?: string;
}

export async function selectAlternateDimensionMapping(
  ctx: ActorContext,
  id: number,
  input: SelectAlternateDimensionMappingInput,
  validate: DimensionProviderValidator,
): Promise<store.DimensionMappingRow> {
  ensurePermission(ctx, 'dimension_mapping');
  assertEntityId(id);
  if (!input.providerId && !input.providerLabel) {
    throw new ServiceError('VALIDATION', 'providerId or providerLabel is required');
  }

  return withAudit(
    ctx,
    'dimension_mapping.select_alternate',
    `dimension_mapping:${id}`,
    async () => {
      const existingOutside = await store.getDimensionMappingById(ctx.tenantId, id);
      if (!existingOutside) throw new ServiceError('dimension_mapping_not_found', `dimension mapping ${id} not found`);

      // Provider check happens OUTSIDE the transaction (network call) — never guess; a
      // failed/unmatched alternate fails closed (no row is changed).
      const result = await validate(ctx.tenantId, existingOutside.connectionId, existingOutside.provider, existingOutside.dimensionType, {
        providerId: input.providerId,
        providerLabel: input.providerLabel,
      });
      if (!result.valid || !result.providerId) {
        throw new ServiceError('VALIDATION', result.detail ?? 'alternate provider value failed validation');
      }

      const updated = await withTransaction(async (client) => {
        const existing = await store.getDimensionMappingByIdTx(client, ctx.tenantId, id);
        if (!existing) throw new ServiceError('dimension_mapping_not_found', `dimension mapping ${id} not found`);
        const row = await store.resolveDimensionMappingTx(client, ctx.tenantId, id, {
          providerId: result.providerId!,
          mappingMethod: 'manual',
        });
        if (!row) throw new ServiceError('dimension_mapping_not_found', `dimension mapping ${id} not found`);
        return row;
      });
      return verifyReadBack(
        ctx.tenantId,
        updated.id,
        (r) => r.reviewStatus === 'accepted' && r.providerId === result.providerId && r.resolutionState === 'mapped',
        'select-alternate',
      );
    },
    (r) => ({ id: r.id, providerId: r.providerId, reason: input.reason ?? null }),
  );
}

// --- correct -------------------------------------------------------------------------------

export interface CorrectDimensionMappingInput {
  normalizedValue: string;
  reason?: string;
}

export async function correctDimensionMapping(
  ctx: ActorContext,
  id: number,
  input: CorrectDimensionMappingInput,
): Promise<store.DimensionMappingRow> {
  ensurePermission(ctx, 'dimension_mapping');
  assertEntityId(id);
  const normalizedValue = assertNonEmptyString(input.normalizedValue, 'normalizedValue');

  return withAudit(
    ctx,
    'dimension_mapping.correct',
    `dimension_mapping:${id}`,
    async () => {
      const updated = await withTransaction(async (client) => {
        const existing = await store.getDimensionMappingByIdTx(client, ctx.tenantId, id);
        if (!existing) throw new ServiceError('dimension_mapping_not_found', `dimension mapping ${id} not found`);
        const row = await store.updateCorrectTx(client, ctx.tenantId, id, normalizedValue);
        if (!row) throw new ServiceError('dimension_mapping_not_found', `dimension mapping ${id} not found`);
        return row;
      });
      return verifyReadBack(
        ctx.tenantId,
        updated.id,
        (r) => r.reviewStatus === 'corrected' && r.normalizedValue === normalizedValue,
        'correct',
      );
    },
    (r) => ({ id: r.id, normalizedValue: r.normalizedValue, reason: input.reason ?? null }),
  );
}

// --- save-rule -----------------------------------------------------------------------------

export interface SaveDimensionMappingRuleInput {
  reason?: string;
}

export async function saveDimensionMappingRule(
  ctx: ActorContext,
  id: number,
  input: SaveDimensionMappingRuleInput,
): Promise<store.DimensionMappingRuleRow> {
  ensurePermission(ctx, 'dimension_mapping');
  assertEntityId(id);

  return withAudit(
    ctx,
    'dimension_mapping.save_rule',
    `dimension_mapping:${id}`,
    async () => {
      const created = await withTransaction(async (client) => {
        const existing = await store.getDimensionMappingByIdTx(client, ctx.tenantId, id);
        if (!existing) throw new ServiceError('dimension_mapping_not_found', `dimension mapping ${id} not found`);
        if (!existing.providerId) {
          throw new ServiceError('VALIDATION', 'mapping must have a resolved provider_id before saving a rule');
        }
        const normalizedValue = existing.normalizedValue ?? normalize(existing.rawValue);
        if (!normalizedValue) {
          throw new ServiceError('VALIDATION', 'unable to derive a normalized value for this rule');
        }
        const activeRule = await store.findActiveRuleTx(
          client, ctx.tenantId, existing.connectionId, existing.provider, existing.dimensionType, normalizedValue,
        );
        if (activeRule) {
          throw new ServiceError('VALIDATION', 'an active rule already exists for this normalized value in this company');
        }
        return store.insertDimensionMappingRuleTx(client, {
          tenantId: ctx.tenantId,
          connectionId: existing.connectionId,
          provider: existing.provider,
          dimensionType: existing.dimensionType,
          normalizedValue,
          rawValue: existing.rawValue,
          providerId: existing.providerId,
          providerLabel: existing.proposedMatchLabel ?? null,
          mappingMethod: existing.mappingMethod ?? 'manual',
          createdFromId: existing.id,
        });
      });
      return verifyRuleReadBack(
        ctx.tenantId,
        created.id,
        (r) => r.active === true && r.providerId === created.providerId && r.createdFromId === id,
        'save-rule',
      );
    },
    (r) => ({
      id: r.id, connectionId: r.connectionId, dimensionType: r.dimensionType,
      normalizedValue: r.normalizedValue, providerId: r.providerId, reason: input.reason ?? null,
    }),
  );
}

// --- reject / hold ---------------------------------------------------------------------------

export interface RejectDimensionMappingInput {
  status: 'rejected' | 'held';
  reason: string;
}

export async function rejectDimensionMapping(
  ctx: ActorContext,
  id: number,
  input: RejectDimensionMappingInput,
): Promise<store.DimensionMappingRow> {
  ensurePermission(ctx, 'dimension_mapping');
  assertEntityId(id);
  if (input.status !== 'rejected' && input.status !== 'held') {
    throw new ServiceError('VALIDATION', "status must be 'rejected' or 'held'");
  }
  const reason = assertReason(input.reason);

  return withAudit(
    ctx,
    `dimension_mapping.${input.status}`,
    `dimension_mapping:${id}`,
    async () => {
      const updated = await withTransaction(async (client) => {
        const existing = await store.getDimensionMappingByIdTx(client, ctx.tenantId, id);
        if (!existing) throw new ServiceError('dimension_mapping_not_found', `dimension mapping ${id} not found`);
        const row = await store.updateReviewStatusTx(client, ctx.tenantId, id, input.status);
        if (!row) throw new ServiceError('dimension_mapping_not_found', `dimension mapping ${id} not found`);
        return row;
      });
      return verifyReadBack(ctx.tenantId, updated.id, (r) => r.reviewStatus === input.status, input.status);
    },
    (r) => ({ id: r.id, reviewStatus: r.reviewStatus, reason }),
  );
}
