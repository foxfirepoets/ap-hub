'use client';

import { useSession } from '../lib/session';
import { canApprovePost, canReview } from '../lib/permissions';

// Role-gated action buttons for a single item. Pure presentation: the parent owns the
// action logic (so the keyboard shortcuts and these buttons call exactly ONE code path).
// Owner_controller: Approve (posts through the environment-gated QBO writer). Bookkeeper: no post — shows
// "Send to Owner" instead. CPA: read-only (only "Open source"). Hiding a button never
// grants access — every action route re-checks the role server-side.
export interface ActionBarProps {
  hasProposal: boolean;
  busy?: boolean;
  onApprove: () => void;
  onSendToOwner: () => void;
  onReject: () => void;
  onEdit: () => void;
  onOpenSource: () => void;
  hasSource: boolean;
}

export function ActionBar(props: ActionBarProps) {
  const me = useSession();
  const owner = canApprovePost(me.role);
  const reviewer = canReview(me.role);

  return (
    <div className="btn-row" data-testid="action-bar">
      {owner ? (
        <button
          className="primary"
          onClick={props.onApprove}
          disabled={props.busy || !props.hasProposal}
          data-testid="approve-btn"
          title="Approve and post to QuickBooks (A)"
        >
          Approve <span className="kbd">A</span>
        </button>
      ) : reviewer ? (
        <button
          onClick={props.onSendToOwner}
          disabled={props.busy || !props.hasProposal}
          data-testid="send-to-owner-btn"
          title="Bookkeepers cannot post — escalate to the owner"
        >
          Send to Owner
        </button>
      ) : null}

      {reviewer ? (
        <>
          <button
            className="danger"
            onClick={props.onReject}
            disabled={props.busy || !props.hasProposal}
            data-testid="reject-btn"
            title="Reject (R)"
          >
            Reject <span className="kbd">R</span>
          </button>
          <button
            onClick={props.onEdit}
            disabled={props.busy}
            data-testid="edit-btn"
            title="Edit mapping (E)"
          >
            Edit mapping <span className="kbd">E</span>
          </button>
        </>
      ) : null}

      <button
        onClick={props.onOpenSource}
        disabled={!props.hasSource}
        data-testid="open-source-btn"
        title="Open source email (O)"
      >
        Open source <span className="kbd">O</span>
      </button>

      {!reviewer && !owner ? <span className="muted">Read-only (CPA)</span> : null}
    </div>
  );
}
