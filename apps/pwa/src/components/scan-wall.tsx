import { QrCode } from 'lucide-react';

// Shown when a visitor hits /a/<code> without a valid scan session. The
// access model is: customers who opt into scan-access want techs to scan
// the physical QR sticker on the equipment rather than sharing URLs. This
// page makes that expectation clear without implying there's anything
// wrong — it's a designed friction, not an error.
export function ScanWall({ organizationName }: { organizationName: string }) {
  return (
    <main className="app-shell">
      <div className="app-scroll flex flex-1 items-center justify-center">
        <div className="flex max-w-sm flex-col items-center gap-5 text-center">
          <div className="icon-chip icon-chip-lg icon-chip-info">
            <QrCode size={28} strokeWidth={1.75} />
          </div>
          <div className="flex flex-col gap-2">
            <h1 className="text-lg font-semibold text-ink-primary">
              Scan this equipment's QR code
            </h1>
            <p className="text-sm text-ink-secondary">
              {organizationName} requires you to scan the QR sticker on the
              physical equipment to view its content. Open your phone's camera
              and point it at the sticker to continue.
            </p>
          </div>
          <p className="text-xs text-ink-tertiary">
            Your session will last your shift. You won't need to scan again
            for this asset during that time.
          </p>
        </div>
      </div>
    </main>
  );
}
