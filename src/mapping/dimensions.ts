/**
 * Dimension carry-through resolver (F5 accounting-behavior). Provider-neutral and pure:
 * it turns extracted dimension hints into canonical dimensions with an explicit
 * resolution state, so nothing is ever silently dropped. The DB-backed candidate list
 * and the provider's supported-kind list are injected, keeping this fully unit-testable
 * and free of any provider identifier (lint:noleak).
 */

import type { CanonicalDimension, DimensionState } from '../canonical/model.js';
import { normalize } from './resolve.js';

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
