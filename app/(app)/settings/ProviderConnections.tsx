'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, apiGet, apiPost } from '../../lib/api';
import type { ProviderCapabilityConnection, ProviderJob } from '../../lib/types';

export function ProviderConnections({ owner }: { owner: boolean }) {
  const [connections, setConnections] = useState<ProviderCapabilityConnection[]>([]);
  const [jobs, setJobs] = useState<ProviderJob[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const capabilityData = await apiGet<{ connections: ProviderCapabilityConnection[] }>(
        '/api/provider-capabilities',
      );
      setConnections(capabilityData.connections);
      if (owner) {
        const jobData = await apiGet<{ jobs: ProviderJob[] }>('/api/provider-jobs');
        setJobs(jobData.jobs);
      }
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Provider status is temporarily unavailable.');
    } finally {
      setLoading(false);
    }
  }, [owner]);

  useEffect(() => void load(), [load]);

  const jobHealth = useMemo(() => {
    const byConnection = new Map<number, { queued: number; held: number; failed: number }>();
    for (const job of jobs) {
      const counts = byConnection.get(job.connectionId) ?? { queued: 0, held: 0, failed: 0 };
      if (job.status === 'queued') counts.queued += 1;
      if (job.status === 'held') counts.held += 1;
      if (job.status === 'failed') counts.failed += 1;
      byConnection.set(job.connectionId, counts);
    }
    return byConnection;
  }, [jobs]);

  if (loading) return <p className="muted" data-testid="provider-loading">Checking provider health…</p>;
  if (error) {
    return (
      <div className="notice bad" data-testid="provider-error">
        {error} <button onClick={() => void load()}>Try again</button>
      </div>
    );
  }
  if (connections.length === 0) {
    return (
      <div className="notice warn" data-testid="provider-empty">
        No QuickBooks company is connected. Connect QuickBooks Online or supported Windows
        QuickBooks Desktop Pro, Premier, or Enterprise.
      </div>
    );
  }

  return (
    <div data-testid="provider-connections">
      {connections.map((connection) => {
        const health = jobHealth.get(connection.id);
        const offline = connection.status !== 'active';
        const unhealthy = offline || !connection.supported || Boolean(health?.held || health?.failed);
        return (
          <section className="provider-card" key={connection.id} data-testid={`provider-${connection.id}`}>
            <div className="provider-card-head">
              <div>
                <strong>{connection.displayName ?? connection.externalCompany ?? 'QuickBooks company'}</strong>
                <div className="muted">
                  {connection.provider.toUpperCase()} · {connection.edition.replaceAll('_', ' ')}
                </div>
              </div>
              <span className={`badge ${unhealthy ? 'warn' : 'good'}`}>
                {offline ? 'Offline' : !connection.supported ? 'Unsupported' : health?.held || health?.failed ? 'Needs attention' : 'Healthy'}
              </span>
            </div>
            {connection.lastVerifiedAt ? (
              <p className="muted">Last verified {new Date(connection.lastVerifiedAt).toLocaleString()}</p>
            ) : (
              <p className="muted">Company verification has not been observed yet.</p>
            )}
            <p className="muted">
              {connection.provider === 'qbd'
                ? `Desktop bill write gate: ${connection.writeGateEnabled ? 'enabled for this connection' : 'disabled'}.`
                : `QuickBooks Online write gate: ${connection.writeGateEnabled ? 'enabled for the configured company' : 'disabled'}.`}
            </p>
            {owner ? <WriteGateControls connection={connection} reload={load} /> : null}
            {connection.provider === 'qbd' ? (
              <dl className="provider-identity" data-testid={`provider-${connection.id}-identity`}>
                <div><dt>Expected company</dt><dd>{connection.expectedCompanyId ?? 'Not configured'}</dd></div>
                <div><dt>Observed company</dt><dd>{connection.observedCompanyId ?? 'Not observed'}</dd></div>
                <div><dt>Last Desktop contact</dt><dd>{connection.lastContactAt ? new Date(connection.lastContactAt).toLocaleString() : 'Not observed'}</dd></div>
              </dl>
            ) : null}
            {connection.gaps.map((gap) => <div className="notice warn" key={gap}>{gap}</div>)}
            <div className="capability-grid">
              {connection.capabilities.map((capability) => (
                <span
                  className={`capability ${capability.supported ? 'supported' : 'unsupported'}`}
                  key={capability.operation}
                  title={capability.reason ?? capability.unsupportedFields.join(', ')}
                >
                  {capability.operation.replaceAll('_', ' ')}: {capability.supported ? 'Supported' : 'Unavailable'}
                </span>
              ))}
            </div>
            {owner && health ? (
              <p className={health.held || health.failed ? 'notice warn' : 'muted'}>
                Jobs: {health.queued} queued · {health.held} held · {health.failed} failed
                {health.held ? ' — inspect held outcomes before retrying.' : ''}
              </p>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

function WriteGateControls({
  connection,
  reload,
}: {
  connection: ProviderCapabilityConnection;
  reload: () => Promise<void>;
}) {
  const expected = connection.expectedCompanyId ?? connection.externalCompany ?? '';
  const [companyId, setCompanyId] = useState('');
  const [backup, setBackup] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  async function change(enabled: boolean) {
    setBusy(true);
    setMessage(null);
    const result = await apiPost(`/api/provider-connections/${connection.id}/write-gate`, {
      enabled, confirmedCompanyId: enabled ? companyId.trim() : expected,
      backupConfirmed: enabled ? backup : false, confirmation: enabled ? confirmation : '',
    });
    setBusy(false);
    if (!result.ok) setMessage(result.error?.message ?? 'Write gate was not changed.');
    else {
      setMessage(enabled ? 'Owner write gate enabled for this exact company.' : 'Owner write gate disabled immediately.');
      await reload();
    }
  }
  return (
    <div className="panel">
      <strong>Owner write control</strong>
      {connection.writeGateEnabled ? (
        <div className="btn-row">
          <span className="notice warn">Writes are enabled for {expected}.</span>
          <button className="danger" disabled={busy} onClick={() => void change(false)}>Disable writes</button>
        </div>
      ) : (
        <>
          <p className="muted">The process-level master switch, active connection, exact company identity, and a verified backup must already be in place.</p>
          <label className="field-row"><span>Type exact company/realm ID: {expected || 'not configured'}</span>
            <input type="text" value={companyId} onChange={(event) => setCompanyId(event.target.value)} />
          </label>
          <label><input type="checkbox" checked={backup} onChange={(event) => setBackup(event.target.checked)} /> I verified a restorable backup for this company.</label>
          <label className="field-row"><span>Type ENABLE WRITES</span>
            <input type="text" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} />
          </label>
          <button className="primary" disabled={busy || !backup || companyId !== expected || confirmation !== 'ENABLE WRITES'} onClick={() => void change(true)}>Enable writes for this company</button>
        </>
      )}
      {message ? <div className="notice warn" role="status">{message}</div> : null}
    </div>
  );
}
