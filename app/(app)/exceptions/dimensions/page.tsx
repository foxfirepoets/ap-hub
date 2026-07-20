'use client';

import { useState } from 'react';
import Link from 'next/link';
import { DimensionFilters, type DimensionFilterValues } from '../_components/dimension-review/DimensionFilters';
import { DimensionQueue } from '../_components/dimension-review/DimensionQueue';
import { DimensionDetailPanel } from '../_components/dimension-review/DimensionDetailPanel';
import { SelectAlternateModal } from '../_components/dimension-review/SelectAlternateModal';
import { CorrectModal } from '../_components/dimension-review/CorrectModal';
import { RejectHoldModal } from '../_components/dimension-review/RejectHoldModal';
import { useDimensionMappings } from '../_components/dimension-review/useDimensionMappings';

// One reviewer surface for all 12 dimension types (F_DIMENSION_MAPPING_API), consuming
// GET/POST /api/dimension-mappings/**. Layout mirrors app/(app)/exceptions/page.tsx's
// queue + detail split; the data shape (typed dimension rows, five distinct actions,
// five-state resolution) doesn't fit that page's generic ExceptionRow, so it lives here.
// Data fetching + action wiring lives in useDimensionMappings; this file is pure layout.
export default function DimensionReviewPage() {
  const [filters, setFilters] = useState<DimensionFilterValues>({
    dimensionType: '',
    reviewStatus: '',
    resolutionState: '',
  });
  const m = useDimensionMappings(filters);

  if (m.forbidden) {
    return (
      <div className="notice bad" data-testid="dimension-forbidden">
        Not authorized — dimension mapping review is available to the account owner only.
      </div>
    );
  }
  if (m.error) return <div className="notice bad">{m.error}</div>;

  return (
    <div data-testid="dimension-review-page">
      <h1>Dimension mapping review</h1>
      <p className="page-sub">
        All 12 dimension types in one queue — account, item, class, location, department, customer,
        project, job, tracking category, entity, tax code, currency. <Link href="/exceptions">Back to exceptions</Link>
      </p>

      {m.notice ? (
        <div className={`notice ${m.notice.kind}`} data-testid="dimension-notice">
          {m.notice.text}
        </div>
      ) : null}

      <DimensionFilters value={filters} onChange={setFilters} />

      <div className="split">
        <DimensionQueue rows={m.rows} selectedId={m.selectedId} onSelect={m.setSelectedId} />
        <div>
          {m.selected ? (
            <DimensionDetailPanel
              row={m.selected}
              busy={m.busy}
              onAccept={m.doAccept}
              onOpenSelectAlternate={() => m.setModal('select-alternate')}
              onOpenCorrect={() => m.setModal('correct')}
              onSaveRule={m.doSaveRule}
              onOpenRejectHold={() => m.setModal('reject-hold')}
            />
          ) : (
            <div className="panel muted">No dimension mapping selected.</div>
          )}
        </div>
      </div>

      {m.selected && m.modal === 'select-alternate' ? (
        <SelectAlternateModal
          currentLabel={m.selected.proposed_match_label}
          busy={m.busy}
          onSubmit={m.doSelectAlternate}
          onCancel={() => m.setModal(null)}
        />
      ) : null}
      {m.selected && m.modal === 'correct' ? (
        <CorrectModal
          defaultValue={m.selected.normalized_value ?? m.selected.raw_value}
          busy={m.busy}
          onSubmit={m.doCorrect}
          onCancel={() => m.setModal(null)}
        />
      ) : null}
      {m.selected && m.modal === 'reject-hold' ? (
        <RejectHoldModal busy={m.busy} onSubmit={m.doRejectHold} onCancel={() => m.setModal(null)} />
      ) : null}
    </div>
  );
}
