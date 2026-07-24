'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSession } from '../../lib/session';
import { canApprovePost, isReadOnly } from '../../lib/permissions';
import { apiGet, apiPost, ApiError } from '../../lib/api';
import { friendlyOnboardingError } from '../../lib/onboardingErrors.js';
import { AUTOMATION_LEVELS, type AutomationLevel } from '../../lib/automationLevels';
import type { OnboardingState } from '../../lib/types';
import { ProviderConnections } from './ProviderConnections';

type Notice = { kind: 'good' | 'bad'; text: string };

// Settings: connections + automation level + thresholds. Connections stay a read-only view
// in v1 (no QBO-write/Gmail-send path may be added here). Automation level is the one real
// mutation this page owns — it POSTs the existing gated /api/onboarding/step endpoint
// (owner_controller only, enforced server-side) to move onboarding_state.automation_level,
// the same field the DRY_RUN_LOCKED guard reads (src/services/onboarding.ts). No
// tenant-specific value is hard-coded; labels are product-level facts.
export default function SettingsPage() {
  const me = useSession();
  const owner = canApprovePost(me.role);
  const readOnly = isReadOnly(me.role);

  const [automationLevel, setAutomationLevel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  const load = useCallback(() => {
    apiGet<OnboardingState>('/api/onboarding')
      .then((state) => setAutomationLevel(state.automationLevel))
      .catch(() => setAutomationLevel(null));
  }, []);

  useEffect(load, [load]);

  const setLevel = useCallback(
    async (level: AutomationLevel) => {
      setBusy(true);
      setNotice(null);
      try {
        const res = await apiPost<{ automationLevel: string }>('/api/onboarding/step', {
          step: 'automation_level',
          automationLevel: level,
        });
        if (res.ok && res.data) {
          setAutomationLevel(res.data.automationLevel);
          setNotice({ kind: 'good', text: `Automation set to "${res.data.automationLevel}".` });
        } else {
          const fallback = res.error?.message ?? 'Something went wrong.';
          const friendly = friendlyOnboardingError(res.error?.code ?? '', fallback);
          setNotice({ kind: 'bad', text: friendly.text });
        }
      } catch (err) {
        const message = err instanceof ApiError ? err.message : 'Failed to set automation level.';
        setNotice({ kind: 'bad', text: message });
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  return (
    <div data-testid="settings-page">
      <h1>Settings</h1>
      <p className="page-sub">Signed in as {me.email} · role {me.role}</p>

      <div className="panel">
        <h2>QuickBooks connections</h2>
        <p className="muted">Edition-specific operations and current connection health.</p>
        <ProviderConnections owner={owner} />
      </div>

      <div className="panel" data-testid="automation-panel">
        <h2>Automation level</h2>
        <p className="muted">
          Proposals are held for human review while automation is &quot;off&quot; — approving is
          locked (DRY_RUN_LOCKED) until an owner sets it to &quot;assisted&quot; or &quot;auto&quot;.
        </p>

        {notice ? (
          <div className={`notice ${notice.kind}`} data-testid="automation-notice">
            {notice.text}
          </div>
        ) : null}

        <div className="kv" style={{ display: 'grid', gridTemplateColumns: '200px 1fr', gap: 6 }}>
          <span className="muted">Current mode</span>
          <span data-testid="automation-current">{automationLevel ?? 'Loading…'}</span>
        </div>

        {owner ? (
          <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
            {AUTOMATION_LEVELS.map((level) => (
              <button
                key={level}
                disabled={busy || automationLevel === level}
                onClick={() => void setLevel(level)}
                data-testid={`automation-set-${level}`}
              >
                {level}
              </button>
            ))}
          </div>
        ) : (
          <p className="muted">Only the account owner can change automation level.</p>
        )}
      </div>

      <div className="panel">
        <h2>Tax-code mapping</h2>
        <p className="muted">
          Map provider tax codes (QuickBooks Online) to this tenant&apos;s internal tax treatment.
        </p>
        {owner ? (
          <Link href="/settings/tax-mapping" className="btn" data-testid="tax-mapping-link">
            Manage tax mappings
          </Link>
        ) : (
          <span className="muted">Owner-only.</span>
        )}
      </div>

      <div className="panel">
        <h2>Confidence thresholds</h2>
        <p className="muted">
          The confidence and amount ceilings that gate auto-posting are enforced server-side and
          shown here for reference. This view is read-only.
        </p>
      </div>

      {readOnly ? <p className="muted">Your role has read-only access to settings.</p> : null}
    </div>
  );
}
