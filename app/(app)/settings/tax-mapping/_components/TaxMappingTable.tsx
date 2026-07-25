'use client';

import Link from 'next/link';
import { when } from '../../../../lib/format';
import type { TaxMapping } from '../../../../lib/types';
import { TaxMappingStatusBadge } from './TaxMappingStatus';

// Read-only list; every row-level action (disable/replace/revalidate) lives on the detail
// page so this table stays under the 150-line component limit and has one job: show state.
export function TaxMappingTable({ mappings }: { mappings: TaxMapping[] }) {
  if (mappings.length === 0) {
    return <p className="muted">No tax mappings match this filter.</p>;
  }
  return (
    <div className="table-scroll" tabIndex={0} role="region" aria-label="Tax mappings table">
      <table data-testid="tax-mapping-table">
      <thead>
        <tr>
          <th>Provider code</th>
          <th>Internal treatment</th>
          <th>Mode</th>
          <th>Applies at</th>
          <th>Status</th>
          <th>Updated</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {mappings.map((m) => (
          <tr key={m.id} className="row" data-testid={`tax-mapping-row-${m.id}`}>
            <td className="mono">{m.provider_tax_code}</td>
            <td>{m.internal_tax_treatment}</td>
            <td>{m.tax_mode}</td>
            <td>{m.applies_at}</td>
            <td>
              <TaxMappingStatusBadge mapping={m} />
            </td>
            <td className="muted">{when(m.updated_at)}</td>
            <td>
              <Link href={`/settings/tax-mapping/${m.id}`}>View / fix</Link>
            </td>
          </tr>
        ))}
      </tbody>
      </table>
    </div>
  );
}
