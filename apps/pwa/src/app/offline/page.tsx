// Offline fallback page. Served by the service worker when a navigation
// request hits the network and fails. Tech sees this instead of the
// browser's default "no internet" screen.

import { WifiOff } from 'lucide-react';
import Link from 'next/link';

export const metadata = { title: 'Offline · Equipment Hub' };

export default function OfflinePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-6 px-6 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-surface-inset text-ink-tertiary">
        <WifiOff size={28} strokeWidth={1.75} />
      </div>
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold text-ink-primary">No connection</h1>
        <p className="text-sm text-ink-secondary">
          You&apos;re offline. Pages and manuals you&apos;ve viewed recently
          are still available — try the back button or scan again once
          you&apos;re in coverage.
        </p>
      </div>
      <Link href="/" className="btn btn-secondary">
        Try again
      </Link>
    </main>
  );
}
