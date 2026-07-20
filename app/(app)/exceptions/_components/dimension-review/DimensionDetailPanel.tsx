'use client';

import { useSession } from '../../../../lib/session';
import { canApprovePost } from '../../../../lib/permissions';
import { pct, when } from '../../../../lib/format';
import type { DimensionMappingRow } from '../../../../lib/types';
import { ResolutionBadge } from './ResolutionBadge';
import { ReviewStatusBadge } from './ReviewStatusBadge';

export interface DimensionDetailPanelProps {
  row: DimensionMappingRow;
  busy: boolean;
  onAccept: () => void;
  onOpenSelectAlternate: () => void;
  onOpenCorrect: () => void;
  onSaveRule: () => void;
  onOpenRejectHold: () => void;
}

// Every field the release spec requires per row, plus the five reviewer actions. All five
// actions are owner_controller-only server-side (readContext(..., 'owner_controller') in
// src/services/action/dimensionMappings.ts) — hiding the buttons for anyone else is UI
// convenience only; the routes re-check and 403 regardless.
export function DimensionDetailPanel({
  row,
  busy,
  onAccept,
  onOpenSelectAlternate,
  onOpenCorrect,
  onSaveRule,
  onOpenRejectHold,
}: DimensionDetailPanelProps) {
  const me = useSession();
  const canAct = canApprovePost(me.role);
  const canSaveRule = row.provider_id != null && row.provider_id !== '';

  return (
    <div className="panel" data-testid="dimension-detail">
      <div className="btn-row" style={{ marginBottom: 10 }}>
        <ResolutionBadge state={row.resolution_state} />
        <ReviewStatusBadge status={row.review_status} />
        {!row.active ? <span className="badge rv-held">inactive</span> : null}
      </div>

      <div className="dim-fields">
        <span className="k">Dimension type</span>
        <span>{row.dimension_type}</span>
        <span className="k">Raw extracted value</span>
        <span>{row.raw_value || '—'}</span>
        <span className="k">Normalized value</span>
        <span>{row.normalized_value ?? '—'}</span>
        <span className="k">Source evidence</span>
        <span className="mono">{JSON.stringify(row.source_evidence)}</span>
        <span className="k">Extraction confidence</span>
        <span>{pct(row.extraction_confidence)}</span>
        <span className="k">Proposed match</span>
        <span>{row.proposed_match_label ?? '—'}</span>
        <span className="k">Proposed provider ID</span>
        <span className="mono">{row.proposed_provider_id ?? '—'}</span>
        <span className="k">Resolved provider ID</span>
        <span className="mono">{row.provider_id ?? '—'}</span>
        <span className="k">Mapping method</span>
        <span>{row.mapping_method ?? '—'}</span>
        <span className="k">Company / connection</span>
        <span>
          {row.provider} · connection #{row.connection_id}
        </span>
        <span className="k">Active</span>
        <span>{row.active ? 'Active' : 'Inactive'}</span>
        <span className="k">Last revalidated</span>
        <span>{when(row.revalidated_at)}</span>
        <span className="k">Updated</span>
        <span>{when(row.updated_at)}</span>
      </div>

      {canAct ? (
        <div className="btn-row" style={{ marginTop: 14 }}>
          <button
            className="primary"
            disabled={busy || row.proposed_provider_id == null}
            onClick={onAccept}
            data-testid="accept-btn"
            title={row.proposed_provider_id == null ? 'No proposed mapping to accept' : 'Accept proposed mapping'}
          >
            Accept
          </button>
          <button disabled={busy} onClick={onOpenSelectAlternate} data-testid="select-alternate-btn">
            Select alternate…
          </button>
          <button disabled={busy} onClick={onOpenCorrect} data-testid="correct-btn">
            Correct value…
          </button>
          <button
            disabled={busy || !canSaveRule}
            onClick={onSaveRule}
            data-testid="save-rule-btn"
            title={canSaveRule ? 'Save as a reusable rule' : 'Resolve a provider ID first (accept or select alternate)'}
          >
            Save as rule
          </button>
          <button className="danger" disabled={busy} onClick={onOpenRejectHold} data-testid="reject-hold-btn">
            Reject / Hold…
          </button>
        </div>
      ) : (
        <div className="muted" style={{ marginTop: 14 }} data-testid="read-only-notice">
          Read-only — dimension mapping review is owner-only.
        </div>
      )}
    </div>
  );
}
