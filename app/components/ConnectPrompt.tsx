'use client';

// CHUNK_5_PAGEREDESIGN — the guided pop-up content for one "Connect" action, shown inline
// on the collapsed onboarding screen. Purely presentational: the real navigation is a plain
// <a href> to the CHUNK_4 start route (a full browser navigation into the OAuth consent
// flow) — no fetch, no client-side redirect logic here.
export interface ConnectPromptProps {
  provider: string;
  description: string;
  href: string;
  connected: boolean;
  errorText?: string | null;
  testId?: string;
}

export function ConnectPrompt({ provider, description, href, connected, errorText, testId }: ConnectPromptProps) {
  return (
    <div className="panel" data-testid={testId ?? `connect-prompt-${provider.toLowerCase()}`}>
      <h2>{provider}</h2>
      <p className="muted">{description}</p>
      <div className="btn-row">
        <span className={`badge ${connected ? 'good' : 'warn'}`} data-testid="connect-status">
          {connected ? 'Connected ✓' : 'Not connected'}
        </span>
        {!connected ? (
          <a className="btn primary" href={href} data-testid="connect-action">
            Connect {provider}
          </a>
        ) : null}
      </div>
      {errorText ? (
        <div className="notice bad" data-testid="connect-error">
          <div>{errorText}</div>
          <a href={href} data-testid="connect-retry">
            Try again
          </a>
        </div>
      ) : null}
    </div>
  );
}
