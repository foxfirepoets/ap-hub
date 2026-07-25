'use client';

import { useEffect, useState } from 'react';
import { apiGet } from '../../../../lib/api';
import { when } from '../../../../lib/format';
import type { TaxMappingAudit, TaxMapping } from '../../../../lib/types';

// F_TAX_MAPPING_API — GET /api/tax-mappings/:id/audit exposes tax_mapping_audit directly
// (src/mapping/taxMappingStore.ts's listAuditForMapping()), so who/when/why(reason)/action
// are all real and complete here — no merge from the generic GET /api/audit needed.
export function AuditTrailPanel({ mapping }: { mapping: TaxMapping }) {
  const [rows, setRows] = useState<TaxMappingAudit[] | null>(null);

  useEffect(() => {
    let active = true;
    apiGet<{ audit: TaxMappingAudit[] }>(`/api/tax-mappings/${mapping.id}/audit`)
      .then((res) => {
        if (!active) return;
        const sorted = [...res.audit].sort((a, b) => new Date(b.changed_at).getTime() - new Date(a.changed_at).getTime());
        setRows(sorted);
      })
      .catch(() => {
        if (active) setRows([]);
      });
    return () => {
      active = false;
    };
  }, [mapping.id]);

  return (
    <div className="panel" data-testid="tax-mapping-audit-trail">
      <h2>Audit trail</h2>
      {rows === null ? (
        <p className="muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="muted">No matching audit entries found.</p>
      ) : (
        <div className="table-scroll" tabIndex={0} role="region" aria-label="Tax mapping audit trail table">
          <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Who</th>
              <th>Action</th>
              <th>Reason</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{when(r.changed_at)}</td>
                <td>{r.changed_by ?? 'system'}</td>
                <td>{r.action}</td>
                <td>{r.reason ?? ''}</td>
              </tr>
            ))}
          </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
