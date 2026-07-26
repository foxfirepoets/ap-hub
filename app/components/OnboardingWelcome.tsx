'use client';

// CHUNK_2_WELCOME — non-persisted welcome overlay shown before onboarding step content.
// Purely presentational: no fetch, no state beyond what the parent passes in. Dismissing
// it only flips a local useState in the parent page — it is never written to the backend,
// so it reappears on every page load by design (see specs/SPEC-guided-onboarding-installer.md §6).
export interface OnboardingWelcomeProps {
  onGetStarted: () => void;
}

export function OnboardingWelcome({ onGetStarted }: OnboardingWelcomeProps) {
  return (
    <div className="panel" data-testid="onboarding-welcome">
      <h2>Welcome to AP Hub</h2>
      <p className="muted">
        AP Hub reads accounting email from your Gmail inbox, proof-checks each document, and
        prepares reviewable transactions in QuickBooks Online — nothing posts until you approve
        it (or turn on automation later).
      </p>
      <p className="muted">
        This is your own AP-Hub. It doesn&apos;t share information with other people who use this
        computer.
      </p>
      <p className="muted">Before you start, you&apos;ll need to connect two things:</p>
      <ul className="muted">
        <li>Gmail — the mailbox AP Hub should read and, when enabled, use for unsent drafts.</li>
        <li>QuickBooks — the configured Online company, or a supported Windows Desktop company.</li>
      </ul>
      <button className="primary" onClick={onGetStarted}>
        Get Started
      </button>
    </div>
  );
}
