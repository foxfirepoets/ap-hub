'use client';

import { useState } from 'react';

export interface RemapValues {
  kind: string;
  sourceKey: string;
  targetQboType?: string;
  targetQboId?: string;
  targetName?: string;
  remember: boolean;
}

// Inline "edit mapping" form. Collects the fields POST /api/mappings/remap expects. No logic
// beyond gathering input — the service decides whether the correction becomes a rule.
export function RemapForm({
  defaultSourceKey,
  onSubmit,
  onCancel,
  busy,
}: {
  defaultSourceKey?: string;
  onSubmit: (v: RemapValues) => void;
  onCancel: () => void;
  busy?: boolean;
}) {
  const [kind, setKind] = useState('vendor');
  const [sourceKey, setSourceKey] = useState(defaultSourceKey ?? '');
  const [targetQboType, setTargetQboType] = useState('Vendor');
  const [targetQboId, setTargetQboId] = useState('');
  const [targetName, setTargetName] = useState('');
  const [remember, setRemember] = useState(true);

  return (
    <div className="panel" data-testid="remap-form">
      <h2>Edit mapping</h2>
      <div className="fields" style={{ display: 'grid', gridTemplateColumns: '150px 1fr', gap: 8 }}>
        <label>Kind</label>
        <input value={kind} onChange={(e) => setKind(e.target.value)} />
        <label>Source key</label>
        <input value={sourceKey} onChange={(e) => setSourceKey(e.target.value)} placeholder="e.g. vendor name (lowercased)" />
        <label>Target QBO type</label>
        <input value={targetQboType} onChange={(e) => setTargetQboType(e.target.value)} />
        <label>Target QBO id</label>
        <input value={targetQboId} onChange={(e) => setTargetQboId(e.target.value)} />
        <label>Target name</label>
        <input value={targetName} onChange={(e) => setTargetName(e.target.value)} />
        <label>Remember as rule</label>
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
      </div>
      <div className="btn-row" style={{ marginTop: 12 }}>
        <button
          className="primary"
          disabled={busy || !sourceKey.trim()}
          onClick={() =>
            onSubmit({
              kind: kind.trim(),
              sourceKey: sourceKey.trim(),
              targetQboType: targetQboType.trim() || undefined,
              targetQboId: targetQboId.trim() || undefined,
              targetName: targetName.trim() || undefined,
              remember,
            })
          }
        >
          Save mapping
        </button>
        <button onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </div>
  );
}
