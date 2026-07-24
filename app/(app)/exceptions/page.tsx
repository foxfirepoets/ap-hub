'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { apiGet, apiPost, ApiError, proposalRefId } from '../../lib/api';
import { when } from '../../lib/format';
import { friendlyOnboardingError } from '../../lib/onboardingErrors.js';
import { EvidencePanel } from '../../components/EvidencePanel';
import { ActionBar } from '../../components/ActionBar';
import { RemapForm, type RemapValues } from '../../components/RemapForm';
import type { ExceptionRow, Evidence, ApprovePosted } from '../../lib/types';
import type { ActionResult } from '../../lib/api';
import { ReplyDraftPanel } from './_components/ReplyDraftPanel';

type Notice = { kind: 'good' | 'warn' | 'bad'; text: string; qboLink?: string | null };

function gmailUrl(gmailMessageId: string | null): string | null {
  return gmailMessageId ? `https://mail.google.com/mail/u/0/#all/${gmailMessageId}` : null;
}

export default function ExceptionsPage() {
  const [items, setItems] = useState<ExceptionRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selIdx, setSelIdx] = useState(0);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [evidence, setEvidence] = useState<Evidence | null>(null);
  const evidenceRef = useRef<Evidence | null>(null);

  useEffect(() => {
    let active = true;
    apiGet<ExceptionRow[]>('/api/exceptions?status=open')
      .then((rows) => {
        if (active) setItems(rows);
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof ApiError ? err.message : 'Failed to load exceptions');
      });
    return () => {
      active = false;
    };
  }, []);

  const selected = items[selIdx] ?? null;
  const proposalId = selected ? proposalRefId(selected.entityRef) : null;

  // Reset per-item evidence + edit state whenever the shown item changes (including after a
  // triage action removes one). The action NOTICE is intentionally NOT cleared here so a
  // "Posted" result survives the item leaving the queue; it is cleared on explicit navigation.
  useEffect(() => {
    setEditing(false);
    setEvidence(null);
    evidenceRef.current = null;
  }, [selected?.id]);

  const onEvidenceLoaded = useCallback((ev: Evidence) => {
    evidenceRef.current = ev;
    setEvidence(ev);
  }, []);

  // Explicit user navigation (J/K or clicking a row): clear the previous action notice.
  const navigate = useCallback((updater: (i: number) => number) => {
    setNotice(null);
    setSelIdx(updater);
  }, []);

  const removeSelected = useCallback(() => {
    setItems((prev) => {
      const next = prev.filter((_, i) => i !== selIdx);
      setSelIdx((i) => Math.max(0, Math.min(i, next.length - 1)));
      return next;
    });
  }, [selIdx]);

  const doApprove = useCallback(async () => {
    if (proposalId == null || busy) return;
    setBusy(true);
    try {
      const res: ActionResult<ApprovePosted> = await apiPost<ApprovePosted>(
        `/api/proposals/${proposalId}/approve`,
      );
      if (res.status === 201 && res.data) {
        setNotice({ kind: 'good', text: `Posted to QuickBooks sandbox.`, qboLink: res.data.qbo_link });
        removeSelected();
      } else if (res.status === 202 && res.data && (res.data as { code?: string }).code === 'HELD_FOR_REVIEW') {
        const reason = (res.data as { reason?: string }).reason ?? 'held for review';
        setNotice({ kind: 'warn', text: `Held for review: ${reason}` });
        removeSelected();
      } else if (res.status === 202 && res.error?.code === 'QBO_RETRY') {
        setNotice({ kind: 'warn', text: 'Posting to QuickBooks failed — safe to retry (press A again).' });
      } else if (res.status === 409) {
        setNotice({ kind: 'warn', text: 'Already posted — no second write.' });
        removeSelected();
      } else if (res.status === 403 && res.error?.code === 'DRY_RUN_LOCKED') {
        // CHUNK_6_ONBOARDING: automation is still "off" — surface the actionable message
        // instead of the raw backend string; the item stays in the queue (nothing changed).
        const friendly = friendlyOnboardingError(res.error.code, res.error.message);
        setNotice({ kind: 'bad', text: friendly.text });
      } else {
        setNotice({ kind: 'bad', text: res.error?.message ?? `Approve failed (${res.status}).` });
      }
    } finally {
      setBusy(false);
    }
  }, [proposalId, busy, removeSelected]);

  const doReject = useCallback(async () => {
    if (proposalId == null || busy) return;
    const reason = window.prompt('Reason for rejecting?');
    if (!reason || !reason.trim()) return;
    setBusy(true);
    try {
      const res = await apiPost(`/api/proposals/${proposalId}/reject`, { reason: reason.trim() });
      if (res.ok) {
        setNotice({ kind: 'good', text: 'Rejected.' });
        removeSelected();
      } else {
        setNotice({ kind: 'bad', text: res.error?.message ?? 'Reject failed.' });
      }
    } finally {
      setBusy(false);
    }
  }, [proposalId, busy, removeSelected]);

  const doSendToOwner = useCallback(() => {
    setNotice({ kind: 'good', text: 'Escalated to the owner for approval.' });
  }, []);

  const doRemap = useCallback(
    async (v: RemapValues) => {
      setBusy(true);
      try {
        const res = await apiPost<{ became_rule: boolean }>(`/api/mappings/remap`, v);
        if (res.ok) {
          setNotice({
            kind: 'good',
            text: `Mapping saved${res.data?.became_rule ? ' and remembered as a rule.' : '.'}`,
          });
          setEditing(false);
        } else {
          setNotice({ kind: 'bad', text: res.error?.message ?? 'Remap failed.' });
        }
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const openSource = useCallback(() => {
    const url = gmailUrl(evidenceRef.current?.email?.gmailMessageId ?? null);
    if (url) window.open(url, '_blank', 'noreferrer');
    else setNotice({ kind: 'warn', text: 'No source email link available for this item.' });
  }, []);

  // Keyboard triage. Ignored while typing in the remap form's inputs.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      const k = e.key.toLowerCase();
      if (k === 'j') {
        e.preventDefault();
        navigate((i) => Math.min(i + 1, items.length - 1));
      } else if (k === 'k') {
        e.preventDefault();
        navigate((i) => Math.max(i - 1, 0));
      } else if (k === 'a') {
        void doApprove();
      } else if (k === 'r') {
        void doReject();
      } else if (k === 'e') {
        setEditing((v) => !v);
      } else if (k === 'o') {
        openSource();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [items.length, doApprove, doReject, openSource, navigate]);

  if (error) return <div className="notice bad">{error}</div>;

  return (
    <div data-testid="exceptions-page">
      <h1>Exceptions</h1>
      <p className="page-sub">
        Keyboard triage: <span className="kbd">J</span>/<span className="kbd">K</span> navigate ·{' '}
        <span className="kbd">A</span> approve · <span className="kbd">R</span> reject ·{' '}
        <span className="kbd">E</span> edit · <span className="kbd">O</span> open source
      </p>
      <p className="page-sub">
        <Link href="/exceptions/dimensions">Review dimension mapping exceptions →</Link>
      </p>

      {notice ? (
        <div className={`notice ${notice.kind}`} data-testid="action-notice">
          {notice.text}{' '}
          {notice.qboLink ? (
            <a href={notice.qboLink} target="_blank" rel="noreferrer" data-testid="posted-qbo-link">
              Open in QuickBooks
            </a>
          ) : null}
        </div>
      ) : null}

      <div className="split">
        <div className="queue" data-testid="exceptions-queue">
          {items.map((it, idx) => (
            <div
              key={it.id}
              className={`qrow${idx === selIdx ? ' selected' : ''}`}
              onClick={() => navigate(() => idx)}
              data-testid={`exception-row-${it.id}`}
            >
              <div className="qtitle">{it.reasonCode}</div>
              <div className="qmeta">
                {it.entityRef ?? '—'} · {when(it.createdAt)}
              </div>
            </div>
          ))}
          {items.length === 0 ? <div className="qrow muted">Queue clear.</div> : null}
        </div>

        <div>
          {selected ? (
            <>
              <div className="panel">
                <h2>{selected.reasonCode}</h2>
                <p className="muted">{selected.detail ?? 'No detail.'}</p>
                <ActionBar
                  hasProposal={proposalId != null}
                  busy={busy}
                  hasSource={!!evidenceRef.current?.email?.gmailMessageId}
                  onApprove={doApprove}
                  onSendToOwner={doSendToOwner}
                  onReject={doReject}
                  onEdit={() => setEditing((v) => !v)}
                  onOpenSource={openSource}
                />
              </div>

              {editing ? (
                <RemapForm
                  defaultSourceKey={evidenceRef.current?.priorRule?.sourceKey}
                  busy={busy}
                  onSubmit={doRemap}
                  onCancel={() => setEditing(false)}
                />
              ) : null}

              {evidence?.email ? (
                <ReplyDraftPanel
                  key={evidence.email.messageId}
                  messageId={evidence.email.messageId}
                  sourceSubject={evidence.email.subject}
                />
              ) : null}

              <div className="panel">
                {proposalId != null ? (
                  <EvidencePanel proposalId={proposalId} onLoaded={onEvidenceLoaded} />
                ) : (
                  <div className="muted">This exception has no linked proposal to show evidence for.</div>
                )}
              </div>
            </>
          ) : (
            <div className="panel muted">No exception selected.</div>
          )}
        </div>
      </div>
    </div>
  );
}
