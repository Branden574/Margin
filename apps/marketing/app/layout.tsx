import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import './globals.css';
import { siteUrl } from '../lib/config';
const manrope = localFont({
  src: [
    { path: '../public/fonts/manrope-regular.woff2', weight: '400' },
    { path: '../public/fonts/manrope-semibold.woff2', weight: '600' },
    { path: '../public/fonts/manrope-bold.woff2', weight: '700' },
  ],
  variable: '--font-manrope',
  display: 'swap',
});
export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: { default: 'Margin — Make room for better documents.', template: '%s | Margin' },
  description:
    'A thoughtful PDF annotation workspace for students and teachers. Explore encrypted local documents, annotation tools, page editing, and recovery. An original Kami alternative in development.',
  keywords: [
    'PDF annotation',
    'Chrome PDF editor',
    'classroom PDF editor',
    'teacher PDF tools',
    'student PDF annotation',
    'Kami alternative',
  ],
  openGraph: {
    title: 'Margin — Make room for better documents.',
    description: 'Your documents. Finally, room to think.',
    type: 'website',
  },
  robots: { index: Boolean(process.env.NEXT_PUBLIC_SITE_URL), follow: true },
};
export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#f6f4ef' };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={manrope.variable} data-scroll-behavior="smooth">
      <body>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
