'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { ApiError, apiGet } from '../../lib/api';
import type { StatementListItem } from '../../lib/types';

const STATUSES = ['', 'review', 'ready', 'held', 'unbalanced', 'filed'];

export default function StatementsPage() {
  const [items, setItems] = useState<StatementListItem[]>([]);
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setItems(await apiGet<StatementListItem[]>(`/api/statements${status ? `?status=${status}` : ''}`));
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Statements are temporarily unavailable.');
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => void load(), [load]);

  return (
    <div data-testid="statements-page">
      <h1>Bank statements</h1>
      <p className="page-sub">Review extracted evidence and file it after every line is resolved.</p>
      <div className="panel">
        <label htmlFor="statement-status">Status </label>
        <select id="statement-status" value={status} onChange={(event) => setStatus(event.target.value)}>
          {STATUSES.map((value) => <option value={value} key={value}>{value || 'all'}</option>)}
        </select>
      </div>
      {error ? <div className="notice bad" data-testid="statements-error">{error} <button onClick={() => void load()}>Try again</button></div> : null}
      {loading ? <p className="muted">Loading statements…</p> : null}
      {!loading && !error && items.length === 0 ? <div className="notice warn">No statements match this view.</div> : null}
      {!loading && items.length ? (
        <div className="panel">
          <table>
            <thead><tr><th>Institution</th><th>Period</th><th>Status</th><th>Lines</th><th /></tr></thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} data-testid={`statement-row-${item.id}`}>
                  <td>{item.institutionName ?? 'Unknown institution'}<div className="muted">{item.accountHint ?? 'Account not identified'}</div></td>
                  <td>{item.periodStart ?? '—'} – {item.periodEnd ?? '—'}</td>
                  <td><span className={`badge ${item.status}`}>{item.status}</span>{item.status === 'held' || item.status === 'unbalanced' ? <div className="muted">Review validation evidence</div> : null}</td>
                  <td>{item.unresolvedCount} unresolved / {item.lineCount}</td>
                  <td><Link className="btn" href={`/statements/${item.id}`}>Review</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
