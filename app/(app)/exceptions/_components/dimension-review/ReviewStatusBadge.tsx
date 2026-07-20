const REVIEW_LABELS: Record<string, string> = {
  pending: 'Pending',
  accepted: 'Accepted',
  corrected: 'Corrected',
  rejected: 'Rejected',
  held: 'Held',
};

export function ReviewStatusBadge({ status }: { status: string }) {
  return (
    <span className={`badge rv-${status}`} data-testid="review-status-badge">
      {REVIEW_LABELS[status] ?? status}
    </span>
  );
}
