import { withTransaction } from '../db/pool.js';
import * as store from '../mapping/taxMappingStore.js';
import { ensurePermission, withAudit, assertEntityId, isValidId, ServiceError, type ActorContext } from './index.js';

/**
 * F_TAX_MAPPING_API — service layer for `tax_mappings`. Every mutation:
 *   1. checks `tax_mapping` permission (owner_controller only — CLAUDE.md "Owner/admin-only"),
 *   2. runs inside one DB transaction (write + `tax_mapping_audit` row together),
 *   3. re-reads the row back from the DB (outside the transaction, via `scopedQuery`) and
 *      verifies it matches what was just written, BEFORE returning success — this app's
 *      fail-closed "nothing unscanned gets through" pattern applied to config writes: never
 *      claim success without proof the row actually persisted.
 * `withAudit` also appends the generic operational `audit_log` row (same as every other
 * mutation in this codebase); `tax_mapping_audit` is the domain-specific who/when/why/reason
 * trail the release spec requires.
 */

const TAX_MODES = new Set(['exclusive', 'inclusive']);
const APPLIES_AT = new Set(['invoice', 'line']);

function assertNonEmptyString(v: unknown, field: string): string {
  if (typeof v !== 'string' || v.trim() === '') {
    throw new ServiceError('VALIDATION', `${field} is required`);
  }
  return v.trim();
}

function assertTaxMode(v: unknown): store.TaxMode {
  const s = assertNonEmptyString(v, 'taxMode');
  if (!TAX_MODES.has(s)) throw new ServiceError('VALIDATION', "taxMode must be 'exclusive' or 'inclusive'");
  return s as store.TaxMode;
}

function assertAppliesAt(v: unknown): store.AppliesAt {
  if (v === undefined) return 'invoice';
  const s = assertNonEmptyString(v, 'appliesAt');
  if (!APPLIES_AT.has(s)) throw new ServiceError('VALIDATION', "appliesAt must be 'invoice' or 'line'");
  return s as store.AppliesAt;
}

function assertReason(v: unknown): string {
  if (typeof v !== 'string' || v.trim() === '') {
    throw new ServiceError('VALIDATION', 'reason is required');
  }
  return v.trim();
}

/** Post-write read-back verification: re-fetch from the DB and assert the expectation holds. */
async function verifyReadBack(
  tenantId: number,
  id: number,
  check: (row: store.TaxMappingRow) => boolean,
  context: string,
): Promise<store.TaxMappingRow> {
  const row = await store.getTaxMappingById(tenantId, id);
  if (!row || !check(row)) {
    throw new ServiceError('read_back_failed', `post-write read-back verification failed (${context})`);
  }
  return row;
}

// --- create -----------------------------------------------------------------------------

export interface CreateTaxMappingInput {
  connectionId: number;
  provider: string;
  providerTaxCode: string;
  internalTaxTreatment: string;
  taxMode: string;
  appliesAt?: string;
  reason?: string;
}

export async function createTaxMapping(ctx: ActorContext, input: CreateTaxMappingInput): Promise<store.TaxMappingRow> {
  ensurePermission(ctx, 'tax_mapping');
  assertEntityId(input.connectionId);
  const provider = assertNonEmptyString(input.provider, 'provider');
  const providerTaxCode = assertNonEmptyString(input.providerTaxCode, 'providerTaxCode');
  const internalTaxTreatment = assertNonEmptyString(input.internalTaxTreatment, 'internalTaxTreatment');
  const taxMode = assertTaxMode(input.taxMode);
  const appliesAt = assertAppliesAt(input.appliesAt);

  return withAudit(
    ctx,
    'tax_mapping.create',
    `tax_mapping:connection:${input.connectionId}:${provider}:${providerTaxCode}`,
    async () => {
      const created = await withTransaction(async (client) => {
        const belongs = await store.connectionBelongsToTenant(ctx.tenantId, input.connectionId);
        if (!belongs) throw new ServiceError('connection_not_found', 'connection not found for this tenant');
        const existing = await store.findActiveMappingTx(client, ctx.tenantId, input.connectionId, provider, providerTaxCode);
        if (existing) {
          throw new ServiceError('VALIDATION', 'an active mapping already exists for this provider tax code; use replace');
        }
        const row = await store.insertTaxMappingTx(client, {
          tenantId: ctx.tenantId,
          connectionId: input.connectionId,
          provider,
          providerTaxCode,
          internalTaxTreatment,
          taxMode,
          appliesAt,
          needsRevalidation: false,
        });
        await store.insertAuditRowTx(client, {
          tenantId: ctx.tenantId,
          taxMappingId: row.id,
          connectionId: input.connectionId,
          provider,
          changedBy: ctx.userId,
          action: 'create',
          reason: input.reason?.trim() || null,
        });
        return row;
      });
      return verifyReadBack(ctx.tenantId, created.id, (r) => r.active === true && r.providerTaxCode === providerTaxCode, 'create');
    },
    (r) => ({ id: r.id, provider: r.provider, providerTaxCode: r.providerTaxCode }),
  );
}

// --- edit -------------------------------------------------------------------------------

export interface EditTaxMappingInput {
  internalTaxTreatment?: string;
  taxMode?: string;
  appliesAt?: string;
  reason: string;
}

export async function editTaxMapping(ctx: ActorContext, id: number, input: EditTaxMappingInput): Promise<store.TaxMappingRow> {
  ensurePermission(ctx, 'tax_mapping');
  assertEntityId(id);
  const reason = assertReason(input.reason);

  return withAudit(
    ctx,
    'tax_mapping.edit',
    `tax_mapping:${id}`,
    async () => {
      const updated = await withTransaction(async (client) => {
        const existing = await store.getTaxMappingByIdTx(client, ctx.tenantId, id);
        if (!existing) throw new ServiceError('tax_mapping_not_found', `tax mapping ${id} not found`);
        if (!existing.active) throw new ServiceError('VALIDATION', 'cannot edit an inactive mapping; use replace');

        const internalTaxTreatment = input.internalTaxTreatment !== undefined
          ? assertNonEmptyString(input.internalTaxTreatment, 'internalTaxTreatment')
          : existing.internalTaxTreatment;
        const taxMode = input.taxMode !== undefined ? assertTaxMode(input.taxMode) : existing.taxMode;
        const appliesAt = input.appliesAt !== undefined ? assertAppliesAt(input.appliesAt) : existing.appliesAt;

        const row = await store.updateTaxMappingTx(client, ctx.tenantId, id, { internalTaxTreatment, taxMode, appliesAt });
        if (!row) throw new ServiceError('tax_mapping_not_found', `tax mapping ${id} not found`);
        await store.insertAuditRowTx(client, {
          tenantId: ctx.tenantId,
          taxMappingId: id,
          connectionId: existing.connectionId,
          provider: existing.provider,
          changedBy: ctx.userId,
          action: 'edit',
          reason,
        });
        return row;
      });
      return verifyReadBack(ctx.tenantId, updated.id, (r) => r.needsRevalidation === true, 'edit');
    },
    (r) => ({ id: r.id, needsRevalidation: r.needsRevalidation }),
  );
}

// --- disable ----------------------------------------------------------------------------

export async function disableTaxMapping(ctx: ActorContext, id: number, reasonInput: string): Promise<store.TaxMappingRow> {
  ensurePermission(ctx, 'tax_mapping');
  assertEntityId(id);
  const reason = assertReason(reasonInput);

  return withAudit(
    ctx,
    'tax_mapping.disable',
    `tax_mapping:${id}`,
    async () => {
      const updated = await withTransaction(async (client) => {
        const existing = await store.getTaxMappingByIdTx(client, ctx.tenantId, id);
        if (!existing) throw new ServiceError('tax_mapping_not_found', `tax mapping ${id} not found`);
        if (!existing.active) throw new ServiceError('VALIDATION', 'mapping is already inactive');
        const row = await store.disableTaxMappingTx(client, ctx.tenantId, id);
        if (!row) throw new ServiceError('tax_mapping_not_found', `tax mapping ${id} not found`);
        await store.insertAuditRowTx(client, {
          tenantId: ctx.tenantId,
          taxMappingId: id,
          connectionId: existing.connectionId,
          provider: existing.provider,
          changedBy: ctx.userId,
          action: 'disable',
          reason,
        });
        return row;
      });
      return verifyReadBack(ctx.tenantId, updated.id, (r) => r.active === false, 'disable');
    },
    (r) => ({ id: r.id, active: r.active }),
  );
}

// --- replace ----------------------------------------------------------------------------

export interface ReplaceTaxMappingInput {
  providerTaxCode?: string;
  internalTaxTreatment: string;
  taxMode: string;
  appliesAt?: string;
  reason: string;
}

export interface ReplaceTaxMappingResult {
  old: store.TaxMappingRow;
  replacement: store.TaxMappingRow;
}

export async function replaceTaxMapping(
  ctx: ActorContext,
  id: number,
  input: ReplaceTaxMappingInput,
): Promise<ReplaceTaxMappingResult> {
  ensurePermission(ctx, 'tax_mapping');
  assertEntityId(id);
  const reason = assertReason(input.reason);
  const internalTaxTreatment = assertNonEmptyString(input.internalTaxTreatment, 'internalTaxTreatment');
  const taxMode = assertTaxMode(input.taxMode);
  const appliesAt = assertAppliesAt(input.appliesAt);

  return withAudit(
    ctx,
    'tax_mapping.replace',
    `tax_mapping:${id}`,
    async () => {
      const { oldId, newId } = await withTransaction(async (client) => {
        const existing = await store.getTaxMappingByIdTx(client, ctx.tenantId, id);
        if (!existing) throw new ServiceError('tax_mapping_not_found', `tax mapping ${id} not found`);
        if (!existing.active) throw new ServiceError('VALIDATION', 'cannot replace an inactive mapping');
        const providerTaxCode = input.providerTaxCode ? assertNonEmptyString(input.providerTaxCode, 'providerTaxCode') : existing.providerTaxCode;

        // Disable old FIRST so the partial-unique-active index frees the slot before the
        // new active row (potentially with the same provider+providerTaxCode) is inserted;
        // then a second update stamps superseded_by_id/replaced_at once the new id exists.
        await store.disableTaxMappingTx(client, ctx.tenantId, id);
        const created = await store.insertTaxMappingTx(client, {
          tenantId: ctx.tenantId,
          connectionId: existing.connectionId,
          provider: existing.provider,
          providerTaxCode,
          internalTaxTreatment,
          taxMode,
          appliesAt,
          needsRevalidation: true,
        }).catch((err: unknown) => {
          // Same code as an already-active row (not this one) — surface as validation, not 500.
          throw new ServiceError('VALIDATION', `replace failed: ${(err as Error).message}`);
        });
        const superseded = await store.supersedeTaxMappingTx(client, ctx.tenantId, id, created.id);
        if (!superseded) throw new ServiceError('tax_mapping_not_found', `tax mapping ${id} not found`);

        await store.insertAuditRowTx(client, {
          tenantId: ctx.tenantId,
          taxMappingId: id,
          connectionId: existing.connectionId,
          provider: existing.provider,
          changedBy: ctx.userId,
          action: 'replace',
          reason: `${reason} (superseded by ${created.id})`,
        });
        await store.insertAuditRowTx(client, {
          tenantId: ctx.tenantId,
          taxMappingId: created.id,
          connectionId: existing.connectionId,
          provider: existing.provider,
          changedBy: ctx.userId,
          action: 'create',
          reason: `replacement for mapping ${id}: ${reason}`,
        });
        return { oldId: id, newId: created.id };
      });

      const oldRow = await verifyReadBack(ctx.tenantId, oldId, (r) => r.active === false && r.supersededById === newId, 'replace-old');
      const replacement = await verifyReadBack(ctx.tenantId, newId, (r) => r.active === true, 'replace-new');
      return { old: oldRow, replacement };
    },
    (r) => ({ oldId: r.old.id, newId: r.replacement.id }),
  );
}

// --- revalidate -------------------------------------------------------------------------

/** Checks whether a provider tax code is still valid/supported. Injectable for testability. */
export type ProviderCodeValidator = (
  tenantId: number,
  connectionId: number,
  provider: string,
  providerTaxCode: string,
) => Promise<{ valid: boolean; detail?: string }>;

export interface RevalidateTaxMappingInput {
  reason?: string;
}

export async function revalidateTaxMapping(
  ctx: ActorContext,
  id: number,
  input: RevalidateTaxMappingInput,
  validate: ProviderCodeValidator,
): Promise<store.TaxMappingRow> {
  ensurePermission(ctx, 'tax_mapping');
  assertEntityId(id);
  const reason = input.reason?.trim() || 'revalidation requested';

  return withAudit(
    ctx,
    'tax_mapping.revalidate',
    `tax_mapping:${id}`,
    async () => {
      const existingOutside = await store.getTaxMappingById(ctx.tenantId, id);
      if (!existingOutside) throw new ServiceError('tax_mapping_not_found', `tax mapping ${id} not found`);

      // Provider-code check happens OUTSIDE the transaction (it's a network call) —
      // never guess; an unreachable/unsupported code fails closed (active=false).
      const result = await validate(ctx.tenantId, existingOutside.connectionId, existingOutside.provider, existingOutside.providerTaxCode);

      const updated = await withTransaction(async (client) => {
        const existing = await store.getTaxMappingByIdTx(client, ctx.tenantId, id);
        if (!existing) throw new ServiceError('tax_mapping_not_found', `tax mapping ${id} not found`);
        const row = await store.setRevalidationOutcomeTx(client, ctx.tenantId, id, {
          active: result.valid,
          needsRevalidation: !result.valid,
        });
        if (!row) throw new ServiceError('tax_mapping_not_found', `tax mapping ${id} not found`);
        await store.insertAuditRowTx(client, {
          tenantId: ctx.tenantId,
          taxMappingId: id,
          connectionId: existing.connectionId,
          provider: existing.provider,
          changedBy: ctx.userId,
          action: 'revalidate',
          reason: `${reason}${result.detail ? ` — ${result.detail}` : ''}`,
        });
        return row;
      });
      return verifyReadBack(
        ctx.tenantId,
        updated.id,
        (r) => r.active === result.valid && r.needsRevalidation === !result.valid,
        'revalidate',
      );
    },
    (r) => ({ id: r.id, active: r.active, needsRevalidation: r.needsRevalidation }),
  );
}

// --- reads --------------------------------------------------------------------------------

export async function getTaxMapping(ctx: ActorContext, id: number): Promise<store.TaxMappingRow | null> {
  ensurePermission(ctx, 'tax_mapping');
  if (!isValidId(id)) return null;
  return store.getTaxMappingById(ctx.tenantId, id);
}

export interface ListTaxMappingsInput {
  connectionId?: number;
  filter?: 'all' | 'active' | 'exception';
  provider?: string;
}

export async function listTaxMappings(ctx: ActorContext, input: ListTaxMappingsInput): Promise<store.TaxMappingRow[]> {
  ensurePermission(ctx, 'tax_mapping');
  const filter = input.filter ?? 'active';
  const opts: store.ListTaxMappingsOpts = { connectionId: input.connectionId, provider: input.provider };
  if (filter === 'active') opts.active = true;
  else if (filter === 'exception') opts.needsRevalidation = true;
  // filter === 'all' → no active/needsRevalidation predicate.
  return store.listTaxMappings(ctx.tenantId, opts);
}

/** who/when/why/action trail for one mapping (tax_mapping_audit). Same 404-on-cross-tenant as getTaxMapping. */
export async function listTaxMappingAudit(ctx: ActorContext, id: number): Promise<store.TaxMappingAuditRow[]> {
  ensurePermission(ctx, 'tax_mapping');
  if (!isValidId(id)) throw new ServiceError('tax_mapping_not_found', `tax mapping ${id} not found`);
  const existing = await store.getTaxMappingById(ctx.tenantId, id);
  if (!existing) throw new ServiceError('tax_mapping_not_found', `tax mapping ${id} not found`);
  return store.listAuditForMapping(ctx.tenantId, id);
}
