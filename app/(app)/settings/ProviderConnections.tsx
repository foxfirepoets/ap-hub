'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, apiGet } from '../../lib/api';
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
