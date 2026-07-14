'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { apiGet, ApiError } from '../../lib/api';
import { money, pct, when } from '../../lib/format';
import type { TransactionRow, UxStatus } from '../../lib/types';

const FILTERS: (UxStatus | 'all')[] = ['all', 'prepared', 'held', 'posted', 'reconciled', 'rejected', 'exception'];

export default function TransactionsPage() {
  const [rows, setRows] = useState<TransactionRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<UxStatus | 'all'>('all');

  useEffect(() => {
    let active = true;
    const q = filter === 'all' ? '' : `?status=${filter}`;
    apiGet<TransactionRow[]>(`/api/transactions${q}`)
      .then((r) => {
        if (active) setRows(r);
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof ApiError ? err.message : 'Failed to load transactions');
      });
    return () => {
      active = false;
    };
  }, [filter]);

  if (error) return <div className="notice bad">{error}</div>;

  return (
    <div data-testid="transactions-page">
      <h1>Transactions</h1>
      <p className="page-sub">Prepared, held, posted, and reconciled items.</p>

      <div className="btn-row" style={{ marginBottom: 16 }}>
        {FILTERS.map((f) => (
          <button
            key={f}
            className={filter === f ? 'primary' : ''}
            onClick={() => setFilter(f)}
            data-testid={`filter-${f}`}
          >
            {f}
          </button>
        ))}
      </div>

      <div className="panel">
        <table>
          <thead>
            <tr>
              <th>Vendor</th>
              <th>Doc #</th>
              <th>Date</th>
              <th>Total</th>
              <th>Status</th>
              <th>Conf.</th>
              <th>QBO</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.proposalId} data-testid={`txn-row-${r.proposalId}`}>
                <td>
                  <Link href={`/transactions/${r.proposalId}`}>{r.vendor ?? `#${r.proposalId}`}</Link>
                </td>
                <td>{r.docNumber ?? '—'}</td>
                <td>{r.txnDate ?? when(r.createdAt)}</td>
                <td>{money(r.total)}</td>
                <td>
                  <span className={`badge ${r.status}`}>{r.status}</span>
                </td>
                <td>{pct(r.confidence)}</td>
                <td>
                  {r.qboLink ? (
                    <a href={r.qboLink} target="_blank" rel="noreferrer">
                      open
                    </a>
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={7} className="muted">
                  No transactions.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
