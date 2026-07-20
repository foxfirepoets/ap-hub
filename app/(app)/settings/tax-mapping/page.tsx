'use client';

import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useSession } from '../../../lib/session';
import { canApprovePost } from '../../../lib/permissions';
import { apiGet, apiPost, ApiError } from '../../../lib/api';
import type { TaxMapping } from '../../../lib/types';
import { TaxMappingTable } from './_components/TaxMappingTable';
import { TaxMappingForm, type TaxMappingFormValues } from './_components/TaxMappingForm';
import { NotAuthorized } from './_components/NotAuthorized';

type Filter = 'active' | 'exception' | 'all';
type Notice = { kind: 'good' | 'bad'; text: string };

// Tax-code mapping settings: list (filterable) + create. Edit/disable/replace/revalidate
// live on the detail page (app/(app)/settings/tax-mapping/[id]/page.tsx).
export default function TaxMappingPage() {
  const me = useSession();
  const owner = canApprovePost(me.role);
  const params = useSearchParams();

  const [filter, setFilter] = useState<Filter>('active');
  const [mappings, setMappings] = useState<TaxMapping[]>([]);
  const [loadError, setLoadError] = useState<{ status: number; message: string } | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  const load = useCallback(() => {
    if (!owner) return;
    setLoadError(null);
    apiGet<{ mappings: TaxMapping[] }>(`/api/tax-mappings?filter=${filter}`)
      .then((res) => setMappings(res.mappings))
      .catch((err: unknown) => {
        if (err instanceof ApiError) setLoadError({ status: err.status, message: err.message });
        else setLoadError({ status: 0, message: 'Failed to load tax mappings.' });
      });
  }, [filter, owner]);

  useEffect(load, [load]);

  // A "fix this" link from the exceptions queue can prefill the create form via query params.
  useEffect(() => {
    if (params.get('providerTaxCode') || params.get('connectionId')) setShowCreate(true);
  }, [params]);

  const doCreate = useCallback(
    async (v: TaxMappingFormValues) => {
      setBusy(true);
      setNotice(null);
      try {
        const res = await apiPost<{ mapping: TaxMapping }>('/api/tax-mappings', {
          connectionId: Number(v.connectionId),
          provider: v.provider,
          providerTaxCode: v.providerTaxCode,
          internalTaxTreatment: v.internalTaxTreatment,
          taxMode: v.taxMode,
          appliesAt: v.appliesAt,
          reason: v.reason || undefined,
        });
        if (res.ok && res.data) {
          setNotice({ kind: 'good', text: `Created mapping for ${res.data.mapping.provider_tax_code}.` });
          setShowCreate(false);
          load();
        } else {
          setNotice({ kind: 'bad', text: res.error?.message ?? `Create failed (${res.status}).` });
        }
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  if (!owner) return <NotAuthorized />;
  if (loadError?.status === 403) return <NotAuthorized detail={loadError.message} />;

  return (
    <div data-testid="tax-mapping-page">
      <h1>Tax-code mapping</h1>
      <p className="page-sub">
        Maps provider tax codes (QuickBooks Online) to this tenant&apos;s internal tax treatment. Owner-only.
      </p>

      {notice ? <div className={`notice ${notice.kind}`} data-testid="tax-mapping-notice">{notice.text}</div> : null}
      {loadError ? <div className="notice bad">{loadError.message}</div> : null}

      <div className="panel">
        <div className="btn-row" style={{ justifyContent: 'space-between' }}>
          <div className="btn-row">
            {(['active', 'exception', 'all'] as Filter[]).map((f) => (
              <button key={f} className={filter === f ? 'primary' : ''} onClick={() => setFilter(f)} data-testid={`tax-mapping-filter-${f}`}>
                {f}
              </button>
            ))}
          </div>
          <button onClick={() => setShowCreate((v) => !v)} data-testid="tax-mapping-new-btn">
            {showCreate ? 'Close' : 'New mapping'}
          </button>
        </div>
      </div>

      {showCreate ? (
        <TaxMappingForm
          mode="create"
          busy={busy}
          defaults={{ connectionId: params.get('connectionId') ?? '', providerTaxCode: params.get('providerTaxCode') ?? '' }}
          onSubmit={doCreate}
          onCancel={() => setShowCreate(false)}
        />
      ) : null}

      <div className="panel">
        <TaxMappingTable mappings={mappings} />
      </div>
    </div>
  );
}
