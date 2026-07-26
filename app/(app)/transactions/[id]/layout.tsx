import type { ReactNode } from 'react';

// The exported renderer must name every address it emits at build time, and a transaction id is
// only known when someone opens one. One placeholder page is emitted instead, and the shell
// serves it for any transaction address (see desktop/renderer.ts — the placeholder name must
// match RENDERER_ROUTE_SENTINEL there; test/desktop-renderer.test.ts holds the two together).
// Declared here rather than in page.tsx so the page stays a single browser-side file.
export function generateStaticParams() {
  return [{ id: 'sentinel' }];
}

export default function TransactionDetailLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
