'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useSession } from '../lib/session';

const LINKS = [
  { href: '/today', label: 'Today' },
  { href: '/exceptions', label: 'Exceptions' },
  { href: '/transactions', label: 'Transactions' },
  { href: '/statements', label: 'Statements' },
  { href: '/onboarding', label: 'Setup' },
  { href: '/settings', label: 'Settings' },
  { href: '/audit', label: 'Audit Trail' },
];

export function Nav() {
  const pathname = usePathname();
  const me = useSession();
  return (
    <nav className="topnav" aria-label="Primary navigation">
      <span className="brand">BookScout OS</span>
      {LINKS.map((l) => {
        const active = pathname === l.href || pathname.startsWith(l.href + '/');
        return (
          <Link key={l.href} href={l.href} className={`navlink${active ? ' active' : ''}`} aria-current={active ? 'page' : undefined}>
            {l.label}
          </Link>
        );
      })}
      <span className="spacer" />
      <span className="who" data-testid="who">
        {me.email} · {me.role}
      </span>
    </nav>
  );
}
