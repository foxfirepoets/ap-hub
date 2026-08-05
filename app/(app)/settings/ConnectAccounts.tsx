'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError, apiGet, apiPost } from '../../lib/api';
import type { ConnectionStatus } from '../../lib/types';

/**
 * CHUNK_5_CONNECT — Gmail and QuickBooks Online connect buttons, backed by
 * `aphub:connections:start` (opens the system browser + the loopback callback) and
 * `aphub:connections:status`. Never an embedded webview: consent always happens outside BookScout OS.
 */
const PROVIDERS = [
  { id: 'gmail' as const, label: 'Gmail' },
  { id: 'qbo' as const, label: 'QuickBooks Online' },
];

export function ConnectAccounts({ owner }: { owner: boolean }) {
  const [connections, setConnections] = useState<ConnectionStatus[]>([]);
  const [busyProvider, setBusyProvider] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await apiGet<ConnectionStatus[]>('/api/connections/status');
      setConnections(data);
    } catch (cause) {
      setNotice(cause instanceof ApiError ? cause.message : 'Connected accounts are temporarily unavailable.');
    }
  }, []);

  useEffect(() => void load(), [load]);

  async function connect(provider: 'gmail' | 'qbo') {
    setBusyProvider(provider);
    setNotice(null);
    const result = await apiPost<{ state: string }>('/api/connections/start', { provider });
    setBusyProvider(null);
    if (!result.ok) {
      setNotice(result.error?.message ?? 'BookScout OS could not open the sign-in window.');
      return;
    }
    setNotice('Finish signing in in the browser window that just opened, then come back here.');
    await load();
  }

  return (
    <div data-testid="connect-accounts">
      {notice ? <div className="notice" role="status">{notice}</div> : null}
      {PROVIDERS.map(({ id, label }) => {
        const active = connections.some((c) => c.provider === id && c.status === 'active');
        return (
          <div className="field-row" key={id} data-testid={`connect-${id}`}>
            <span>
              {label} — <strong>{active ? 'Connected' : 'Not connected'}</strong>
            </span>
            {owner ? (
              <button disabled={busyProvider === id} onClick={() => void connect(id)} data-testid={`connect-${id}-button`}>
                {active ? 'Reconnect' : 'Connect'}
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
