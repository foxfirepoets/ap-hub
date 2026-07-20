'use client';

import { useCallback, useEffect, useState, type ChangeEvent } from 'react';
import { apiGet, ApiError } from '../../../../lib/api';
import type { QboTaxCode } from '../../../../lib/types';

// Provider-code discovery: GET /api/tax-mappings/discover lists real QBO TaxCode rows so an
// operator picks a code that actually exists instead of free-typing one (release spec
// requirement). A manual override input stays available for providers other than QBO or if
// discovery itself is unreachable — but it is clearly labeled as unverified in that case.
export function TaxCodePicker({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (code: string) => void;
  disabled?: boolean;
}) {
  const [codes, setCodes] = useState<QboTaxCode[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);
    apiGet<{ taxCodes: QboTaxCode[] }>('/api/tax-mappings/discover')
      .then((res) => {
        if (active) setCodes(res.taxCodes);
      })
      .catch((err: unknown) => {
        if (!active) return;
        setError(err instanceof ApiError ? err.message : 'Failed to load QBO tax codes.');
        setCodes([]);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const onSelect = useCallback((e: ChangeEvent<HTMLSelectElement>) => onChange(e.target.value), [onChange]);

  return (
    <div data-testid="tax-code-picker">
      {loading ? (
        <span className="muted">Loading QBO tax codes…</span>
      ) : codes && codes.length > 0 ? (
        <select value={value} onChange={onSelect} disabled={disabled} data-testid="tax-code-select">
          <option value="">Choose a QBO tax code…</option>
          {codes.map((c) => (
            <option key={c.Id} value={c.Id}>
              {c.Id} — {c.Name ?? 'unnamed'}
              {c.Active === false ? ' (inactive)' : ''}
            </option>
          ))}
        </select>
      ) : (
        <p className="muted" data-testid="tax-code-picker-empty">
          {error ?? 'No QBO tax codes returned.'} You may still enter a provider tax code manually below
          (unverified until saved and revalidated).
        </p>
      )}
      <input
        style={{ marginTop: 6, width: '100%' }}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Provider tax code (e.g. TAX8)"
        disabled={disabled}
        data-testid="tax-code-manual-input"
      />
    </div>
  );
}
