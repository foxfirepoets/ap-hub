'use client';

import { useState } from 'react';
import { Modal } from './Modal';

export interface CorrectInput {
  normalizedValue: string;
  reason?: string;
}

export interface CorrectModalProps {
  defaultValue: string;
  busy?: boolean;
  onSubmit: (input: CorrectInput) => void;
  onCancel: () => void;
}

// Corrects the extracted value (e.g. OCR typo). review_status -> 'corrected' on success.
export function CorrectModal({ defaultValue, busy, onSubmit, onCancel }: CorrectModalProps) {
  const [normalizedValue, setNormalizedValue] = useState(defaultValue);
  const [reason, setReason] = useState('');

  const canSubmit = normalizedValue.trim().length > 0;

  return (
    <Modal title="Correct extracted value" onCancel={onCancel}>
      <div className="field-row">
        <label htmlFor="correct-value">Normalized value</label>
        <input
          id="correct-value"
          type="text"
          value={normalizedValue}
          onChange={(e) => setNormalizedValue(e.target.value)}
          data-testid="correct-normalized-value"
        />
      </div>
      <div className="field-row">
        <label htmlFor="correct-reason">Reason (optional)</label>
        <textarea
          id="correct-reason"
          rows={2}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. fixed OCR typo"
        />
      </div>
      <div className="btn-row">
        <button
          className="primary"
          disabled={busy || !canSubmit}
          data-testid="correct-submit"
          onClick={() => onSubmit({ normalizedValue: normalizedValue.trim(), reason: reason.trim() || undefined })}
        >
          Save correction
        </button>
        <button onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </Modal>
  );
}
