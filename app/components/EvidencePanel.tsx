'use client';

import { useEffect, useState } from 'react';
import { apiGet, ApiError } from '../lib/api';
import { pct, when, shortSha } from '../lib/format';
import type { Evidence } from '../lib/types';

// Shared evidence chain for one item (proposal). Used by Today, Exceptions, and the
// Transactions detail. Renders the source email, the attachment (or a "missing" marker),
// the extracted fields + confidence, the prior mapping rule, proof references, and the QBO
// link once posted. Pure presentation — it only reads GET /api/items/:id/evidence.
export function EvidencePanel({
  proposalId,
  onLoaded,
}: {
  proposalId: number;
  onLoaded?: (ev: Evidence) => void;
}) {
  const [ev, setEv] = useState<Evidence | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    apiGet<Evidence>(`/api/items/${proposalId}/evidence`)
      .then((data) => {
        if (active) {
          setEv(data);
          onLoaded?.(data);
        }
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof ApiError ? err.message : 'Failed to load evidence');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [proposalId]);

  if (loading) return <div className="muted">Loading evidence…</div>;
  if (error) return <div className="notice bad">{error}</div>;
  if (!ev) return <div className="muted">No evidence.</div>;

  const isMissing = (piece: string) => ev.missing.includes(piece);

  return (
    <div className="evidence" data-testid="evidence-panel">
      <div className="btn-row">
        <span className={`badge ${ev.status}`}>{ev.status}</span>
        <span className="muted">confidence {pct(ev.confidence)}</span>
      </div>

      <h3>Source email</h3>
      {ev.email ? (
        <div className="kv">
          <span className="k">Subject</span>
          <span>{ev.email.subject ?? '—'}</span>
          <span className="k">From</span>
          <span>{ev.email.from ?? '—'}</span>
          <span className="k">Received</span>
          <span>{when(ev.email.receivedAt)}</span>
          <span className="k">Gmail ID</span>
          <span className="mono">{ev.email.gmailMessageId ?? '—'}</span>
        </div>
      ) : (
        <div className="missing">email missing</div>
      )}

      <h3>Attachment</h3>
      {ev.attachment ? (
        <div className="kv">
          <span className="k">File</span>
          <span>{ev.attachment.filename ?? '—'}</span>
          <span className="k">Type</span>
          <span>{ev.attachment.mime ?? '—'}</span>
          <span className="k">SHA-256</span>
          <span className="mono" title={ev.attachment.sha256}>
            {shortSha(ev.attachment.sha256)}
          </span>
        </div>
      ) : (
        <div className="missing" data-testid="attachment-missing">
          {isMissing('attachment') ? 'attachment missing' : '—'}
        </div>
      )}

      <h3>Extracted fields</h3>
      {ev.extraction ? (
        <>
          <div className="fields">
            {Object.entries(ev.extraction.fields).map(([k, v]) => (
              <FieldRow key={k} name={k} value={v} />
            ))}
          </div>
          <div className="muted" style={{ marginTop: 6 }}>
            confidence {pct(ev.extraction.confidence)}
            {ev.extraction.missingFields.length > 0
              ? ` · missing: ${ev.extraction.missingFields.join(', ')}`
              : ''}
            {ev.extraction.flags.length > 0 ? ` · flags: ${ev.extraction.flags.join(', ')}` : ''}
          </div>
        </>
      ) : (
        <div className="missing">extraction missing</div>
      )}

      <h3>Prior rule</h3>
      {ev.priorRule ? (
        <div className="kv">
          <span className="k">Kind</span>
          <span>{ev.priorRule.kind}</span>
          <span className="k">Source key</span>
          <span>{ev.priorRule.sourceKey}</span>
          <span className="k">Maps to</span>
          <span>
            {ev.priorRule.targetName ?? ev.priorRule.targetQboId ?? '—'}
            {ev.priorRule.targetQboType ? ` (${ev.priorRule.targetQboType})` : ''}
          </span>
          {ev.priorRule.learnedFrom ? (
            <>
              <span className="k">Learned from</span>
              <span>{ev.priorRule.learnedFrom}</span>
            </>
          ) : null}
        </div>
      ) : (
        <div className="muted">No prior rule for this vendor.</div>
      )}

      <h3>Proof references</h3>
      {ev.proofs.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>Product</th>
              <th>Entity</th>
              <th>Verdict</th>
              <th>Proof ID</th>
            </tr>
          </thead>
          <tbody>
            {ev.proofs.map((p, i) => (
              <tr key={i}>
                <td>{p.product}</td>
                <td>{p.entityKind}</td>
                <td>{p.verdict ?? '—'}</td>
                <td className="mono">{p.proofId ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="muted">No proof references recorded.</div>
      )}

      <h3>QuickBooks</h3>
      {ev.qboLink ? (
        <div>
          <a href={ev.qboLink} target="_blank" rel="noreferrer" data-testid="qbo-link">
            Open in QuickBooks (sandbox)
          </a>
          {ev.posting ? (
            <span className="muted">
              {' '}
              · {ev.posting.qboType} #{ev.posting.qboId}
            </span>
          ) : null}
        </div>
      ) : (
        <div className="muted">Not yet posted.</div>
      )}
    </div>
  );
}

function FieldRow({ name, value }: { name: string; value: unknown }) {
  const rendered =
    value === null || value === undefined
      ? '—'
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value);
  return (
    <>
      <span className="k" style={{ color: 'var(--muted)' }}>
        {name}
      </span>
      <span>{rendered}</span>
    </>
  );
}
