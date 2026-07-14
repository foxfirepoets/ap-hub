'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import type { Me } from './types';

// Client-side session guard + provider. On mount it resolves identity via GET /api/me
// (which enforces the session cookie server-side). Unauthenticated → redirect to /login.
// Authenticated → the resolved Me (email + role) is exposed to the shell so pages can gate
// action buttons by role. Real authorization is always enforced by the API routes.

const SessionContext = createContext<Me | null>(null);

export function useSession(): Me {
  const me = useContext(SessionContext);
  if (!me) throw new Error('useSession must be used within an authenticated SessionGuard');
  return me;
}

type GuardState = 'loading' | 'authed' | 'anon';

export function SessionGuard({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [state, setState] = useState<GuardState>('loading');
  const router = useRouter();

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const res = await fetch('/api/me', { credentials: 'same-origin', cache: 'no-store' });
        if (!active) return;
        if (res.status === 200) {
          const body = (await res.json()) as { data: Me };
          setMe(body.data);
          setState('authed');
        } else {
          setState('anon');
          router.replace('/login');
        }
      } catch {
        if (!active) return;
        setState('anon');
        router.replace('/login');
      }
    })();
    return () => {
      active = false;
    };
  }, [router]);

  if (state === 'loading') {
    return (
      <div className="centered muted" data-testid="session-loading">
        Loading…
      </div>
    );
  }
  if (state === 'anon' || !me) return null;

  return <SessionContext.Provider value={me}>{children}</SessionContext.Provider>;
}
