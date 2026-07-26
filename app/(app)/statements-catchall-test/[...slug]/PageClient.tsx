'use client';
// SPIKE TEST ONLY: Option C probe — catch-all client route.
import { useParams } from 'next/navigation';

export default function CatchAllProbe() {
  const params = useParams<{ slug: string[] }>();
  const runtimeId = typeof window !== 'undefined' ? window.location.pathname.split('/').pop() : null;
  return <div data-testid="spike-option-c">params.slug={JSON.stringify(params.slug)} runtimeId={runtimeId}</div>;
}
