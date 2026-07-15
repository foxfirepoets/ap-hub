'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiGet, apiPost, ApiError } from '../../lib/api';
import { EvidencePanel } from '../../components/EvidencePanel';
import { OnboardingBlockerCard } from '../../components/OnboardingBlockerCard';
import { OnboardingStepper } from '../../components/OnboardingStepper';
import { OnboardingWelcome } from '../../components/OnboardingWelcome';
import { RemapForm, type RemapValues } from '../../components/RemapForm';
import { useSession } from '../../lib/session';
import type { OnboardingState, DryRunSummary, TodayDigest } from '../../lib/types';

// CHUNK_6_ONBOARDING — the first-run wizard. Discovery-before-asking: GET /api/onboarding
// pulls Gmail/QBO connection state + prior-data counts BEFORE any step asks the human to
// choose anything. The dry-run (POST /api/onboarding/dry-run) runs the pipeline through
// `propose` only — it can never post — and its result is a business-specific summary, not
// a blank dashboard. `automation_level` stays 'off' (auto-post DRY_RUN_LOCKED) until the
// final step explicitly sets it away from 'off'.

const STEPS = [
  'connect_gmail',
  'connect_qbo',
  'select_company',
  'configure_mode',
  'automation_level',
  'dry_run',
  'review_sample',
  'approve_rules',
  'complete',
] as const;
type Step = (typeof STEPS)[number];

const STEP_LABEL: Record<Step, string> = {
  connect_gmail: 'Connect Gmail',
  connect_qbo: 'Connect QuickBooks',
  select_company: 'Select company',
  configure_mode: 'Mode & date range',
  automation_level: 'Automation level',
  dry_run: 'Dry-run scan',
  review_sample: 'Review sample',
  approve_rules: 'Approve initial rules',
  complete: 'Enable auto-post',
};

// CHUNK_4_EXPLAINERS — one plain-English sentence per step: what it needs and why.
const STEP_EXPLAINER: Record<Step, string> = {
  connect_gmail: 'AP Hub reads accounting email from this mailbox — nothing else is touched.',
  connect_qbo: 'AP Hub needs a QuickBooks Online connection so it can eventually write approved transactions there.',
  select_company: 'Everything AP Hub creates goes into one QuickBooks sandbox company you pick here — never production.',
  configure_mode: 'AP Hub scans the connected mailbox for accounting documents in this mode and date range.',
  automation_level: 'This sets how much AP Hub can do on its own — it stays OFF until you choose otherwise after review.',
  dry_run: 'A dry-run shows what AP Hub would find and propose, without posting anything to QuickBooks.',
  review_sample: 'Reviewing one real example lets you confirm AP Hub read the document correctly before trusting the rest.',
  approve_rules: 'Confirming a vendor/account mapping now means future matching invoices apply it automatically.',
  complete: 'Choosing an automation level here is what actually unlocks posting — everything stays OFF until you do.',
};

type Notice = { kind: 'good' | 'warn' | 'bad'; text: string };

export default function OnboardingPage() {
  const me = useSession();
  const [state, setState] = useState<OnboardingState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [dryRun, setDryRun] = useState<DryRunSummary | null>(null);
  const [sampleProposalId, setSampleProposalId] = useState<number | null>(null);
  const [welcomeDismissed, setWelcomeDismissed] = useState(false);

  const load = useCallback(() => {
    apiGet<OnboardingState>('/api/onboarding')
      .then(setState)
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : 'Failed to load onboarding state'));
  }, []);

  useEffect(load, [load]);

  const owner = me.role === 'owner_controller';
  const step = (state?.step as Step) ?? 'connect_gmail';

  const goStep = useCallback(
    async (nextStep: Step, automationLevel?: string) => {
      setBusy(true);
      setNotice(null);
      try {
        const res = await apiPost('/api/onboarding/step', { step: nextStep, automationLevel });
        if (res.ok) {
          load();
        } else {
          setNotice({ kind: 'bad', text: res.error?.message ?? 'Could not advance onboarding.' });
        }
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  const runDryRun = useCallback(async () => {
    setBusy(true);
    setNotice(null);
    try {
      const res = await apiPost<DryRunSummary>('/api/onboarding/dry-run');
      if (res.ok && res.data) {
        setDryRun(res.data);
        setNotice({ kind: 'good', text: 'Dry-run complete — nothing was posted to QuickBooks.' });
        // Pull a sample item to review (read-only; never posts).
        try {
          const today = await apiGet<TodayDigest>('/api/today');
          setSampleProposalId(today.items[0]?.proposalId ?? null);
        } catch {
          setSampleProposalId(null);
        }
        load();
      } else {
        setNotice({ kind: 'bad', text: res.error?.message ?? 'Dry-run failed.' });
      }
    } finally {
      setBusy(false);
    }
  }, [load]);

  const approveRule = useCallback(
    async (v: RemapValues) => {
      setBusy(true);
      setNotice(null);
      try {
        const res = await apiPost<{ became_rule: boolean }>('/api/mappings/remap', v);
        if (res.ok) {
          setNotice({ kind: 'good', text: `Rule saved${res.data?.became_rule ? ' and remembered.' : '.'}` });
        } else {
          setNotice({ kind: 'bad', text: res.error?.message ?? 'Could not save the rule.' });
        }
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  if (error) return <div className="notice bad">{error}</div>;
  if (!state) return <div className="muted">Loading onboarding…</div>;

  if (!owner) {
    return (
      <div data-testid="onboarding-page">
        <h1>Onboarding</h1>
        <p className="page-sub">Only the account owner can complete setup.</p>
      </div>
    );
  }

  if (!welcomeDismissed) {
    return (
      <div data-testid="onboarding-page">
        <h1>Set up AP Hub</h1>
        <OnboardingWelcome onGetStarted={() => setWelcomeDismissed(true)} />
      </div>
    );
  }

  // Setup blockers, grouped into exact-fix cards (acceptance criterion).
  const groups = new Map<string, typeof state.blockers>();
  for (const b of state.blockers) {
    groups.set(b.group, [...(groups.get(b.group) ?? []), b]);
  }

  return (
    <div data-testid="onboarding-page">
      <h1>Set up AP Hub</h1>
      <OnboardingStepper steps={STEPS.map((s) => ({ key: s, label: STEP_LABEL[s] }))} currentStep={step} />
      <p className="page-sub">
        {state.automationLevel === 'off' ? 'Automation is OFF — nothing can post yet.' : `Automation: ${state.automationLevel}`}
      </p>

      {notice ? <div className={`notice ${notice.kind}`} data-testid="onboarding-notice">{notice.text}</div> : null}

      {groups.size > 0 ? (
        <div className="panel" data-testid="setup-blockers">
          <h2>Setup blockers</h2>
          {[...groups.entries()].map(([group, items]) => (
            <div key={group} style={{ marginBottom: 12 }}>
              <div style={{ fontWeight: 600 }}>{group}</div>
              {items.map((b) => (
                <OnboardingBlockerCard key={b.code} group={group} message={b.message} fix={b.fix} code={b.code} />
              ))}
            </div>
          ))}
        </div>
      ) : null}

      <div className="panel">
        <h2>What we already found</h2>
        <div className="counts">
          <div className="count-card">
            <div className="n">{state.priorData.emails}</div>
            <div className="l">Emails</div>
          </div>
          <div className="count-card">
            <div className="n">{state.priorData.invoices}</div>
            <div className="l">Invoices</div>
          </div>
          <div className="count-card">
            <div className="n">{state.priorData.vendorsKnown}</div>
            <div className="l">Known vendors</div>
          </div>
        </div>
      </div>

      <div className="panel">
        {step === 'connect_gmail' ? (
          <>
            <p className="muted step-explainer">{STEP_EXPLAINER.connect_gmail}</p>
            <h2>Connect Gmail</h2>
            <p className="muted">
              {state.connections.gmailConnected ? 'Gmail is connected.' : 'Connect the Gmail account AP Hub should read.'}
            </p>
            <button className="primary" disabled={busy} onClick={() => void goStep('connect_qbo')}>
              Continue
            </button>
          </>
        ) : null}

        {step === 'connect_qbo' ? (
          <>
            <p className="muted step-explainer">{STEP_EXPLAINER.connect_qbo}</p>
            <h2>Connect QuickBooks</h2>
            <p className="muted">
              {state.connections.qboConnected ? 'QuickBooks Online (sandbox) is connected.' : 'Connect QuickBooks Online sandbox.'}
            </p>
            <button className="primary" disabled={busy} onClick={() => void goStep('select_company')}>
              Continue
            </button>
          </>
        ) : null}

        {step === 'select_company' ? (
          <>
            <p className="muted step-explainer">{STEP_EXPLAINER.select_company}</p>
            <h2>Select company</h2>
            <p className="muted">
              {state.connections.qboCompanySelected
                ? `Sandbox company: ${state.connections.qboCompanyName ?? 'selected'}.`
                : 'Select the QuickBooks sandbox company to write to.'}
            </p>
            <button className="primary" disabled={busy} onClick={() => void goStep('configure_mode')}>
              Continue
            </button>
          </>
        ) : null}

        {step === 'configure_mode' ? (
          <>
            <p className="muted step-explainer">{STEP_EXPLAINER.configure_mode}</p>
            <h2>Mode & date range</h2>
            <p className="muted">AP Hub scans email for accounting documents in the connected mailbox.</p>
            <button className="primary" disabled={busy} onClick={() => void goStep('automation_level')}>
              Continue
            </button>
          </>
        ) : null}

        {step === 'automation_level' ? (
          <>
            <p className="muted step-explainer">{STEP_EXPLAINER.automation_level}</p>
            <h2>Automation level</h2>
            <p className="muted">
              Automation stays OFF through setup. You will choose the level after reviewing a dry-run — nothing
              posts until then.
            </p>
            <button className="primary" disabled={busy} onClick={() => void goStep('dry_run')}>
              Continue
            </button>
          </>
        ) : null}

        {step === 'dry_run' ? (
          <>
            <p className="muted step-explainer">{STEP_EXPLAINER.dry_run}</p>
            <h2>Dry-run scan</h2>
            <p className="muted">Scans existing mail/QBO data through proposal generation. Nothing is posted.</p>
            <div className="btn-row">
              <button className="primary" disabled={busy} onClick={() => void runDryRun()}>
                Run dry-run scan
              </button>
              {dryRun ? (
                <button disabled={busy} onClick={() => void goStep('review_sample')}>
                  Continue
                </button>
              ) : null}
            </div>
            {dryRun ? (
              <div className="counts" style={{ marginTop: 16 }} data-testid="dry-run-summary">
                <div className="count-card">
                  <div className="n">{dryRun.emailsScanned}</div>
                  <div className="l">Emails scanned</div>
                </div>
                <div className="count-card">
                  <div className="n">{dryRun.invoicesFound}</div>
                  <div className="l">Invoices found</div>
                </div>
                <div className="count-card">
                  <div className="n">{dryRun.vendorsMatched}</div>
                  <div className="l">Vendors matched</div>
                </div>
                <div className="count-card">
                  <div className="n">{dryRun.proposalsCreated}</div>
                  <div className="l">Proposals created</div>
                </div>
              </div>
            ) : null}
          </>
        ) : null}

        {step === 'review_sample' ? (
          <>
            <p className="muted step-explainer">{STEP_EXPLAINER.review_sample}</p>
            <h2>Review a sample</h2>
            {sampleProposalId != null ? (
              <EvidencePanel proposalId={sampleProposalId} />
            ) : (
              <p className="muted">No sample proposal available yet.</p>
            )}
            <button className="primary" disabled={busy} style={{ marginTop: 12 }} onClick={() => void goStep('approve_rules')}>
              Continue
            </button>
          </>
        ) : null}

        {step === 'approve_rules' ? (
          <>
            <p className="muted step-explainer">{STEP_EXPLAINER.approve_rules}</p>
            <h2>Approve initial rules</h2>
            <p className="muted">Confirm the vendor/account mapping so future matches apply automatically.</p>
            <RemapForm onSubmit={(v) => void approveRule(v)} onCancel={() => void goStep('complete')} busy={busy} />
            <button disabled={busy} style={{ marginTop: 12 }} onClick={() => void goStep('complete')}>
              Continue
            </button>
          </>
        ) : null}

        {step === 'complete' ? (
          <>
            <p className="muted step-explainer">{STEP_EXPLAINER.complete}</p>
            <h2>Enable auto-post</h2>
            <p className="muted">
              Choose how much AP Hub may do on its own. Posting is locked (DRY_RUN_LOCKED) until you pick anything
              other than Off.
            </p>
            <div className="btn-row">
              <button disabled={busy} onClick={() => void goStep('complete', 'off')}>
                Off — review everything
              </button>
              <button className="primary" disabled={busy} onClick={() => void goStep('complete', 'assisted')}>
                Assisted — auto-post high-confidence items
              </button>
              <button disabled={busy} onClick={() => void goStep('complete', 'auto')}>
                Auto — post whenever the pipeline says ready
              </button>
            </div>
            {state.automationLevel !== 'off' ? (
              <p className="notice good" style={{ marginTop: 12 }}>
                Setup complete. Automation level: {state.automationLevel}.
              </p>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
