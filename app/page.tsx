// Placeholder landing page. The real app shell (Today, Exceptions, ...) arrives in
// CHUNK_5_FRONTEND behind the session guard from CHUNK_1_AUTH.
export default function HomePage() {
  return (
    <main>
      <h1>AP Hub</h1>
      <p>Sign in to review and approve accounting activity.</p>
      <a href="/api/auth/login">Sign in with Google</a>
    </main>
  );
}
