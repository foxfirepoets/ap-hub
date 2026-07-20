const DIMENSION_TYPES = [
  'account',
  'item',
  'class',
  'location',
  'department',
  'customer',
  'project',
  'job',
  'tracking_category',
  'entity',
  'tax_code',
  'currency',
];

const REVIEW_STATUSES = ['pending', 'accepted', 'corrected', 'rejected', 'held'];

const RESOLUTION_STATES = [
  'mapped',
  'not_provided',
  'not_mapped',
  'unsupported_by_provider',
  'intentionally_blank',
];

export interface DimensionFilterValues {
  dimensionType: string;
  reviewStatus: string;
  resolutionState: string;
}

export interface DimensionFiltersProps {
  value: DimensionFilterValues;
  onChange: (v: DimensionFilterValues) => void;
}

// Filter bar: one select per filterable dimension (type / review_status / resolution_state).
// "all" (empty string) omits the query param entirely, matching the API's optional filters.
export function DimensionFilters({ value, onChange }: DimensionFiltersProps) {
  return (
    <div className="btn-row" style={{ marginBottom: 16 }} data-testid="dimension-filters">
      <label className="muted">
        Type{' '}
        <select
          value={value.dimensionType}
          onChange={(e) => onChange({ ...value, dimensionType: e.target.value })}
          data-testid="filter-dimension-type"
        >
          <option value="">all</option>
          {DIMENSION_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </label>
      <label className="muted">
        Review status{' '}
        <select
          value={value.reviewStatus}
          onChange={(e) => onChange({ ...value, reviewStatus: e.target.value })}
          data-testid="filter-review-status"
        >
          <option value="">all</option>
          {REVIEW_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
      <label className="muted">
        Resolution{' '}
        <select
          value={value.resolutionState}
          onChange={(e) => onChange({ ...value, resolutionState: e.target.value })}
          data-testid="filter-resolution-state"
        >
          <option value="">all</option>
          {RESOLUTION_STATES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
