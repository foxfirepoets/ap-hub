'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { ApiError, apiGet, apiPost } from '../../../lib/api';
import { canReview } from '../../../lib/permissions';
import { useSession } from '../../../lib/session';
import type { StatementDetail, StatementLine } from '../../../lib/types';

type Notice = { kind: 'good' | 'bad' | 'warn'; text: string };

export default function StatementDetailPage() {
  const me = useSession();
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const mutable = canReview(me.role);
  const [detail, setDetail] = useState<StatementDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await apiGet<StatementDetail | null>(`/api/statements/${id}`);
      if (!data) setError('Statement not found or unavailable in this company.');
      setDetail(data);
    } catch (cause) {
      const apiError = cause instanceof ApiError ? cause : null;
      setError(apiError?.status === 404 ? 'Statement not found or unavailable in this company.' : apiError?.message ?? 'Statement could not be loaded.');
    }
  }, [id]);

  useEffect(() => void load(), [load]);

  const act = useCallback(async (path: string, body?: unknown) => {
    setBusy(true);
    setNotice(null);
    const result = await apiPost<{ ok: true }>(path, body);
    if (!result.ok) {
      setNotice({
        kind: result.status === 409 || result.status === 400 ? 'warn' : 'bad',
        text: result.error?.message ?? 'The statement was not changed. Review the evidence and try again.',
      });
    } else {
      setNotice({ kind: 'good', text: 'Statement review saved.' });
      await load();
    }
    setBusy(false);
  }, [load]);

  if (error) return <div data-testid="statement-not-found"><Link href="/statements">← Statements</Link><div className="notice bad">{error}</div></div>;
  if (!detail) return <p className="muted">Loading statement…</p>;
  const blocked = detail.status === 'held' || detail.status === 'unbalanced';

  return (
    <div data-testid="statement-detail-page">
      <Link href="/statements">← Statements</Link>
      <h1>{detail.institutionName ?? 'Bank statement'}</h1>
      <p className="page-sub">{detail.periodStart ?? 'Unknown start'} – {detail.periodEnd ?? 'Unknown end'} · {detail.accountHint ?? 'account unavailable'}</p>
      {notice ? <div className={`notice ${notice.kind}`} data-testid="statement-notice">{notice.text}</div> : null}
      {blocked ? (
        <div className="notice bad" data-testid="statement-held">
          This statement is {detail.status}. Correct the source facts or reprocess the source document before filing.
          <pre className="mono">{JSON.stringify(detail.validationDetail, null, 2)}</pre>
        </div>
      ) : null}
      {!mutable ? <div className="notice warn" data-testid="statement-readonly">CPA access is read-only. An owner or bookkeeper can change and file this statement.</div> : null}
      <section className="panel">
        <h2>Source evidence</h2>
        <div className="statement-facts">
          <span>Currency: {detail.currency ?? '—'}</span><span>Opening: {detail.openingBalance ?? '—'}</span>
          <span>Closing: {detail.closingBalance ?? '—'}</span><span>Document #{detail.documentId}</span>
        </div>
        {mutable ? <FactCorrection id={id} busy={busy} act={act} /> : null}
      </section>
      <section className="panel">
        <h2>Statement lines</h2>
        <table>
          <thead><tr><th>Date / description</th><th>Amount</th><th>Disposition</th><th>Review</th></tr></thead>
          <tbody>{detail.lines.map((line) => (
            <tr key={line.id} data-testid={`statement-line-${line.id}`}>
              <td>{line.postedOn ?? '—'}<div>{line.description}</div></td>
              <td>{line.amount}<div className="muted">Balance {line.balance ?? '—'}</div></td>
              <td><span className={`badge ${line.matchStatus === 'matched' || line.matchStatus === 'excluded' ? 'good' : 'warn'}`}>{line.matchStatus}</span><div className="muted">{line.reviewReason}</div></td>
              <td>{mutable ? <LineActions statementId={id} line={line} busy={busy} act={act} /> : <span className="muted">Read only</span>}</td>
            </tr>
          ))}</tbody>
        </table>
      </section>
      {mutable ? (
        <button
          className="primary"
          data-testid="statement-file"
          disabled={busy || blocked || detail.unresolvedCount > 0 || detail.lineCount === 0 || detail.status === 'filed'}
          title={detail.unresolvedCount > 0 ? 'Resolve every line before filing' : blocked ? 'Held statements cannot be filed' : ''}
          onClick={() => void act(`/api/statements/${id}/file`, { reason: 'Reviewed and filed by human' })}
        >
          {detail.status === 'filed' ? 'Filed' : `File statement (${detail.unresolvedCount} unresolved)`}
        </button>
      ) : null}
    </div>
  );
}

function LineActions({ statementId, line, busy, act }: { statementId: number; line: StatementLine; busy: boolean; act: (path: string, body?: unknown) => Promise<void> }) {
  const [reason, setReason] = useState('');
  const [providerRef, setProviderRef] = useState('');
  return (
    <div className="statement-line-actions">
      <input aria-label={`Reason for line ${line.lineNo}`} placeholder="Review reason" value={reason} onChange={(e) => setReason(e.target.value)} />
      <input aria-label={`Provider reference for line ${line.lineNo}`} placeholder="QuickBooks transaction ID" value={providerRef} onChange={(e) => setProviderRef(e.target.value)} />
      <div className="statement-actions">
        <button disabled={busy || !reason.trim() || !providerRef.trim()} onClick={() => void act(`/api/statements/${statementId}/lines/${line.id}/match`, { providerRef: { transactionId: providerRef.trim() }, reason })}>Match</button>
        <button disabled={busy || !reason.trim()} onClick={() => void act(`/api/statements/${statementId}/lines/${line.id}/exclude`, { reason })}>Exclude</button>
      </div>
    </div>
  );
}

function FactCorrection({ id, busy, act }: { id: number; busy: boolean; act: (path: string, body?: unknown) => Promise<void> }) {
  const [field, setField] = useState('institutionName');
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  return (
    <div className="statement-actions" style={{ marginTop: 12 }}>
      <select aria-label="Fact to correct" value={field} onChange={(e) => setField(e.target.value)}>
        {['institutionName', 'accountHint', 'currency', 'periodStart', 'periodEnd', 'openingBalance', 'closingBalance'].map((name) => <option key={name}>{name}</option>)}
      </select>
      <input aria-label="Corrected value" placeholder="Corrected value" value={value} onChange={(e) => setValue(e.target.value)} />
      <input aria-label="Correction reason" placeholder="Correction reason" value={reason} onChange={(e) => setReason(e.target.value)} />
      <button disabled={busy || !reason.trim()} onClick={() => void act(`/api/statements/${id}/correct`, { field, value: value || null, reason })}>Save correction</button>
    </div>
  );
}
