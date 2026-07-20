import type { DimensionMappingRow } from '../../../../lib/types';
import { ResolutionBadge } from './ResolutionBadge';
import { ReviewStatusBadge } from './ReviewStatusBadge';

export interface DimensionQueueProps {
  rows: DimensionMappingRow[];
  selectedId: number | null;
  onSelect: (id: number) => void;
}

// Compact left-hand list — one row per dimension_mapping, mirrors the exceptions page's
// "queue" pattern. Full field detail lives in DimensionDetailPanel for the selected row.
export function DimensionQueue({ rows, selectedId, onSelect }: DimensionQueueProps) {
  return (
    <div className="queue" data-testid="dimension-queue">
      {rows.map((r) => (
        <div
          key={r.id}
          className={`qrow${r.id === selectedId ? ' selected' : ''}`}
          onClick={() => onSelect(r.id)}
          data-testid={`dimension-row-${r.id}`}
        >
          <div className="qtitle">
            {r.dimension_type} · {r.raw_value}
          </div>
          <div className="qmeta btn-row" style={{ gap: 6, marginTop: 4 }}>
            <ResolutionBadge state={r.resolution_state} />
            <ReviewStatusBadge status={r.review_status} />
            {!r.active ? <span className="badge rv-held">inactive</span> : null}
          </div>
        </div>
      ))}
      {rows.length === 0 ? <div className="qrow muted">No dimension mappings match these filters.</div> : null}
    </div>
  );
}
