import type { TaxMapping } from '../../../../lib/types';

// Single source of truth for the 5 visually-distinct states the release spec requires
// (inactive / missing / unsupported / stale-needs_revalidation / active). "missing" (a
// provider tax code seen on an invoice with no mapping row at all) cannot be derived from
// this row shape — see the exceptions/tax page's gap notice for why. Never returns a
// fabricated "OK" for anything unresolved: only `active===true && !needs_revalidation`
// is labeled Active.
export type TaxMappingState = 'active' | 'needs_revalidation' | 'unsupported' | 'disabled' | 'replaced';

export function classifyTaxMapping(m: Pick<TaxMapping, 'active' | 'needs_revalidation' | 'superseded_by_id'>): TaxMappingState {
  if (m.superseded_by_id != null) return 'replaced';
  if (!m.active && m.needs_revalidation) return 'unsupported'; // revalidate() found the code invalid
  if (!m.active) return 'disabled';
  if (m.needs_revalidation) return 'needs_revalidation'; // edited since last revalidation
  return 'active';
}

const LABELS: Record<TaxMappingState, string> = {
  active: 'Active',
  needs_revalidation: 'Needs revalidation',
  unsupported: 'Unsupported',
  disabled: 'Disabled',
  replaced: 'Replaced',
};

const BADGE_CLASS: Record<TaxMappingState, string> = {
  active: 'badge good',
  needs_revalidation: 'badge warn',
  unsupported: 'badge exception',
  disabled: 'badge exception',
  replaced: 'badge held',
};

export function TaxMappingStatusBadge({ mapping }: { mapping: TaxMapping }) {
  const state = classifyTaxMapping(mapping);
  return (
    <span className={BADGE_CLASS[state]} data-testid={`tax-mapping-status-${mapping.id}`}>
      {LABELS[state]}
    </span>
  );
}
