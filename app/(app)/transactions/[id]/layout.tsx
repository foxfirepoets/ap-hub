import type { ReactNode } from 'react';

export function generateStaticParams() {
  return [{ id: 'sentinel' }];
}

export default function TransactionDetailLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
