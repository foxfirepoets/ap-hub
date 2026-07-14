'use client';

import { useSession } from '../../lib/session';
import { canApprovePost, isReadOnly } from '../../lib/permissions';

// Settings: connections + automation level + thresholds — a READ-ONLY view in v1. There is
// no settings-mutation API in this phase, and no QBO-write/Gmail-send path may be added here.
// Action affordances are gated by role: only the owner_controller sees management buttons
// (currently disabled — connections are provisioned via configuration, not the UI). No
// tenant-specific value is hard-coded; labels are product-level facts.
export default function SettingsPage() {
  const me = useSession();
  const owner = canApprovePost(me.role);
  const readOnly = isReadOnly(me.role);

  return (
    <div data-testid="settings-page">
      <h1>Settings</h1>
      <p className="page-sub">Signed in as {me.email} · role {me.role}</p>

      <div className="panel">
        <h2>Connections</h2>
        <table>
          <tbody>
            <tr>
              <td>Gmail</td>
              <td className="muted">Read-only — the mailbox is never modified.</td>
              <td>
                {owner ? (
                  <button disabled title="Connections are provisioned via configuration">
                    Manage
                  </button>
                ) : (
                  <span className="muted">—</span>
                )}
              </td>
            </tr>
            <tr>
              <td>QuickBooks Online</td>
              <td className="muted">Sandbox company — writes go only to the sandbox.</td>
              <td>
                {owner ? (
                  <button disabled title="Connections are provisioned via configuration">
                    Manage
                  </button>
                ) : (
                  <span className="muted">—</span>
                )}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="panel">
        <h2>Automation level</h2>
        <p className="muted">
          Managed via configuration. Proposals are held for human review unless automation is
          enabled during onboarding.
        </p>
        <div className="kv" style={{ display: 'grid', gridTemplateColumns: '200px 1fr', gap: 6 }}>
          <span className="muted">Current mode</span>
          <span>Review required (read-only view)</span>
        </div>
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
