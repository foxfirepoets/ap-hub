import PageClient from './PageClient';

export function generateStaticParams() {
  return [{ id: 'sentinel' }];
}

export default function Page() {
  return <PageClient />;
}
