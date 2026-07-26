'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { apiGet, ApiError } from '../../../lib/api';
import { money, pct, when } from '../../../lib/format';
import { EvidencePanel } from '../../../components/EvidencePanel';
import type { TransactionRow } from '../../../lib/types';

export default function TransactionDetailPage() {
  const params = useParams<{ id: string }>();
  // SPIKE (layout variant): useParams() returns the build-time sentinel value in a static
  // export served for an arbitrary runtime path; the real id must be read from the actual
  // loaded URL instead.
  const pathId = typeof window !== 'undefined' ? window.location.pathname.split('/').pop() : params.id;
  const id = Number(pathId);
  const [txn, setTxn] = useState<TransactionRow | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!Number.isFinite(id)) return;
    let active = true;
    apiGet<TransactionRow>(`/api/transactions/${id}`)
      .then((t) => {
        if (active) setTxn(t);
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof ApiError ? err.message : 'Failed to load transaction');
      });
    return () => {
      active = false;
    };
  }, [id]);

  if (error) return <div className="notice bad">{error}</div>;
  if (!txn) return <div className="muted">Loading…</div>;

  return (
    <div data-testid="transaction-detail">
      <p className="page-sub">
        <Link href="/transactions">← Transactions</Link>
      </p>
      <h1>{txn.vendor ?? `Proposal #${txn.proposalId}`}</h1>
      <p className="page-sub">
        <span className={`badge ${txn.status}`}>{txn.status}</span> · confidence {pct(txn.confidence)}
      </p>

      <div className="split">
        <div className="panel">
          <h2>Details</h2>
          <div className="evidence">
            <div className="kv">
              <span className="k">Doc #</span>
              <span>{txn.docNumber ?? '—'}</span>
              <span className="k">Date</span>
              <span>{txn.txnDate ?? '—'}</span>
              <span className="k">Total</span>
              <span>{money(txn.total)}</span>
              <span className="k">Created</span>
              <span>{when(txn.createdAt)}</span>
              <span className="k">Reconciled</span>
              <span>{txn.reconciled ? 'Yes' : 'No'}</span>
              <span className="k">QuickBooks</span>
              <span>
                {txn.qboLink ? (
                  <a href={txn.qboLink} target="_blank" rel="noreferrer">
                    {txn.qboType} #{txn.qboId}
                  </a>
                ) : (
                  'Not posted'
                )}
              </span>
            </div>
          </div>
        </div>

        <div className="panel">
          <EvidencePanel proposalId={txn.proposalId} />
        </div>
      </div>
    </div>
  );
}
