// Small pure presentation helpers (no business logic). Money is rendered as a plain string
// with a leading amount; NUMERIC values arrive as strings from the API and are shown as-is.

export function money(total: string | null): string {
  if (total == null || total === '') return '—';
  return total;
}

export function pct(confidence: number): string {
  if (!Number.isFinite(confidence)) return '—';
  const v = confidence <= 1 ? confidence * 100 : confidence;
  return `${Math.round(v)}%`;
}

export function when(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export function shortSha(sha: string): string {
  return sha.length > 12 ? `${sha.slice(0, 12)}…` : sha;
}
