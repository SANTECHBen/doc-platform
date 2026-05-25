'use client';

// One-time prompt that appears when localStorage still contains designs
// from before the server-side store landed. Offers to upload them so they
// survive a browser wipe and become visible to teammates.
//
// We only render this banner when:
//   - the browser has at least one design in the legacy store
//   - the user hasn't already completed (or dismissed) the migration
//
// After "Upload now" succeeds, or after the user clicks "Dismiss", we
// stamp a sentinel key in localStorage so the banner never reappears for
// this browser.

import { useEffect, useState } from 'react';
import { CloudUpload, Loader2, X } from 'lucide-react';
import { useToast } from '@/components/toast';
import {
  markLegacyMigrationDone,
  migrateLegacyDesigns,
  readLegacyLocalStorageDesigns,
  type LegacyDesign,
} from '@/lib/qr-designer-storage';

export interface LegacyMigrationBannerProps {
  /** Called after a successful upload so the page can refresh the saved-
   *  designs list and show the new entries immediately. */
  onCompleted: () => void;
}

export function LegacyMigrationBanner({ onCompleted }: LegacyMigrationBannerProps) {
  const toast = useToast();
  const [legacy, setLegacy] = useState<LegacyDesign[] | null>(null);
  const [busy, setBusy] = useState(false);

  // Read localStorage on mount only. Hidden during SSR because reading
  // localStorage there would throw.
  useEffect(() => {
    setLegacy(readLegacyLocalStorageDesigns());
  }, []);

  if (!legacy || legacy.length === 0) return null;

  async function onUpload() {
    setBusy(true);
    try {
      const result = await migrateLegacyDesigns(legacy!);
      if (result.failed === 0) {
        toast.success(
          `Uploaded ${result.uploaded} design${result.uploaded === 1 ? '' : 's'}`,
          'Saved to the server and shared with your organization.',
        );
        markLegacyMigrationDone();
        setLegacy([]);
        onCompleted();
      } else {
        toast.error(
          `${result.uploaded} uploaded, ${result.failed} failed`,
          result.errors[0] ?? 'Some designs could not be uploaded.',
        );
        // Don't mark complete on partial failure — let the user retry.
        // Successful entries are already on the server; the retry only
        // re-uploads what's still in localStorage. Acceptable for v1.
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function onDismiss() {
    markLegacyMigrationDone();
    setLegacy([]);
  }

  return (
    <div className="mb-4 flex items-start justify-between gap-3 rounded-lg border border-brand/30 bg-brand/5 px-4 py-3">
      <div className="flex items-start gap-3">
        <CloudUpload size={16} strokeWidth={2} className="mt-0.5 shrink-0 text-brand" />
        <div className="text-sm">
          <p className="font-medium text-ink-primary">
            Move {legacy.length} design{legacy.length === 1 ? '' : 's'} to the server?
          </p>
          <p className="mt-0.5 text-xs text-ink-secondary">
            Designs are now stored on the platform and shared with your
            organization. We found {legacy.length} in this browser&rsquo;s local
            storage that could be uploaded so they survive a cache clear.
          </p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={onUpload}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded btn-primary px-3 py-1.5 text-xs disabled:opacity-50"
        >
          {busy ? (
            <Loader2 size={11} strokeWidth={2} className="animate-spin" />
          ) : (
            <CloudUpload size={11} strokeWidth={2} />
          )}
          Upload now
        </button>
        <button
          type="button"
          onClick={onDismiss}
          disabled={busy}
          className="inline-flex items-center gap-1 rounded border border-line bg-surface px-2 py-1.5 text-xs text-ink-secondary hover:bg-surface-inset disabled:opacity-50"
          title="Don't upload — keep designs only in this browser"
        >
          <X size={11} strokeWidth={2} />
          Dismiss
        </button>
      </div>
    </div>
  );
}
