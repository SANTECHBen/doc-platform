import type { Metadata, Viewport } from 'next';
import { IBM_Plex_Sans, IBM_Plex_Mono } from 'next/font/google';
import { ToastProvider } from '@/components/toast';
import { themeBootScript } from '@/components/theme-toggle';
import { densityBootScript } from '@/components/density-toggle';
import './globals.css';
// Virtual Job Aid styles — single source shared with the admin device-preview.
import '@platform/ui/job-aid.css';

const sans = IBM_Plex_Sans({
  subsets: ['latin'],
  // Four weights cover every label, body, button, and heading in the
  // product. Weight 300 (Light) was previously loaded but never used —
  // the design system uses 400/500/600/700. Dropping 300 saves ~40 kB
  // per route on the first paint.
  weight: ['400', '500', '600', '700'],
  variable: '--font-sans',
  display: 'swap',
});

const mono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'FieldSupport',
  description: 'Scan equipment to access docs, training, parts, and AI troubleshooting.',
  manifest: '/manifest.webmanifest',
  applicationName: 'FieldSupport',
  appleWebApp: {
    capable: true,
    title: 'FieldSupport',
    statusBarStyle: 'default',
  },
  formatDetection: { telephone: false },
  icons: {
    icon: '/icon.svg',
    apple: '/icon.svg',
  },
};

export const viewport: Viewport = {
  themeColor: '#F5F6F8',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${sans.variable} ${mono.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
        <script dangerouslySetInnerHTML={{ __html: densityBootScript }} />
      </head>
      <body className="min-h-screen bg-surface-base font-sans text-ink-primary antialiased">
        {/* Skip-to-content link. First focusable element in the body;
            invisible until focused, then anchors to the page's #main. */}
        <a href="#main" className="skip-to-content">
          Skip to main content
        </a>
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
