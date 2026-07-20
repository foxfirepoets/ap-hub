'use client';

import { useState } from 'react';
import { Modal } from './Modal';

export interface RejectHoldInput {
  reason: string;
  status: 'rejected' | 'held';
}

export interface RejectHoldModalProps {
  busy?: boolean;
  onSubmit: (input: RejectHoldInput) => void;
  onCancel: () => void;
}

// Reject or Hold — the API requires `reason` (400 without it), so submit is disabled
// client-side until a non-empty reason is entered, matching that server behavior exactly.
export function RejectHoldModal({ busy, onSubmit, onCancel }: RejectHoldModalProps) {
  const [status, setStatus] = useState<'rejected' | 'held'>('rejected');
  const [reason, setReason] = useState('');

  const trimmed = reason.trim();
  const canSubmit = trimmed.length > 0;

  return (
    <Modal title="Reject or hold this mapping" onCancel={onCancel}>
      <div className="field-row">
        <label htmlFor="rh-status">Action</label>
        <select id="rh-status" value={status} onChange={(e) => setStatus(e.target.value as 'rejected' | 'held')}>
          <option value="rejected">Reject</option>
          <option value="held">Hold</option>
        </select>
      </div>
      <div className="field-row">
        <label htmlFor="rh-reason">Reason (required)</label>
        <textarea
          id="rh-reason"
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          data-testid="reject-reason"
        />
        {!canSubmit ? <span className="muted">A reason is required.</span> : null}
      </div>
      <div className="btn-row">
        <button
          className="danger"
          disabled={busy || !canSubmit}
          data-testid="reject-submit"
          onClick={() => onSubmit({ reason: trimmed, status })}
        >
          {status === 'held' ? 'Hold' : 'Reject'}
        </button>
        <button onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </Modal>
  );
}
