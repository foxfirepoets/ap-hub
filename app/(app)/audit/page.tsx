'use client';

import { useEffect, useState } from 'react';
import { apiGet, ApiError } from '../../lib/api';
import { when } from '../../lib/format';
import type { AuditRow } from '../../lib/types';

// Read-only audit trail. Every human action (approve/reject/remap/learn/reply) writes an
// audit_log row centrally in the service layer; this view only reads them, newest first.
export default function AuditPage() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    apiGet<AuditRow[]>('/api/audit')
      .then((r) => {
        if (active) setRows(r);
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof ApiError ? err.message : 'Failed to load audit trail');
      });
    return () => {
      active = false;
    };
  }, []);

  if (error) return <div className="notice bad">{error}</div>;

  return (
    <div data-testid="audit-page">
      <h1>Audit Trail</h1>
      <p className="page-sub">Read-only record of every human action.</p>

      <div className="panel">
        <div className="table-scroll" tabIndex={0} role="region" aria-label="Audit log table">
          <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Actor</th>
              <th>Action</th>
              <th>Entity</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} data-testid={`audit-row-${r.id}`}>
                <td>{when(r.at)}</td>
                <td>{r.actor}</td>
                <td>{r.action}</td>
                <td>{r.entity ?? '—'}</td>
                <td className="mono">{r.detail ? JSON.stringify(r.detail) : '—'}</td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5} className="muted">
                  No audit entries.
                </td>
              </tr>
            ) : null}
          </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
