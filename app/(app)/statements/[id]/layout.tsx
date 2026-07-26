import type { ReactNode } from 'react';

// SPIKE (layout variant): generateStaticParams lives here instead of in a page.tsx wrapper,
// so page.tsx can stay a single untouched 'use client' file.
export function generateStaticParams() {
  return [{ id: 'sentinel' }];
}

export default function StatementDetailLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
