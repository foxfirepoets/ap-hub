'use client';

import { useState } from 'react';
import type { TaxMapping } from '../../../../lib/types';

export interface EditValues {
  internalTaxTreatment: string;
  taxMode: 'exclusive' | 'inclusive';
  appliesAt: 'invoice' | 'line';
  reason: string;
}

// Edit does NOT change provider_tax_code (server: EditTaxMappingInput has no such field —
// changing the code is a `replace`, which preserves history via supersede). Reason is
// always required (POST /api/tax-mappings/:id/edit 400s without one; sets
// needs_revalidation=true server-side, which the UI reflects immediately after save).
export function TaxMappingEditForm({
  mapping,
  busy,
  onSubmit,
  onCancel,
}: {
  mapping: TaxMapping;
  busy?: boolean;
  onSubmit: (v: EditValues) => void;
  onCancel: () => void;
}) {
  const [internalTaxTreatment, setInternalTaxTreatment] = useState(mapping.internal_tax_treatment);
  const [taxMode, setTaxMode] = useState<'exclusive' | 'inclusive'>(mapping.tax_mode);
  const [appliesAt, setAppliesAt] = useState<'invoice' | 'line'>(mapping.applies_at);
  const [reason, setReason] = useState('');

  return (
    <div className="panel" data-testid="tax-mapping-edit-form">
      <h2>Edit mapping</h2>
      <div className="fields" style={{ display: 'grid', gridTemplateColumns: '180px 1fr', gap: 8 }}>
        <label htmlFor="edit-treatment">Internal tax treatment</label>
        <input id="edit-treatment" value={internalTaxTreatment} onChange={(e) => setInternalTaxTreatment(e.target.value)} />
        <label htmlFor="edit-mode">Tax mode</label>
        <select id="edit-mode" value={taxMode} onChange={(e) => setTaxMode(e.target.value as 'exclusive' | 'inclusive')}>
          <option value="exclusive">Tax-exclusive</option>
          <option value="inclusive">Tax-inclusive</option>
        </select>
        <label htmlFor="edit-appliesat">Applies at</label>
        <select id="edit-appliesat" value={appliesAt} onChange={(e) => setAppliesAt(e.target.value as 'invoice' | 'line')}>
          <option value="invoice">Invoice level</option>
          <option value="line">Line level</option>
        </select>
        <label htmlFor="edit-reason">Reason (required)</label>
        <input id="edit-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="why this change is being made" />
      </div>
      <div className="btn-row" style={{ marginTop: 12 }}>
        <button
          className="primary"
          disabled={busy || !internalTaxTreatment.trim() || !reason.trim()}
          data-testid="tax-mapping-edit-submit"
          onClick={() => onSubmit({ internalTaxTreatment: internalTaxTreatment.trim(), taxMode, appliesAt, reason: reason.trim() })}
        >
          Save changes
        </button>
        <button onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </div>
  );
}
