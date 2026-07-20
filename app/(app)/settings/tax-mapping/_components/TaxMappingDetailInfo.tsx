import { when } from '../../../../lib/format';
import type { TaxMapping } from '../../../../lib/types';
import { TaxMappingStatusBadge } from './TaxMappingStatus';

// Read-only field grid for the detail page's top panel — split out to keep
// [id]/page.tsx under the 150-line component limit.
export function TaxMappingDetailInfo({ mapping }: { mapping: TaxMapping }) {
  return (
    <div className="kv" style={{ display: 'grid', gridTemplateColumns: '200px 1fr', gap: 6 }}>
      <span className="muted">Status</span>
      <TaxMappingStatusBadge mapping={mapping} />
      <span className="muted">Provider tax code</span>
      <span className="mono">{mapping.provider_tax_code}</span>
      <span className="muted">Internal treatment</span>
      <span>{mapping.internal_tax_treatment}</span>
      <span className="muted">Tax mode</span>
      <span>{mapping.tax_mode}</span>
      <span className="muted">Applies at</span>
      <span>{mapping.applies_at}</span>
      <span className="muted">Superseded by</span>
      <span>
        {mapping.superseded_by_id ? <a href={`/settings/tax-mapping/${mapping.superseded_by_id}`}>#{mapping.superseded_by_id}</a> : '—'}
      </span>
      <span className="muted">Updated</span>
      <span>{when(mapping.updated_at)}</span>
    </div>
  );
}
