import PageClient from './PageClient';

export function generateStaticParams() {
  return [{ slug: ['sentinel'] }];
}

export default function Page() {
  return <PageClient />;
}
