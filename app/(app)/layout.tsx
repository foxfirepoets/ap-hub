import type { ReactNode } from 'react';
import { SessionGuard } from '../lib/session';
import { Nav } from './Nav';

// The authenticated app shell. SessionGuard resolves /api/me (redirecting anonymous users
// to /login) and provides the role to every page for button gating. Nav is the top-level
// navigation across Today / Exceptions / Transactions / Settings / Audit Trail.
export default function AppShellLayout({ children }: { children: ReactNode }) {
  return (
    <SessionGuard>
      <div className="shell">
        <Nav />
        <main className="content" id="main-content" tabIndex={-1}>{children}</main>
      </div>
    </SessionGuard>
  );
}
