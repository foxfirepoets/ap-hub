'use client';

import { useState } from 'react';
import { TaxCodePicker } from './TaxCodePicker';

export interface TaxMappingFormValues {
  connectionId?: string; // only used in 'create' mode
  provider?: string; // only used in 'create' mode
  providerTaxCode: string;
  internalTaxTreatment: string;
  taxMode: 'exclusive' | 'inclusive';
  appliesAt: 'invoice' | 'line';
  reason: string;
}

// Shared create/replace form: tax-inclusive vs exclusive selector, invoice- vs line-level
// selector, and the QBO tax-code picker (release spec requirements). `mode='create'` also
// collects connectionId/provider (no connections-list endpoint exists yet — see task report
// — so connectionId is a plain numeric field). `mode='replace'` fixes those to the mapping
// being replaced and always requires a reason (server-enforced; the UI also requires it).
export function TaxMappingForm({
  mode,
  defaults,
  busy,
  onSubmit,
  onCancel,
}: {
  mode: 'create' | 'replace';
  defaults?: Partial<TaxMappingFormValues>;
  busy?: boolean;
  onSubmit: (v: TaxMappingFormValues) => void;
  onCancel?: () => void;
}) {
  const [connectionId, setConnectionId] = useState(defaults?.connectionId ?? '');
  const [provider, setProvider] = useState(defaults?.provider ?? 'qbo');
  const [providerTaxCode, setProviderTaxCode] = useState(defaults?.providerTaxCode ?? '');
  const [internalTaxTreatment, setInternalTaxTreatment] = useState(defaults?.internalTaxTreatment ?? '');
  const [taxMode, setTaxMode] = useState<'exclusive' | 'inclusive'>(defaults?.taxMode ?? 'exclusive');
  const [appliesAt, setAppliesAt] = useState<'invoice' | 'line'>(defaults?.appliesAt ?? 'invoice');
  const [reason, setReason] = useState(defaults?.reason ?? '');

  const reasonRequired = mode === 'replace';
  const canSubmit =
    providerTaxCode.trim() !== '' &&
    internalTaxTreatment.trim() !== '' &&
    (!reasonRequired || reason.trim() !== '') &&
    (mode === 'create' ? connectionId.trim() !== '' && provider.trim() !== '' : true);

  return (
    <div className="panel" data-testid={`tax-mapping-form-${mode}`}>
      <h2>{mode === 'create' ? 'New tax mapping' : 'Replace this mapping'}</h2>
      <div className="fields" style={{ display: 'grid', gridTemplateColumns: '180px 1fr', gap: 8 }}>
        {mode === 'create' ? (
          <>
            <label htmlFor="tm-connection">Connection ID</label>
            <input id="tm-connection" value={connectionId} onChange={(e) => setConnectionId(e.target.value)} placeholder="numeric connection id" />
            <label htmlFor="tm-provider">Provider</label>
            <input id="tm-provider" value={provider} onChange={(e) => setProvider(e.target.value)} />
          </>
        ) : null}

        <label>Provider tax code</label>
        <TaxCodePicker value={providerTaxCode} onChange={setProviderTaxCode} disabled={busy} />

        <label htmlFor="tm-treatment">Internal tax treatment</label>
        <input
          id="tm-treatment"
          value={internalTaxTreatment}
          onChange={(e) => setInternalTaxTreatment(e.target.value)}
          placeholder="e.g. standard_sales_tax"
        />

        <label htmlFor="tm-taxmode">Tax mode</label>
        <select id="tm-taxmode" value={taxMode} onChange={(e) => setTaxMode(e.target.value as 'exclusive' | 'inclusive')}>
          <option value="exclusive">Tax-exclusive (added on top)</option>
          <option value="inclusive">Tax-inclusive (already in the total)</option>
        </select>

        <label htmlFor="tm-appliesat">Applies at</label>
        <select id="tm-appliesat" value={appliesAt} onChange={(e) => setAppliesAt(e.target.value as 'invoice' | 'line')}>
          <option value="invoice">Invoice level</option>
          <option value="line">Line level</option>
        </select>

        <label htmlFor="tm-reason">Reason {reasonRequired ? '(required)' : '(optional)'}</label>
        <input id="tm-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="why this mapping is being made" />
      </div>
      <div className="btn-row" style={{ marginTop: 12 }}>
        <button
          className="primary"
          disabled={busy || !canSubmit}
          data-testid={`tax-mapping-form-submit-${mode}`}
          onClick={() =>
            onSubmit({
              connectionId: mode === 'create' ? connectionId.trim() : undefined,
              provider: mode === 'create' ? provider.trim() : undefined,
              providerTaxCode: providerTaxCode.trim(),
              internalTaxTreatment: internalTaxTreatment.trim(),
              taxMode,
              appliesAt,
              reason: reason.trim(),
            })
          }
        >
          {mode === 'create' ? 'Create mapping' : 'Replace mapping'}
        </button>
        {onCancel ? (
          <button onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        ) : null}
      </div>
    </div>
  );
}
