'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { apiGet, apiPost, ApiError } from '../../lib/api';
import { ConnectPrompt } from '../../components/ConnectPrompt';
import { EvidencePanel } from '../../components/EvidencePanel';
import { OnboardingBlockerCard } from '../../components/OnboardingBlockerCard';
import { OnboardingWelcome } from '../../components/OnboardingWelcome';
import { RemapForm, type RemapValues } from '../../components/RemapForm';
import { friendlyOnboardingError, friendlyConnectReason } from '../../lib/onboardingErrors.js';
import { useSession } from '../../lib/session';
import type { OnboardingState, DryRunSummary, TodayDigest } from '../../lib/types';

// CHUNK_5_PAGEREDESIGN — collapses the former 9-screen wizard to ONE "Connect your accounts"
// screen with two real Connect actions (CHUNK_4's session-gated start routes). Once both
// connections are genuinely true (re-checked on every load — not only right after a
// `?connected=` redirect, so a returning owner with connections already done still
// auto-completes), the remaining intermediate step values and the dry-run run automatically
// with zero further required clicks, landing on one combined summary screen.
// `automation_level` is never touched here — it stays the existing 'off' default
// (DRY_RUN_LOCKED) until a human changes it from Settings. The OnboardingStepper from the
// earlier guided-installer feature implied 9 user-facing steps; with only "connect" /
// "setting up" / "done" left, a stepper misrepresents the flow more than it clarifies it, so
// it's dropped from this page (the component file itself is left in place, unused).
// See specs/SPEC-onboarding-real-connect-redesign.md §5 (User Flows) and §7 (Error Handling).

const AUTO_STEPS = ['connect_qbo', 'select_company', 'configure_mode', 'automation_level'] as const;

type Notice = { kind: 'good' | 'warn' | 'bad'; text: string; raw?: string; retryable?: boolean };

export default function OnboardingPage() {
  // useSearchParams requires a Suspense boundary in the App Router.
  return (
    <Suspense fallback={<div className="muted">Loading onboarding…</div>}>
      <OnboardingPageInner />
    </Suspense>
  );
}

function OnboardingPageInner() {
  const me = useSession();
  const router = useRouter();
  const searchParams = useSearchParams();

  const [state, setState] = useState<OnboardingState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [settingUp, setSettingUp] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [dryRun, setDryRun] = useState<DryRunSummary | null>(null);
  const [sampleProposalId, setSampleProposalId] = useState<number | null>(null);
  const [welcomeDismissed, setWelcomeDismissed] = useState(false);
  const [retryAction, setRetryAction] = useState<(() => void) | null>(null);
  const [connectErrors, setConnectErrors] = useState<{ gmail?: string; qbo?: string }>({});

  // Guards the automatic walk-through so it fires at most once per page load.
  const autoSetupStarted = useRef(false);

  const load = useCallback(() => {
    apiGet<OnboardingState>('/api/onboarding')
      .then(setState)
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : 'Failed to load onboarding state'));
  }, []);

  useEffect(load, [load]);

  // Resolve ?connected=/?connect_error= exactly once on mount, then strip the query string
  // (a refresh must not re-trigger the same branch).
  useEffect(() => {
    const connected = searchParams.get('connected');
    const connectErr = searchParams.get('connect_error');
    const reason = searchParams.get('reason');
    if (connected === 'gmail' || connected === 'qbo') {
      load();
      router.replace('/onboarding');
    } else if (connectErr === 'gmail' || connectErr === 'qbo') {
      setConnectErrors((prev) => ({ ...prev, [connectErr]: friendlyConnectReason(reason ?? '') }));
      router.replace('/onboarding');
    }
    // Intentionally runs once on mount only — re-reading on every searchParams identity
    // change would re-trigger after our own router.replace() strips the params.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const goStep = useCallback(
    async (nextStep: string): Promise<boolean> => {
      setBusy(true);
      setNotice(null);
      setRetryAction(null);
      try {
        const res = await apiPost('/api/onboarding/step', { step: nextStep });
        if (res.ok) {
          load();
          return true;
        }
        const fallback = res.error?.message ?? 'Something went wrong.';
        const friendly = friendlyOnboardingError(res.error?.code ?? '', fallback);
        setNotice({ kind: 'bad', text: friendly.text, raw: fallback, retryable: friendly.retryable });
        return false;
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  const runDryRun = useCallback(async (): Promise<boolean> => {
    setBusy(true);
    setNotice(null);
    setRetryAction(null);
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
        return true;
      }
      const fallback = res.error?.message ?? 'Something went wrong.';
      const friendly = friendlyOnboardingError(res.error?.code ?? '', fallback);
      setNotice({ kind: 'bad', text: friendly.text, raw: fallback, retryable: friendly.retryable });
      return false;
    } finally {
      setBusy(false);
    }
  }, [load]);

  // The automatic walk-through: once both connections are true, silently advance the step
  // machine through the remaining intermediate values (no automationLevel argument passed —
  // the existing 'off' default is preserved) and run the dry-run. A failure anywhere in the
  // chain surfaces the usual friendly-error notice, with its retry re-running this whole
  // (idempotent) chain rather than only the one step that failed.
  const runAutoSetup = useCallback(async () => {
    setSettingUp(true);
    try {
      for (const step of AUTO_STEPS) {
        const ok = await goStep(step);
        if (!ok) {
          setRetryAction(() => () => void runAutoSetup());
          return;
        }
      }
      const ok = await runDryRun();
      if (!ok) {
        setRetryAction(() => () => void runAutoSetup());
      }
    } finally {
      setSettingUp(false);
    }
  }, [goStep, runDryRun]);

  const approveRule = useCallback(async (v: RemapValues) => {
    setBusy(true);
    setNotice(null);
    setRetryAction(null);
    try {
      const res = await apiPost<{ became_rule: boolean }>('/api/mappings/remap', v);
      if (res.ok) {
        setNotice({ kind: 'good', text: `Rule saved${res.data?.became_rule ? ' and remembered.' : '.'}` });
      } else {
        const fallback = res.error?.message ?? 'Something went wrong.';
        const friendly = friendlyOnboardingError(res.error?.code ?? '', fallback);
        setNotice({ kind: 'bad', text: friendly.text, raw: fallback, retryable: friendly.retryable });
        setRetryAction(friendly.retryable ? () => () => void approveRule(v) : null);
      }
    } finally {
      setBusy(false);
    }
  }, []);

  const bothConnected = Boolean(state?.connections.gmailConnected && state?.connections.qboConnected);

  // Runs on every load where both connections are true — including a returning owner whose
  // connections were already done in a prior session (Flow D) — not only right after a
  // `?connected=` redirect. Re-running the chain is safe/idempotent (COALESCE step updates,
  // dry-run only proposes not-yet-proposed extractions), which is also how a returning owner
  // whose dry-run already ran gets real, freshly-fetched summary counts on this load.
  useEffect(() => {
    if (bothConnected && !dryRun && !autoSetupStarted.current) {
      autoSetupStarted.current = true;
      void runAutoSetup();
    }
  }, [bothConnected, dryRun, runAutoSetup]);

  if (error) return <div className="notice bad">{error}</div>;
  if (!state) return <div className="muted">Loading onboarding…</div>;

  const owner = me.role === 'owner_controller';

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

  // Setup blockers, grouped into exact-fix cards (acceptance criterion, unchanged from CHUNK_4).
  const groups = new Map<string, typeof state.blockers>();
  for (const b of state.blockers) {
    groups.set(b.group, [...(groups.get(b.group) ?? []), b]);
  }

  return (
    <div data-testid="onboarding-page">
      <h1>Set up AP Hub</h1>
      <p className="page-sub">
        {state.automationLevel === 'off' ? 'Automation is OFF — nothing can post yet.' : `Automation: ${state.automationLevel}`}
      </p>

      {notice ? (
        <div className={`notice ${notice.kind}`} data-testid="onboarding-notice">
          <div>{notice.text}</div>
          {notice.retryable && retryAction ? (
            <button disabled={busy || settingUp} onClick={() => retryAction()} data-testid="onboarding-retry">
              Try again
            </button>
          ) : null}
          {notice.raw ? (
            <details>
              <summary>Details</summary>
              {notice.raw}
            </details>
          ) : null}
        </div>
      ) : null}

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

      {!bothConnected ? (
        <div className="panel" data-testid="connect-accounts">
          <h2>Connect your accounts</h2>
          <p className="muted">
            Connect Gmail and QuickBooks first. AP Hub then runs a no-write dry scan; an owner must
            separately review the company identity, backup prerequisite, automation level, and write gate
            before any QuickBooks transaction can be created.
          </p>
          <ConnectPrompt
            provider="Gmail"
            description="You'll grant mailbox read access. If draft replies are enabled, AP Hub also requests compose access for unsent drafts; only a human sends them."
            href="/api/connections/gmail/start"
            connected={state.connections.gmailConnected}
            errorText={connectErrors.gmail}
            testId="connect-prompt-gmail"
          />
          <ConnectPrompt
            provider="QuickBooks"
            description="You'll connect the configured QuickBooks Online company. Sandbox is the default; production remains disabled until its separate master switch, exact-realm checks, backup confirmation, and owner write gate are all enabled."
            href="/api/connections/qbo/start"
            connected={state.connections.qboConnected}
            errorText={connectErrors.qbo}
            testId="connect-prompt-qbo"
          />
        </div>
      ) : !dryRun ? (
        <div className="panel" data-testid="onboarding-setting-up">
          <h2>Setting up…</h2>
          <p className="muted">
            {settingUp
              ? 'Confirming your connections and running an initial scan — this only takes a moment.'
              : 'Setup is paused — see the message above.'}
          </p>
        </div>
      ) : (
        <div className="panel" data-testid="onboarding-summary">
          <h2>You&apos;re set up</h2>
          <div className="counts" data-testid="dry-run-summary">
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

          <h3 style={{ marginTop: 16 }}>Review a sample</h3>
          {sampleProposalId != null ? (
            <EvidencePanel proposalId={sampleProposalId} />
          ) : (
            <p className="muted">No sample proposal available yet.</p>
          )}

          <h3 style={{ marginTop: 16 }}>Approve an initial rule (optional)</h3>
          <RemapForm onSubmit={(v) => void approveRule(v)} onCancel={() => setNotice(null)} busy={busy} />

          <p className="notice warn" style={{ marginTop: 16 }}>
            Automation is OFF — turn it on in <a href="/settings">Settings</a> when you&apos;re ready.
          </p>
        </div>
      )}
    </div>
  );
}
