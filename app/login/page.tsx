'use client';

// Login page (outside the app shell — no nav, no session guard). The only action is to
// start Google SSO, which is handled entirely by the existing CHUNK_1 auth routes.
export default function LoginPage() {
  return (
    <div className="login-wrap">
      <div className="login-card">
        <h1>AP Hub</h1>
        <p className="muted">Sign in to review and approve accounting activity.</p>
        <p style={{ marginTop: 24 }}>
          <a className="btn primary" href="/api/auth/login" data-testid="google-signin">
            Sign in with Google
          </a>
        </p>
      </div>
    </div>
  );
}
