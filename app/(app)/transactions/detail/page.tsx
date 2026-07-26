'use client';

// SPIKE TEST ONLY: Option B probe — query-param route, not wired to any real data.
import { useSearchParams } from 'next/navigation';

export default function TransactionDetailQueryPage() {
  const sp = useSearchParams();
  const id = sp.get('id');
  return <div data-testid="spike-option-b">id={id}</div>;
}
