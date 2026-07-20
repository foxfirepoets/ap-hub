'use client';

import { useState } from 'react';
import { Modal } from './Modal';

export interface SelectAlternateInput {
  providerId?: string;
  providerLabel?: string;
  reason?: string;
}

export interface SelectAlternateModalProps {
  currentLabel: string | null;
  busy?: boolean;
  onSubmit: (input: SelectAlternateInput) => void;
  onCancel: () => void;
}

// "Search and select an alternate provider value." There is no separate search endpoint —
// the select-alternate action itself re-validates whatever is typed here against the live
// provider (QBO) before writing anything, so a typo or a non-existent value is rejected by
// the server, never guessed at client-side.
export function SelectAlternateModal({ currentLabel, busy, onSubmit, onCancel }: SelectAlternateModalProps) {
  const [providerLabel, setProviderLabel] = useState(currentLabel ?? '');
  const [providerId, setProviderId] = useState('');
  const [reason, setReason] = useState('');

  const canSubmit = providerLabel.trim().length > 0 || providerId.trim().length > 0;

  return (
    <Modal title="Select alternate provider value" onCancel={onCancel}>
      <p className="muted" style={{ marginTop: 0 }}>
        Enter the provider label or ID to match. This re-validates against QuickBooks before
        writing anything.
      </p>
      <div className="field-row">
        <label htmlFor="alt-label">Provider label (search text)</label>
        <input
          id="alt-label"
          type="text"
          value={providerLabel}
          onChange={(e) => setProviderLabel(e.target.value)}
          placeholder="e.g. Marketing Dept"
          data-testid="alt-provider-label"
        />
      </div>
      <div className="field-row">
        <label htmlFor="alt-id">Provider ID (optional, if known)</label>
        <input
          id="alt-id"
          type="text"
          value={providerId}
          onChange={(e) => setProviderId(e.target.value)}
          data-testid="alt-provider-id"
        />
      </div>
      <div className="field-row">
        <label htmlFor="alt-reason">Reason (optional)</label>
        <textarea id="alt-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      <div className="btn-row">
        <button
          className="primary"
          disabled={busy || !canSubmit}
          data-testid="alt-submit"
          onClick={() =>
            onSubmit({
              providerLabel: providerLabel.trim() || undefined,
              providerId: providerId.trim() || undefined,
              reason: reason.trim() || undefined,
            })
          }
        >
          Validate &amp; apply
        </button>
        <button onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </Modal>
  );
}
