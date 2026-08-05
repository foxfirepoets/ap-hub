'use client';

// CHUNK_4_IDENTITY — fallback screen only (outside the app shell, no nav, no session guard).
// BookScout OS no longer has a sign-in step: the Windows account that opened it becomes its owner
// automatically, before this screen would ever be reached. This page only appears if that
// could not be confirmed — never a Google button, never a dead end.
export default function LoginPage() {
  return (
    <div className="login-wrap">
      <div className="login-card">
        <h1>BookScout OS</h1>
        <p className="muted">BookScout OS could not confirm your account on this computer.</p>
        <p style={{ marginTop: 24 }}>
          <button
            className="btn primary"
            data-testid="retry-signin"
            onClick={() => window.location.reload()}
          >
            Try again
          </button>
        </p>
      </div>
    </div>
  );
}
