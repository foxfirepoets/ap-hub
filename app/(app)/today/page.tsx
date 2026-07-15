'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { apiGet, apiPost, ApiError } from '../../lib/api';
import { money, pct, when } from '../../lib/format';
import { EvidencePanel } from '../../components/EvidencePanel';
import type { TodayDigest, NotificationRow } from '../../lib/types';

const COUNTS: { key: keyof TodayDigest['counts']; label: string }[] = [
  { key: 'exceptions', label: 'Exceptions' },
  { key: 'posted', label: 'Posted' },
  { key: 'held', label: 'Held' },
  { key: 'failed', label: 'Failed' },
];

export default function TodayPage() {
  const [digest, setDigest] = useState<TodayDigest | null>(null);
  const [notifications, setNotifications] = useState<NotificationRow[] | null>(null);
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
    apiGet<NotificationRow[]>('/api/notifications')
      .then((n) => {
        if (active) setNotifications(n);
      })
      .catch(() => {
        // Notifications are supplemental to the counts above; a load failure here
        // should not block the Today page.
        if (active) setNotifications([]);
      });
    return () => {
      active = false;
    };
  }, []);

  function markRead(id: number): void {
    apiPost(`/api/notifications/${id}/read`).then((res) => {
      if (res.ok) {
        setNotifications((prev) =>
          prev ? prev.map((n) => (n.id === id ? { ...n, readAt: new Date().toISOString() } : n)) : prev,
        );
      }
    });
  }

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

      {notifications && notifications.length > 0 ? (
        <div className="panel" data-testid="notifications-panel">
          <h2>Notifications</h2>
          <ul className="notification-list">
            {notifications.map((n) => (
              <li
                key={n.id}
                className={`notification ${n.severity}${n.readAt ? ' read' : ' unread'}`}
                data-testid={`notification-${n.id}`}
              >
                <span className={`badge ${n.severity}`}>{n.kind === 'daily_digest' ? 'digest' : n.severity}</span>
                <span className="notification-body">
                  {n.kind === 'daily_digest'
                    ? `Daily digest for ${n.digestBatch ?? when(n.createdAt)}: posted ${
                        (n.payload as { posted?: number }).posted ?? 0
                      }, held ${(n.payload as { held?: number }).held ?? 0}, failed ${
                        (n.payload as { failed?: number }).failed ?? 0
                      }, exceptions ${(n.payload as { exceptions?: number }).exceptions ?? 0}`
                    : `Risk alert: ${(n.payload as { reasonCode?: string }).reasonCode ?? 'material risk'}${
                        (n.payload as { entityRef?: string }).entityRef
                          ? ` (${(n.payload as { entityRef?: string }).entityRef})`
                          : ''
                      }`}
                </span>
                {!n.readAt ? (
                  <button type="button" onClick={() => markRead(n.id)} data-testid={`mark-read-${n.id}`}>
                    Mark read
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

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
