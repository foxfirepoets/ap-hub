import type { DimensionResolutionState } from '../../../../lib/types';

// resolution_state must NEVER collapse into a generic "done" badge — each of the 5 states
// gets its own label + color so a reviewer can tell "mapped" from "we deliberately left this
// blank" from "the source never gave us this" from "the provider can't take it" at a glance.
const LABELS: Record<DimensionResolutionState, string> = {
  mapped: 'Mapped',
  not_provided: 'Not provided (source)',
  not_mapped: 'Not mapped',
  unsupported_by_provider: 'Unsupported by provider',
  intentionally_blank: 'Intentionally blank',
};

export function ResolutionBadge({ state }: { state: DimensionResolutionState }) {
  return (
    <span className={`badge rs-${state}`} data-testid="resolution-badge" title={state}>
      {LABELS[state] ?? state}
    </span>
  );
}
