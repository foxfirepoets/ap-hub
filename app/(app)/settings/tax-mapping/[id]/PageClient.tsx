'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useSession } from '../../../../lib/session';
import { canApprovePost } from '../../../../lib/permissions';
import { apiGet, apiPost, ApiError } from '../../../../lib/api';
import type { TaxMapping } from '../../../../lib/types';
import { TaxMappingDetailInfo } from '../_components/TaxMappingDetailInfo';
import { TaxMappingDetailBar } from '../_components/TaxMappingDetailBar';
import { TaxMappingEditForm, type EditValues } from '../_components/TaxMappingEditForm';
import { TaxMappingForm, type TaxMappingFormValues } from '../_components/TaxMappingForm';
import { AuditTrailPanel } from '../_components/AuditTrailPanel';
import { NotAuthorized } from '../_components/NotAuthorized';

type Notice = { kind: 'good' | 'bad'; text: string };
type Panel = 'none' | 'edit' | 'replace';

export default function TaxMappingDetailPage() {
  const me = useSession();
  const owner = canApprovePost(me.role);
  const router = useRouter();
  const params = useParams<{ id: string }>();
  // SPIKE: static export bakes useParams() to the build-time sentinel; the real id must be
  // read from the actual loaded URL instead.
  const id = typeof window !== 'undefined' ? window.location.pathname.split('/').pop() : params.id;

  const [mapping, setMapping] = useState<TaxMapping | null>(null);
  const [loadError, setLoadError] = useState<{ status: number; message: string } | null>(null);
  const [panel, setPanel] = useState<Panel>('none');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  const load = useCallback(() => {
    if (!owner) return;
    apiGet<{ mapping: TaxMapping }>(`/api/tax-mappings/${id}`)
      .then((res) => setMapping(res.mapping))
      .catch((err: unknown) => {
        if (err instanceof ApiError) setLoadError({ status: err.status, message: err.message });
        else setLoadError({ status: 0, message: 'Failed to load this tax mapping.' });
      });
  }, [id, owner]);

  useEffect(load, [load]);

  const doDisable = useCallback(async () => {
    const reason = window.prompt('Reason for disabling this mapping?');
    if (!reason || !reason.trim()) return;
    setBusy(true);
    try {
      const res = await apiPost<{ mapping: TaxMapping }>(`/api/tax-mappings/${id}/disable`, { reason: reason.trim() });
      if (res.ok && res.data) {
        setMapping(res.data.mapping);
        setNotice({ kind: 'good', text: 'Mapping disabled.' });
      } else setNotice({ kind: 'bad', text: res.error?.message ?? 'Disable failed.' });
    } finally {
      setBusy(false);
    }
  }, [id]);

  const doRevalidate = useCallback(async () => {
    setBusy(true);
    try {
      const res = await apiPost<{ mapping: TaxMapping }>(`/api/tax-mappings/${id}/revalidate`, {});
      if (res.ok && res.data) {
        setMapping(res.data.mapping);
        setNotice({
          kind: res.data.mapping.active ? 'good' : 'bad',
          text: res.data.mapping.active ? 'Revalidated: still supported by the provider.' : 'Revalidation failed: provider no longer supports this code.',
        });
      } else setNotice({ kind: 'bad', text: res.error?.message ?? 'Revalidate failed.' });
    } finally {
      setBusy(false);
    }
  }, [id]);

  const doEdit = useCallback(
    async (v: EditValues) => {
      setBusy(true);
      try {
        const res = await apiPost<{ mapping: TaxMapping }>(`/api/tax-mappings/${id}/edit`, v);
        if (res.ok && res.data) {
          setMapping(res.data.mapping);
          setPanel('none');
          setNotice({ kind: 'good', text: 'Saved. Marked needs-revalidation until re-checked.' });
        } else setNotice({ kind: 'bad', text: res.error?.message ?? 'Edit failed.' });
      } finally {
        setBusy(false);
      }
    },
    [id],
  );

  const doReplace = useCallback(
    async (v: TaxMappingFormValues) => {
      setBusy(true);
      try {
        const res = await apiPost<{ old: TaxMapping; replacement: TaxMapping }>(`/api/tax-mappings/${id}/replace`, v);
        if (res.ok && res.data) {
          router.push(`/settings/tax-mapping/${res.data.replacement.id}`);
        } else setNotice({ kind: 'bad', text: res.error?.message ?? 'Replace failed.' });
      } finally {
        setBusy(false);
      }
    },
    [id, router],
  );

  if (!owner) return <NotAuthorized />;
  if (loadError?.status === 403) return <NotAuthorized detail={loadError.message} />;
  if (loadError) return <div className="notice bad">{loadError.message}</div>;
  if (!mapping) return <p className="muted">Loading…</p>;

  return (
    <div data-testid="tax-mapping-detail-page">
      <h1>Tax mapping #{mapping.id}</h1>
      {notice ? <div className={`notice ${notice.kind}`} data-testid="tax-mapping-detail-notice">{notice.text}</div> : null}

      <div className="panel">
        <TaxMappingDetailInfo mapping={mapping} />
        <div style={{ marginTop: 12 }}>
          <TaxMappingDetailBar
            mapping={mapping}
            busy={busy}
            onEdit={() => setPanel((p) => (p === 'edit' ? 'none' : 'edit'))}
            onDisable={doDisable}
            onReplace={() => setPanel((p) => (p === 'replace' ? 'none' : 'replace'))}
            onRevalidate={doRevalidate}
          />
        </div>
      </div>

      {panel === 'edit' ? <TaxMappingEditForm mapping={mapping} busy={busy} onSubmit={doEdit} onCancel={() => setPanel('none')} /> : null}
      {panel === 'replace' ? (
        <TaxMappingForm
          mode="replace"
          busy={busy}
          defaults={{
            providerTaxCode: mapping.provider_tax_code,
            internalTaxTreatment: mapping.internal_tax_treatment,
            taxMode: mapping.tax_mode,
            appliesAt: mapping.applies_at,
          }}
          onSubmit={doReplace}
          onCancel={() => setPanel('none')}
        />
      ) : null}

      <AuditTrailPanel mapping={mapping} />
    </div>
  );
}
