import type { Metadata } from 'next';
import { IBM_Plex_Sans, IBM_Plex_Mono } from 'next/font/google';
import { auth } from '@/auth';
import { Sidebar } from '@/components/sidebar';
import { UserMenu } from '@/components/user-menu';
import { CommandPalette } from '@/components/command-palette';
import { InactivityWatcher } from '@/components/inactivity-watcher';
import { ToastProvider } from '@/components/toast';
import { themeBootScript } from '@/components/theme-toggle';
import './globals.css';

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
  title: 'FieldSupport — Admin',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // When signed in, render the full admin chrome (sidebar + command palette).
  // When not, render children alone — the sign-in page handles its own layout.
  // Middleware already redirects unauthenticated users to /sign-in, so this
  // is mainly a visual concern.
  const session = await auth();
  return (
    <html
      lang="en"
      className={`${sans.variable} ${mono.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
      </head>
      <body className="min-h-screen bg-surface-base font-sans text-ink-primary antialiased">
        {/* Skip-to-content link. First focusable element in the body;
            invisible until focused, then jumps focus into #main so a
            keyboard user can bypass the sidebar + topbar in one Tab. */}
        <a href="#main" className="skip-to-content">
          Skip to main content
        </a>
        <ToastProvider>
          {session ? (
            <>
              <div className="flex min-h-screen">
                <Sidebar userMenu={<UserMenu />} />
                <div className="flex min-h-screen flex-1 flex-col">
                  <main id="main" tabIndex={-1} className="flex-1 focus:outline-none">
                    {children}
                  </main>
                </div>
              </div>
              <CommandPalette />
              <InactivityWatcher />
            </>
          ) : (
            children
          )}
        </ToastProvider>
      </body>
    </html>
  );
}
