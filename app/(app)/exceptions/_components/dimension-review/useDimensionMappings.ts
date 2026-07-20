import { useEffect, useMemo, useState } from 'react';
import { apiGet, apiPost, ApiError } from '../../../../lib/api';
import type { DimensionMappingRow } from '../../../../lib/types';
import type { DimensionFilterValues } from './DimensionFilters';
import type { SelectAlternateInput } from './SelectAlternateModal';
import type { CorrectInput } from './CorrectModal';
import type { RejectHoldInput } from './RejectHoldModal';

export type Notice = { kind: 'good' | 'warn' | 'bad'; text: string };
export type ModalKind = 'select-alternate' | 'correct' | 'reject-hold' | null;

function buildQuery(f: DimensionFilterValues): string {
  const params = new URLSearchParams();
  if (f.dimensionType) params.set('dimensionType', f.dimensionType);
  if (f.reviewStatus) params.set('reviewStatus', f.reviewStatus);
  if (f.resolutionState) params.set('resolutionState', f.resolutionState);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

// Data + action layer for the dimension-review page: list fetch (re-run on filter change)
// and the five reviewer actions, each a thin POST to app/api/dimension-mappings/:id/**.
// Kept out of page.tsx so the page stays pure layout/composition under the 150-line rule.
export function useDimensionMappings(filters: DimensionFilterValues) {
  const [rows, setRows] = useState<DimensionMappingRow[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState<ModalKind>(null);

  useEffect(() => {
    let active = true;
    setError(null);
    setForbidden(false);
    apiGet<{ mappings: DimensionMappingRow[] }>(`/api/dimension-mappings${buildQuery(filters)}`)
      .then((data) => {
        if (!active) return;
        setRows(data.mappings);
        setSelectedId((prev) =>
          prev != null && data.mappings.some((r) => r.id === prev) ? prev : (data.mappings[0]?.id ?? null),
        );
      })
      .catch((err: unknown) => {
        if (!active) return;
        if (err instanceof ApiError && err.status === 403) setForbidden(true);
        else setError(err instanceof ApiError ? err.message : 'Failed to load dimension mappings');
      });
    return () => {
      active = false;
    };
  }, [filters]);

  const selected = useMemo(() => rows.find((r) => r.id === selectedId) ?? null, [rows, selectedId]);

  function applyUpdatedRow(row: DimensionMappingRow) {
    setRows((prev) => prev.map((r) => (r.id === row.id ? row : r)));
  }

  async function runAction<T>(path: string, body: unknown, onOk: (data: T) => void, okText: string) {
    if (!selected || busy) return;
    setBusy(true);
    try {
      const res = await apiPost<T>(`/api/dimension-mappings/${selected.id}${path}`, body);
      if (res.status === 403) {
        setForbidden(true);
        return;
      }
      if (res.ok && res.data) {
        onOk(res.data);
        setNotice({ kind: 'good', text: okText });
        setModal(null);
      } else {
        setNotice({ kind: 'bad', text: res.error?.message ?? 'Action failed.' });
      }
    } finally {
      setBusy(false);
    }
  }

  return {
    rows,
    selectedId,
    setSelectedId,
    selected,
    error,
    forbidden,
    notice,
    busy,
    modal,
    setModal,
    doAccept: () =>
      runAction<{ mapping: DimensionMappingRow }>('/accept', {}, (d) => applyUpdatedRow(d.mapping), 'Mapping accepted.'),
    doSelectAlternate: (input: SelectAlternateInput) =>
      runAction<{ mapping: DimensionMappingRow }>(
        '/select-alternate',
        input,
        (d) => applyUpdatedRow(d.mapping),
        'Alternate provider value applied.',
      ),
    doCorrect: (input: CorrectInput) =>
      runAction<{ mapping: DimensionMappingRow }>('/correct', input, (d) => applyUpdatedRow(d.mapping), 'Value corrected.'),
    doSaveRule: () => runAction<{ rule: unknown }>('/save-rule', {}, () => undefined, 'Saved as a reusable rule.'),
    doRejectHold: (input: RejectHoldInput) =>
      runAction<{ mapping: DimensionMappingRow }>(
        '/reject',
        input,
        (d) => applyUpdatedRow(d.mapping),
        input.status === 'held' ? 'Held for review.' : 'Rejected.',
      ),
  };
}
