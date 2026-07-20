/**
 * Dimension carry-through resolver (F5 accounting-behavior). Provider-neutral and pure:
 * it turns extracted dimension hints into canonical dimensions with an explicit
 * resolution state, so nothing is ever silently dropped. The DB-backed candidate list
 * and the provider's supported-kind list are injected, keeping this fully unit-testable
 * and free of any provider identifier (lint:noleak).
 */

import type { CanonicalDimension, DimensionState } from '../canonical/model.js';
import { normalize } from './resolve.js';
import type { DimensionType, MappingMethod, ReviewStatus, ResolutionState } from './dimensionMappingStore.js';

/**
 * Dimension kinds the QBO Bill payload can represent today. Kept here as the single
 * source of truth shared by the mapping pipeline (flagging) and the posting adapter
 * (payload emission). These are neutral accounting terms, not provider identifiers.
 */
export const SUPPORTED_DIMENSION_KINDS = ['class', 'location'] as const;

export interface DimensionHint {
  kind: string;
  /** Raw extracted value. undefined/null → not provided; '' → intentionally blank. */
  raw: string | null | undefined;
}

export interface DimensionCandidateRow {
  kind: string;
  key: string; // normalized source key
  targetId: string;
  targetName: string;
}

/**
 * Resolve extracted hints into canonical dimensions, tagging each with its state.
 * `supportedKinds` (when given) marks any provided-but-unrepresentable kind as
 * `unsupported_by_provider` rather than dropping it.
 */
export function resolveDimensions(
  hints: DimensionHint[],
  candidates: DimensionCandidateRow[],
  supportedKinds: readonly string[] = SUPPORTED_DIMENSION_KINDS,
): CanonicalDimension[] {
  const out: CanonicalDimension[] = [];
  for (const h of hints) {
    if (h.raw == null) continue; // not provided → absence is the representation
    const raw = String(h.raw);
    if (raw.trim() === '') {
      out.push({ kind: h.kind, state: 'intentionally_blank', raw });
      continue;
    }
    if (supportedKinds.length && !supportedKinds.includes(h.kind)) {
      out.push({ kind: h.kind, state: 'unsupported_by_provider', raw });
      continue;
    }
    const key = normalize(raw);
    const hit = candidates.find((c) => c.kind === h.kind && (normalize(c.key) === key || normalize(c.targetName) === key));
    if (hit) {
      out.push({ kind: h.kind, id: hit.targetId, name: hit.targetName, state: 'mapped', raw });
    } else {
      out.push({ kind: h.kind, state: 'not_mapped', raw });
    }
  }
  return out;
}

/** States that must block auto-posting — a value was present but cannot be safely written. */
const HOLD_STATES: DimensionState[] = ['not_mapped', 'unsupported_by_provider'];

/** True if any dimension is present-but-unhandled (→ raise unmapped_dimension, hold). */
export function hasUnhandledDimension(dims: CanonicalDimension[] | undefined): boolean {
  return (dims ?? []).some((d) => d.state != null && HOLD_STATES.includes(d.state));
}

/** The mapped, provider-representable dimensions (what the payload should carry). */
export function mappedSupportedDimensions(
  dims: CanonicalDimension[] | undefined,
  supportedKinds: readonly string[] = SUPPORTED_DIMENSION_KINDS,
): CanonicalDimension[] {
  return (dims ?? []).filter((d) => d.state === 'mapped' && d.id && supportedKinds.includes(d.kind));
}

/**
 * The persisted `dimension_mappings` row (migration 007) for one canonical dimension on
 * one proposal — the human-reviewed source of truth, distinct from (and authoritative
 * over) the in-memory candidate match `resolveDimensions` computed above.
 */
export interface DimensionMappingRecord {
  resolutionState: string;
  reviewStatus: string;
}

export type DimensionMappingGateReason =
  | 'dimension_mapping_not_found'
  | 'dimension_mapping_not_mapped'
  | 'dimension_mapping_not_reviewed';

export type DimensionMappingGateDecision =
  | { kind: 'pass' } // intentionally_blank — carried through blank, never held
  | { kind: 'ok' }
  | { kind: 'hold'; reason: DimensionMappingGateReason; detail: string };

/**
 * Gate one canonical dimension against its persisted dimension_mappings review row before
 * posting. A dimension the source explicitly left blank always passes through untouched.
 * Everything else requires a row with resolution_state='mapped' AND review_status in
 * ('accepted','corrected') — a missing row, an unresolved/not-mapped state, or a
 * rejected/held/pending review status all hold. Never falls back to the older in-memory
 * match; a human-rejected mapping must be able to override it.
 */
export function evaluateDimensionMappingRecord(
  dim: CanonicalDimension,
  record: DimensionMappingRecord | null,
): DimensionMappingGateDecision {
  if (dim.state === 'intentionally_blank') return { kind: 'pass' };

  const label = `${dim.kind}='${dim.raw ?? ''}'`;
  if (!record) {
    return { kind: 'hold', reason: 'dimension_mapping_not_found', detail: `no dimension_mappings row found for ${label}` };
  }
  if (record.resolutionState !== 'mapped') {
    return {
      kind: 'hold',
      reason: 'dimension_mapping_not_mapped',
      detail: `dimension_mappings row for ${label} has resolution_state='${record.resolutionState}'`,
    };
  }
  if (record.reviewStatus !== 'accepted' && record.reviewStatus !== 'corrected') {
    return {
      kind: 'hold',
      reason: 'dimension_mapping_not_reviewed',
      detail: `dimension_mappings row for ${label} has review_status='${record.reviewStatus}'`,
    };
  }
  return { kind: 'ok' };
}

/**
 * The dimension_mappings row (migration 007) the map/propose pipeline stage should
 * persist for one already-resolved CanonicalDimension. This ONLY translates the decision
 * `resolveDimensions` already made into its DB shape — it never re-runs the matching
 * logic — so the persisted row and the in-memory proposed_txn.dimensions entry always
 * agree. A dimension the pipeline doesn't yet support carrying (dim.state undefined)
 * returns null: nothing to persist.
 */
export interface DimensionMappingInsert {
  tenantId: number;
  connectionId: number;
  provider: string;
  proposalId: number;
  dimensionType: DimensionType;
  rawValue: string;
  normalizedValue: string | null;
  sourceEvidence: Record<string, unknown>;
  extractionConfidence: number;
  proposedProviderId: string | null;
  proposedMatchLabel: string | null;
  providerId: string | null;
  mappingMethod: MappingMethod | null;
  reviewStatus: ReviewStatus;
  resolutionState: ResolutionState;
}

export function toDimensionMappingInsert(
  dim: CanonicalDimension,
  ctx: { tenantId: number; connectionId: number; provider: string; proposalId: number },
): DimensionMappingInsert | null {
  if (!dim.state) return null;
  const raw = dim.raw ?? '';
  const base = {
    tenantId: ctx.tenantId,
    connectionId: ctx.connectionId,
    provider: ctx.provider,
    proposalId: ctx.proposalId,
    // dim.kind is constrained upstream to SUPPORTED_DIMENSION_KINDS ⊂ DimensionType (or
    // flagged unsupported_by_provider before reaching here); the dimension_mappings CHECK
    // constraint is the runtime backstop for any value outside that list.
    dimensionType: dim.kind as DimensionType,
    rawValue: raw,
    sourceEvidence: { raw },
  };
  switch (dim.state) {
    case 'mapped':
      return {
        ...base,
        normalizedValue: normalize(raw),
        extractionConfidence: 1,
        proposedProviderId: dim.id ?? null,
        proposedMatchLabel: dim.name ?? null,
        providerId: dim.id ?? null,
        mappingMethod: 'exact',
        reviewStatus: 'accepted',
        resolutionState: 'mapped',
      };
    case 'intentionally_blank':
      return {
        ...base,
        normalizedValue: null,
        extractionConfidence: 0,
        proposedProviderId: null,
        proposedMatchLabel: null,
        providerId: null,
        mappingMethod: null,
        reviewStatus: 'accepted',
        resolutionState: 'intentionally_blank',
      };
    case 'unsupported_by_provider':
      return {
        ...base,
        normalizedValue: normalize(raw),
        extractionConfidence: 0,
        proposedProviderId: null,
        proposedMatchLabel: null,
        providerId: null,
        mappingMethod: null,
        reviewStatus: 'held',
        resolutionState: 'unsupported_by_provider',
      };
    case 'not_mapped':
    default:
      return {
        ...base,
        normalizedValue: normalize(raw),
        extractionConfidence: 0,
        proposedProviderId: null,
        proposedMatchLabel: null,
        providerId: null,
        mappingMethod: null,
        reviewStatus: 'pending',
        resolutionState: 'not_mapped',
      };
  }
}
