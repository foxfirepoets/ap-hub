'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { apiGet, ApiError } from '../../lib/api';
import { money, pct, when } from '../../lib/format';
import { EvidencePanel } from '../../components/EvidencePanel';
import type { TodayDigest } from '../../lib/types';

const COUNTS: { key: keyof TodayDigest['counts']; label: string }[] = [
  { key: 'exceptions', label: 'Exceptions' },
  { key: 'posted', label: 'Posted' },
  { key: 'held', label: 'Held' },
  { key: 'failed', label: 'Failed' },
];

export default function TodayPage() {
  const [digest, setDigest] = useState<TodayDigest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);

  useEffect(() => {
    let active = true;
    apiGet<TodayDigest>('/api/today')
      .then((d) => {
        if (active) setDigest(d);
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof ApiError ? err.message : 'Failed to load today');
      });
    return () => {
      active = false;
    };
  }, []);

  if (error) return <div className="notice bad">{error}</div>;
  if (!digest) return <div className="muted">Loading…</div>;

  return (
    <div data-testid="today-page">
      <h1>Today</h1>
      <p className="page-sub">Generated {when(digest.generatedAt)}</p>

      <div className="counts">
        {COUNTS.map((c) => (
          <div className="count-card" key={c.key} data-testid={`count-${c.key}`}>
            <div className="n">{digest.counts[c.key]}</div>
            <div className="l">{c.label}</div>
          </div>
        ))}
      </div>

      <div className="split">
        <div className="panel">
          <h2>Recent items ({digest.items.length})</h2>
          <table>
            <thead>
              <tr>
                <th>Vendor</th>
                <th>Total</th>
                <th>Status</th>
                <th>Conf.</th>
              </tr>
            </thead>
            <tbody>
              {digest.items.map((it) => (
                <tr
                  key={it.proposalId}
                  className={`row${selected === it.proposalId ? ' selected' : ''}`}
                  onClick={() => setSelected(it.proposalId)}
                  data-testid={`today-item-${it.proposalId}`}
                >
                  <td>{it.vendor ?? it.sourceFilename ?? it.emailSubject ?? `#${it.proposalId}`}</td>
                  <td>{money(it.total)}</td>
                  <td>
                    <span className={`badge ${it.status}`}>{it.status}</span>
                  </td>
                  <td>{pct(it.confidence)}</td>
                </tr>
              ))}
              {digest.items.length === 0 ? (
                <tr>
                  <td colSpan={4} className="muted">
                    Nothing today.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
          <p style={{ marginTop: 12 }}>
            <Link href="/exceptions">Go to exceptions queue →</Link>
          </p>
        </div>

        <div className="panel">
          {selected != null ? (
            <EvidencePanel proposalId={selected} />
          ) : (
            <div className="muted">Select an item to view its evidence.</div>
          )}
        </div>
      </div>
    </div>
  );
}
