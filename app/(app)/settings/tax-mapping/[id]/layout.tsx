import type { ReactNode } from 'react';

export function generateStaticParams() {
  return [{ id: 'sentinel' }];
}

export default function TaxMappingDetailLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
