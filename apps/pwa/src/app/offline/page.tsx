// Offline fallback page. Served by the service worker when a navigation
// request hits the network and fails. Tech sees this instead of the
// browser's default "no internet" screen.
//
// Tone matches the scan wall: SCADA chrome, LED + cap eyebrow, plain
// explanation of what state we're in rather than implying anything is
// broken. Coverage gaps are normal in the field.

import { WifiOff } from 'lucide-react';
import Link from 'next/link';

export const metadata = { title: 'Offline · Equipment Hub' };

export default function OfflinePage() {
  return (
    <main className="app-shell">
      <div className="app-scroll flex flex-1 items-center justify-center">
        <div className="flex max-w-sm flex-col items-center gap-5 text-center">
          <div className="icon-chip icon-chip-lg icon-chip-warn">
            <WifiOff size={28} strokeWidth={1.75} />
          </div>
          <div className="flex items-center gap-2">
            <span className="led led-warn" aria-hidden />
            <span className="cap" style={{ color: 'rgb(var(--signal-warn))' }}>
              Offline
            </span>
          </div>
          <div className="flex flex-col gap-2">
            <h1 className="text-lg font-semibold text-ink-primary">
              No connection right now
            </h1>
            <p className="text-sm text-ink-secondary">
              Pages and manuals you&apos;ve viewed recently are still
              available — use the back button to revisit them, or scan
              the QR sticker again once you&apos;re back in coverage.
            </p>
          </div>
          <Link href="/" className="btn btn-secondary">
            Try again
          </Link>
        </div>
      </div>
    </main>
  );
}
