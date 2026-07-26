'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { ApiError, apiGet, apiPost } from '../../../lib/api';
import { canReview } from '../../../lib/permissions';
import { useSession } from '../../../lib/session';
import type { StatementDetail, StatementLine } from '../../../lib/types';

type Notice = { kind: 'good' | 'bad' | 'warn'; text: string };
const FACT_LABELS: Record<string, string> = {
  institutionName: 'Bank or institution',
  accountHint: 'Account ending or nickname',
  currency: 'Currency',
  periodStart: 'Statement start date',
  periodEnd: 'Statement end date',
  openingBalance: 'Opening balance',
  closingBalance: 'Closing balance',
};

function validationSummary(detail: Record<string, unknown>): string {
  const equation = typeof detail.equation === 'string' ? detail.equation.replace('!=', 'does not equal') : null;
  const difference = detail.difference == null ? null : String(detail.difference);
  if (equation && difference) return `Balance check: ${equation}. The difference to review is ${difference}.`;
  if (equation) return `Balance check: ${equation}.`;
  return 'The extracted dates or balances did not pass validation. Compare them with the source statement.';
}

export default function StatementDetailPage() {
  const me = useSession();
  const params = useParams<{ id: string }>();
  // SPIKE (layout variant): static export bakes useParams() to the build-time sentinel;
  // the real id must be read from the actual loaded URL instead.
  const pathId = typeof window !== 'undefined' ? window.location.pathname.split('/').pop() : params.id;
  const id = Number(pathId);
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
    try {
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
    } catch (cause) {
      setNotice({
        kind: 'bad',
        text: cause instanceof ApiError
          ? `${cause.message} Your change was not confirmed. Check your connection and try again.`
          : 'Your change was not confirmed. Check your connection and try again.',
      });
    } finally {
      setBusy(false);
    }
  }, [load]);

  if (error) return <div data-testid="statement-not-found"><Link href="/statements">← Statements</Link><div className="notice bad">{error}</div></div>;
  if (!detail) return <p className="muted">Loading statement…</p>;
  const blocked = detail.status === 'held' || detail.status === 'unbalanced';

  return (
    <div data-testid="statement-detail-page">
      <Link href="/statements">← Statements</Link>
      <h1>{detail.institutionName ?? 'Bank statement'}</h1>
      <p className="page-sub">{detail.periodStart ?? 'Unknown start'} – {detail.periodEnd ?? 'Unknown end'} · {detail.accountHint ?? 'account unavailable'}</p>
      {notice ? <div className={`notice ${notice.kind}`} role={notice.kind === 'bad' ? 'alert' : 'status'} aria-live="polite" data-testid="statement-notice">{notice.text}</div> : null}
      {blocked ? (
        <div className="notice bad" data-testid="statement-held">
          <strong>This statement needs review before it can be filed.</strong>
          <div>{validationSummary(detail.validationDetail)}</div>
          <div>Correct the extracted facts below, or provide an unlocked/readable source document and reprocess it.</div>
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
        <div className="table-scroll" tabIndex={0} role="region" aria-label="Statement lines table">
          <table>
          <caption className="sr-only">Transactions extracted from this bank statement</caption>
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
        </div>
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
      <input aria-label={`Provider reference for line ${line.lineNo}`} placeholder="QuickBooks transaction reference" value={providerRef} onChange={(e) => setProviderRef(e.target.value)} />
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
        {Object.entries(FACT_LABELS).map(([name, label]) => <option key={name} value={name}>{label}</option>)}
      </select>
      <input aria-label="Corrected value" placeholder="Corrected value" value={value} onChange={(e) => setValue(e.target.value)} />
      <input aria-label="Correction reason" placeholder="Correction reason" value={reason} onChange={(e) => setReason(e.target.value)} />
      <button disabled={busy || !reason.trim()} onClick={() => void act(`/api/statements/${id}/correct`, { field, value: value || null, reason })}>Save correction</button>
    </div>
  );
}
