import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: 'AP Hub',
  description: 'Human-supervised Gmail and bank-statement intake with proof-gated QuickBooks posting.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main-content">Skip to main content</a>
        {children}
      </body>
    </html>
  );
}
