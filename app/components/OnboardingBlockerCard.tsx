'use client';

// CHUNK_4_EXPLAINERS — presentational card for one setup blocker. Pure copy/layout over
// data the page already fetches (state.blockers); no new data, no new blocker types.
export interface OnboardingBlockerCardProps {
  group: string;
  message: string;
  fix: string;
  code?: string;
}

const ICON_BY_CODE: Record<string, string> = {
  gmail_not_connected: '📧',
  qbo_not_connected: '🔗',
  qbo_company_not_selected: '🏢',
  automation_locked: '🔒',
};
const DEFAULT_ICON = '⚠️';

export function OnboardingBlockerCard({ group, message, fix, code }: OnboardingBlockerCardProps) {
  const icon = (code && ICON_BY_CODE[code]) ?? DEFAULT_ICON;
  return (
    <div className="notice warn blocker-card" data-testid={`blocker-${code}`}>
      <span className="blocker-card-icon" aria-hidden="true">{icon}</span>
      <span className="blocker-card-body">
        <strong className="blocker-card-group">{group}</strong>
        <span>{message}</span> <strong>Fix:</strong> {fix}
      </span>
    </div>
  );
}
