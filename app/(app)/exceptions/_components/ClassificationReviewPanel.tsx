'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError, apiGet, apiPost } from '../../../lib/api';
import { useSession } from '../../../lib/session';
import type { ClassificationReviewItem } from '../../../lib/types';

export function ClassificationReviewPanel() {
  const me = useSession();
  const mutable = me.role === 'owner_controller' || me.role === 'bookkeeper';
  const [items, setItems] = useState<ClassificationReviewItem[]>([]);
  const [reason, setReason] = useState<Record<number, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const load = useCallback(async () => {
    try {
      setItems(await apiGet<ClassificationReviewItem[]>('/api/accounting-documents/review'));
      setError(null);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Classification review is unavailable.');
    }
  }, []);
  useEffect(() => void load(), [load]);

  async function classify(id: number, classification: 'invoice' | 'bank_statement' | 'irrelevant') {
    setBusy(id);
    const result = await apiPost(`/api/accounting-documents/${id}/classify`, {
      classification, reason: reason[id]?.trim(),
    });
    setBusy(null);
    if (result.ok) await load();
    else setError(result.error?.message ?? 'The document remained held.');
  }

  if (!error && items.length === 0) return null;
  return (
    <section className="panel" data-testid="classification-review">
      <h2>Documents needing classification</h2>
      <p className="muted">Review the source name and subject. Classification never posts to QuickBooks.</p>
      {error ? <div className="notice bad" role="alert">{error} <button onClick={() => void load()}>Try again</button></div> : null}
      {items.map((item) => (
        <div className="provider-card" key={item.id}>
          <strong>{item.filename ?? `Attachment ${item.attachmentId ?? item.id}`}</strong>
          <div className="muted">{item.subject ?? 'No email subject'} · {item.holdReason ?? 'Unclassified'}</div>
          {mutable ? (
            <>
              <label className="field-row">
                <span>Reason for classification</span>
                <input type="text" value={reason[item.id] ?? ''} onChange={(event) => setReason((old) => ({ ...old, [item.id]: event.target.value }))} />
              </label>
              <div className="btn-row">
                <button disabled={busy === item.id || !reason[item.id]?.trim()} onClick={() => void classify(item.id, 'invoice')}>Classify as invoice</button>
                <button disabled={busy === item.id || !reason[item.id]?.trim()} onClick={() => void classify(item.id, 'bank_statement')}>Classify as statement</button>
                <button disabled={busy === item.id || !reason[item.id]?.trim()} onClick={() => void classify(item.id, 'irrelevant')}>Mark irrelevant</button>
              </div>
            </>
          ) : <div className="notice warn">CPA access is read-only.</div>}
        </div>
      ))}
    </section>
  );
}
