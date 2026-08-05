'use client';

import { useEffect, useState } from 'react';
import { apiDelete, apiGet, apiPatch, apiPost, ApiError } from '../../../lib/api';
import { useSession } from '../../../lib/session';

type DraftStatus = 'proposed' | 'created' | 'updated' | 'discarded' | 'sent_external';

interface ReplyDraft {
  id: number;
  messageId: number;
  externalDraftId: string | null;
  threadId: string;
  toAddress: string;
  subject: string;
  bodyText: string;
  status: DraftStatus;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
  sendControl: 'human_in_gmail';
}

type Notice = { kind: 'good' | 'warn' | 'bad'; text: string; reconnect?: boolean };

function gmailThreadUrl(threadId: string): string {
  // Do not force /u/0: that can open the wrong mailbox when the operator has
  // multiple Google accounts signed in. Gmail resolves the currently selected account.
  return `https://mail.google.com/mail/#all/${encodeURIComponent(threadId)}`;
}

export function ReplyDraftPanel({
  messageId,
  sourceSubject,
  sourceFrom,
}: {
  messageId: number;
  sourceSubject: string | null;
  sourceFrom: string | null;
}) {
  const me = useSession();
  const mutable = me.role === 'owner_controller' || me.role === 'bookkeeper';
  const [draft, setDraft] = useState<ReplyDraft | null>(null);
  const [subject, setSubject] = useState(sourceSubject?.startsWith('Re:') ? sourceSubject : `Re: ${sourceSubject ?? ''}`);
  const [bodyText, setBodyText] = useState('');
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setNotice(null);
    apiGet<ReplyDraft>(`/api/reply-drafts?messageId=${messageId}`)
      .then((value) => {
        if (!active) return;
        setDraft(value);
        setSubject(value.subject);
        setBodyText(value.bodyText);
        setReason(value.reason ?? '');
      })
      .catch((cause: unknown) => {
        if (!active) return;
        if (!(cause instanceof ApiError) || cause.status !== 404) {
          setNotice({
            kind: 'bad',
            text: cause instanceof ApiError ? cause.message : 'Could not load the reply draft.',
          });
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [messageId]);

  const immutable = draft?.status === 'discarded' || draft?.status === 'sent_external';
  const canChange = mutable && !immutable;

  async function refresh() {
    setBusy(true);
    setNotice(null);
    try {
      const latest = await apiGet<ReplyDraft>(`/api/reply-drafts?messageId=${messageId}`);
      setDraft(latest);
      setSubject(latest.subject);
      setBodyText(latest.bodyText);
      setReason(latest.reason ?? '');
      setNotice({ kind: 'good', text: 'Draft status refreshed from Gmail.' });
    } catch (cause) {
      setNotice({
        kind: 'bad',
        text: cause instanceof ApiError ? cause.message : 'Could not refresh the Gmail draft. Check your connection and try again.',
      });
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!canChange || busy) return;
    setBusy(true);
    setNotice(null);
    const payload = { messageId, subject, bodyText, reason: reason || null };
    try {
      const result = draft
        ? await apiPatch<ReplyDraft>(`/api/reply-drafts/${draft.id}`, payload)
        : await apiPost<ReplyDraft>('/api/reply-drafts', payload);
      if (result.ok && result.data) {
        setDraft(result.data);
        setNotice({ kind: 'good', text: draft ? 'Draft changes saved in Gmail.' : 'Draft prepared in Gmail.' });
        return;
      }
      const composeMissing = result.error?.code === 'GMAIL_COMPOSE_SCOPE_REQUIRED';
      setNotice({
        kind: composeMissing ? 'warn' : 'bad',
        text: composeMissing
          ? 'Your copy is saved here, but Gmail compose access is missing. Reconnect Gmail to finish creating the draft.'
          : result.error?.message ?? 'Could not save the draft.',
        reconnect: composeMissing && me.role === 'owner_controller',
      });
      if (composeMissing && !draft) {
        try {
          const proposed = await apiGet<ReplyDraft>(`/api/reply-drafts?messageId=${messageId}`);
          setDraft(proposed);
        } catch {
          // The recovery message remains actionable even if the refresh is interrupted.
        }
      }
    } catch (cause) {
      setNotice({
        kind: 'bad',
        text: cause instanceof ApiError
          ? `${cause.message} The draft was not confirmed in Gmail. Try again.`
          : 'The draft was not confirmed in Gmail. Check your connection and try again.',
      });
    } finally {
      setBusy(false);
    }
  }

  async function discard() {
    if (!draft || !canChange || busy) return;
    if (!window.confirm('Discard this Gmail draft? The source email is not changed.')) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await apiDelete<ReplyDraft>(`/api/reply-drafts/${draft.id}`);
      if (result.ok && result.data) {
        setDraft(result.data);
        setNotice({ kind: 'good', text: 'Draft discarded. The source email was not changed.' });
      } else {
        setNotice({ kind: 'bad', text: result.error?.message ?? 'Could not discard the draft.' });
      }
    } catch (cause) {
      setNotice({
        kind: 'bad',
        text: cause instanceof ApiError
          ? `${cause.message} The draft was not confirmed as discarded. Try again.`
          : 'The draft was not confirmed as discarded. Check your connection and try again.',
      });
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <div className="panel muted" data-testid="reply-draft-loading">Loading draft…</div>;

  return (
    <section className="panel draft-panel" data-testid="reply-draft-panel">
      <div className="provider-card-head">
        <div>
          <h2>Draft reply</h2>
          <p className="muted">
            Prepare the response here. <strong>BookScout OS cannot send this message.</strong> A person
            must review and send the unsent draft from Gmail.
          </p>
        </div>
        {draft ? <span className={`badge ${draft.status}`}>{draft.status.replace('_', ' ')}</span> : null}
      </div>

      {notice ? (
        <div className={`notice ${notice.kind}`} role={notice.kind === 'bad' ? 'alert' : 'status'} aria-live="polite" data-testid="reply-draft-notice">
          {notice.text}{' '}
          {notice.reconnect ? (
            <a href="/api/connections/gmail/start" data-testid="gmail-compose-reconnect">
              Reconnect Gmail
            </a>
          ) : notice.kind === 'warn' && me.role === 'bookkeeper' ? (
            <span>Ask the owner to reconnect Gmail.</span>
          ) : null}
        </div>
      ) : null}

      {draft?.status === 'sent_external' ? (
        <div className="notice good" data-testid="draft-sent-external">
          Gmail reports that a person sent this message. The recorded copy is now read-only.
        </div>
      ) : null}
      {draft?.status === 'discarded' ? (
        <div className="notice warn" data-testid="draft-discarded">
          This draft was discarded and is read-only.
        </div>
      ) : null}
      {!mutable ? (
        <div className="notice warn" data-testid="draft-readonly">
          CPA access is read-only.
        </div>
      ) : null}

      {draft?.toAddress || sourceFrom ? (
        <div className="field-row">
          <label htmlFor="draft-to">Recipient from source conversation</label>
          <input id="draft-to" type="text" value={draft?.toAddress || sourceFrom || ''} readOnly />
        </div>
      ) : <p className="muted">The recipient will be derived from the source conversation and shown here before you open Gmail.</p>}
      {draft ? (
        <p className="muted" data-testid="draft-timestamps">
          Created {new Date(draft.createdAt).toLocaleString()} · last synced {new Date(draft.updatedAt).toLocaleString()}
        </p>
      ) : null}
      <div className="field-row">
        <label htmlFor="draft-subject">Subject</label>
        <input
          id="draft-subject"
          type="text"
          value={subject}
          onChange={(event) => setSubject(event.target.value)}
          readOnly={!canChange}
        />
      </div>
      <div className="field-row">
        <label htmlFor="draft-body">Message</label>
        <textarea
          id="draft-body"
          rows={7}
          value={bodyText}
          onChange={(event) => setBodyText(event.target.value)}
          readOnly={!canChange}
        />
      </div>
      <div className="field-row">
        <label htmlFor="draft-reason">Internal reason (optional)</label>
        <input
          id="draft-reason"
          type="text"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          readOnly={!canChange}
        />
      </div>

      <div className="btn-row" data-testid="reply-draft-actions">
        {canChange ? (
          <button
            type="button"
            className="primary"
            onClick={() => void save()}
            disabled={busy || !subject.trim() || !bodyText.trim()}
            data-testid="draft-save"
          >
            {draft ? 'Save draft changes' : 'Prepare Gmail draft'}
          </button>
        ) : null}
        {draft && canChange ? (
          <button
            type="button"
            className="danger"
            onClick={() => void discard()}
            disabled={busy}
            data-testid="draft-discard"
          >
            Discard draft
          </button>
        ) : null}
        {draft?.threadId ? (
          <a
            className="btn"
            href={gmailThreadUrl(draft.threadId)}
            target="_blank"
            rel="noreferrer"
            data-testid="draft-open-gmail"
          >
            Open conversation in Gmail
          </a>
        ) : null}
        {draft ? (
          <button type="button" onClick={() => void refresh()} disabled={busy} data-testid="draft-refresh">
            Refresh Gmail status
          </button>
        ) : null}
      </div>
    </section>
  );
}
