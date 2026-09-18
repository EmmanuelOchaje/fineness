import type { Metadata } from 'next';
import './tokens.css';

export const metadata: Metadata = {
  title: 'Fineness — pre-trade risk verification for Arc',
  description:
    'Assays newly launched tokens on Arc by executing a real buy and sell, then reports what actually happened.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600;700&family=Instrument+Sans:wght@400;500&family=Instrument+Serif&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
