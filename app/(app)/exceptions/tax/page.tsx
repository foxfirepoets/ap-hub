'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSession } from '../../../lib/session';
import { canApprovePost } from '../../../lib/permissions';
import { apiGet, ApiError } from '../../../lib/api';
import { when } from '../../../lib/format';
import type { TaxMapping } from '../../../lib/types';
import { classifyTaxMapping, TaxMappingStatusBadge } from '../../settings/tax-mapping/_components/TaxMappingStatus';
import { NotAuthorized } from '../../settings/tax-mapping/_components/NotAuthorized';

// Unmapped/exception tax-mapping queue. Sourced entirely from GET /api/tax-mappings?filter=all
// (there is no separate "exceptions" table for tax; exceptions/page.tsx's generic queue is a
// different domain — proposal-level reasonCodes — and has no tax-mapping-aware filter, so
// this is a dedicated page rather than a bolt-on section, per the task's own "extend rather
// than duplicate if a pattern already exists" instruction: no such pattern exists here).
export default function TaxExceptionsPage() {
  const me = useSession();
  const owner = canApprovePost(me.role);

  const [rows, setRows] = useState<TaxMapping[] | null>(null);
  const [loadError, setLoadError] = useState<{ status: number; message: string } | null>(null);

  const load = useCallback(() => {
    if (!owner) return;
    apiGet<{ mappings: TaxMapping[] }>('/api/tax-mappings?filter=all')
      .then((res) => setRows(res.mappings))
      .catch((err: unknown) => {
        if (err instanceof ApiError) setLoadError({ status: err.status, message: err.message });
        else setLoadError({ status: 0, message: 'Failed to load tax mappings.' });
      });
  }, [owner]);

  useEffect(load, [load]);

  if (!owner) return <NotAuthorized />;
  if (loadError?.status === 403) return <NotAuthorized detail={loadError.message} />;
  if (loadError) return <div className="notice bad">{loadError.message}</div>;

  const attention = (rows ?? []).filter((m) => {
    const state = classifyTaxMapping(m);
    return state === 'needs_revalidation' || state === 'unsupported' || state === 'disabled';
  });

  return (
    <div data-testid="tax-exceptions-page">
      <h1>Tax mapping exceptions</h1>
      <p className="page-sub">
        Mapping-configuration rows needing attention: stale (needs revalidation), unsupported (provider rejected the
        code on revalidation), or disabled with no active replacement.
      </p>
      <p className="notice warn" data-testid="tax-exceptions-scope-notice">
        This queue covers the tax-code MAPPING CONFIGURATION only. A provider tax code seen on a specific invoice
        that was never mapped at all ("missing") is a per-transaction resolution issue tracked as its own row in{' '}
        <Link href="/exceptions/dimensions">Dimension mapping review</Link> — open it and filter Type to{' '}
        <code>tax_code</code> to see those.
      </p>

      {rows === null ? (
        <p className="muted">Loading…</p>
      ) : attention.length === 0 ? (
        <div className="panel muted">No tax-mapping exceptions. Queue clear.</div>
      ) : (
        <div className="queue" data-testid="tax-exceptions-queue">
          {attention.map((m) => (
            <div key={m.id} className="qrow" data-testid={`tax-exception-row-${m.id}`}>
              <div className="qtitle">
                {m.provider} · <span className="mono">{m.provider_tax_code}</span> <TaxMappingStatusBadge mapping={m} />
              </div>
              <div className="qmeta">
                {m.internal_tax_treatment} · connection {m.connection_id} · updated {when(m.updated_at)}
              </div>
              <div className="btn-row" style={{ marginTop: 6 }}>
                <Link href={`/settings/tax-mapping/${m.id}`}>View / fix</Link>
                <Link
                  href={`/settings/tax-mapping?connectionId=${m.connection_id}&providerTaxCode=${encodeURIComponent(m.provider_tax_code)}`}
                >
                  Create replacement mapping
                </Link>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
