import './globals.css';
import type { Metadata } from 'next';
import { Analytics } from '@vercel/analytics/next';
import { Providers } from './providers';

const ideaName = process.env.NEXT_PUBLIC_IDEA_NAME || '아이디어 검증';

export const metadata: Metadata = {
  title: ideaName,
  description: process.env.NEXT_PUBLIC_IDEA_TAGLINE || '',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>
        <Providers>{children}</Providers>
        <Analytics />
      </body>
    </html>
  );
}
