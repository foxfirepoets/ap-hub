import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: 'AP Hub',
  description: 'Human review UX over the ap-hub Gmail → proof-gated → QBO sandbox pipeline.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
