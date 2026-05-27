'use client';

import { useEffect, useState } from 'react';
// Search icon used by the voice-search trigger. The button is hidden
// from the beta topbar (see commented block below); keep the import
// commented out so eslint doesn't flag it, and uncomment alongside the
// JSX to re-enable.
// import { Search } from 'lucide-react';
import type { AssetHubPayload } from '@/lib/shared-schema';
import { BrandLogo } from '@/components/brand-logo';
// ThemeToggle removed from the topbar for now — keep the import path
// reference here for the day we re-enable dark-mode switching, but the
// JSX usage below is also commented out so eslint doesn't flag this
// as an unused import. To bring it back: uncomment both the import
// (this line) and the <ThemeToggle /> render in the actions cluster.
// import { ThemeToggle } from '@/components/theme-toggle';

// Asset hub topbar. Two presentations driven by the URL hash:
//
//   • Overview (no hash / #overview) — OEM brand mark on the left. The
//     identity band beneath carries the asset photo + title.
//   • Any other tab — compact asset name in the topbar so the tech
//     never loses "what am I working on" context as they move between
//     Library / Parts / Maintenance / Assistant. The status LED before
//     the name communicates whether anything needs attention.
//
// Right cluster: Powered-by wordmark + voice-search trigger as a
// single tight group. Dark-mode toggle was removed for the beta —
// the codebase still ships ThemeToggle (commented out at the import
// above) for easy re-enablement.

export function AssetTopbar({ hub }: { hub: AssetHubPayload }) {
  const [showChip, setShowChip] = useState(false);

  useEffect(() => {
    function readHash() {
      const h = window.location.hash.replace(/^#/, '');
      // Anything other than overview shows the chip. Library back-compat
      // hashes (#docs / #training) also fold into the non-overview case.
      setShowChip(h !== '' && h !== 'overview');
    }
    readHash();
    window.addEventListener('popstate', readHash);
    window.addEventListener('hashchange', readHash);
    // AssetHubTabs changes the tab via history.pushState() which does NOT
    // fire popstate or hashchange. It dispatches a custom 'asset-hub:tab'
    // event after pushing so dependents (this topbar) can react.
    window.addEventListener('asset-hub:tab', readHash);
    return () => {
      window.removeEventListener('popstate', readHash);
      window.removeEventListener('hashchange', readHash);
      window.removeEventListener('asset-hub:tab', readHash);
    };
  }, []);

  // Tap the brand mark to return to Overview. Mirrors AssetHubTabs.changeTab:
  // clear the URL hash, push history so the device back button steps back
  // through tabs, and dispatch the cross-component event so the topbar
  // (and any future listener) updates.
  function goHome() {
    const url = new URL(window.location.href);
    url.hash = '';
    window.history.pushState({ tab: 'overview' }, '', url.toString());
    window.dispatchEvent(new Event('asset-hub:tab'));
  }

  return (
    <header className="app-topbar">
      {showChip ? (
        <AssetChip hub={hub} onClick={goHome} />
      ) : (
        <div className="app-topbar-brand">
          {hub.brand.logoUrl ? (
            <BrandLogo
              src={hub.brand.logoUrl}
              alt={hub.brand.displayName}
              initials={hub.brand.initials}
              onClick={goHome}
            />
          ) : (
            <button
              type="button"
              onClick={goHome}
              className="brand-logo-button brand-mark-square"
              style={{ width: 28, height: 28, fontSize: 11 }}
              aria-label={`${hub.brand.displayName} — return to Overview`}
            >
              {hub.brand.initials}
            </button>
          )}
        </div>
      )}
      {/* Right cluster — Powered-by wordmark and voice-search sit
          together with a tighter gap than the topbar's default 8px,
          so they read as one group rather than two free-floating
          elements with a gap between them. */}
      <div className="app-topbar-actions">
        <PoweredBy />
        {/* Voice search trigger — hidden from the beta topbar so the
            feature isn't user-accessible yet. The voice-search code,
            event wiring, and styles remain intact; uncomment this block
            (and the `Search` import above) to bring the button back.

            Voice search is distinct from the post-scan Voice assistant
            mode: search returns a ranked list of docs/steps; Voice
            assistant opens a conversational AI. Dispatching a window
            event keeps the topbar (server-rendered) decoupled from the
            asset-hub tabs tree (client-rendered with its own state).
        <button
          type="button"
          onClick={() => window.dispatchEvent(new Event('asset-hub:open-search'))}
          aria-label="Voice search — find a document, step, or section"
          title="Voice search — find a doc, step, or section (separate from Voice assistant)"
          className="app-topbar-search-btn"
        >
          <Search size={16} strokeWidth={2.25} aria-hidden />
        </button>
        */}
        {/* <ThemeToggle /> — removed from beta; see import comment above. */}
      </div>
    </header>
  );
}

// Platform attribution shown on the right of the topbar. "SAN" is
// inlined with currentColor so it adapts to light/dark theme; "TECH"
// stays the SANTECH brand red regardless.
function PoweredBy() {
  return (
    <span className="app-topbar-powered-by" aria-label="Powered by SANTECH">
      <span aria-hidden>Powered by</span>
      <SantechWordmark />
    </span>
  );
}

function SantechWordmark() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 1200 200"
      role="img"
      aria-label="SANTECH"
      fill="currentColor"
      className="app-topbar-powered-by-mark"
    >
      <path d="m46.02,180.91c-12.73-3.34-23.06-7.79-31.01-13.36l15.51-34.83c7.47,4.93,16.14,8.91,26,11.93,9.86,3.02,19.56,4.53,29.1,4.53,18.13,0,27.2-4.53,27.2-13.6,0-4.77-2.59-8.31-7.75-10.62-5.17-2.3-13.48-4.73-24.93-7.28-12.56-2.7-23.06-5.61-31.49-8.71-8.43-3.1-15.67-8.07-21.71-14.91-6.05-6.84-9.06-16.06-9.06-27.67,0-10.18,2.78-19.36,8.35-27.55,5.56-8.19,13.87-14.67,24.93-19.44,11.05-4.77,24.61-7.16,40.67-7.16,10.97,0,21.79,1.23,32.44,3.7,10.65,2.47,20.04,6.08,28.15,10.85l-14.55,35.07c-15.91-8.59-31.33-12.88-46.28-12.88-9.39,0-16.22,1.39-20.52,4.17-4.29,2.78-6.44,6.4-6.44,10.85s2.54,7.79,7.63,10.02c5.09,2.23,13.28,4.53,24.57,6.92,12.72,2.71,23.26,5.61,31.61,8.71,8.35,3.1,15.58,8.03,21.71,14.79,6.12,6.76,9.18,15.95,9.18,27.55,0,10.02-2.78,19.08-8.35,27.2-5.57,8.11-13.92,14.59-25.05,19.44-11.13,4.85-24.65,7.28-40.55,7.28-13.52,0-26.64-1.67-39.36-5.01Z" />
      <path d="m288.87,150.14h-70.61l-13.12,32.44h-48.19L230.66,15.59h46.52l73.95,166.99h-49.14l-13.12-32.44Zm-13.84-34.83l-21.47-53.44-21.47,53.44h42.94Z" />
      <path d="m519.31,15.59v166.99h-38.88l-73.71-88.98v88.98h-46.28V15.59h38.88l73.71,88.98V15.59h46.28Z" />
      <path fill="#e11d24" d="m583.59,53.04h-51.29V15.59h149.57v37.45h-51.05v129.54h-47.23V53.04Z" />
      <path fill="#e11d24" d="m829.53,146.08v36.5h-134.07V15.59h130.97v36.5h-84.21v28.15h74.19v35.31h-74.19v30.54h87.31Z" />
      <path fill="#e11d24" d="m887.62,174.83c-13.92-7.4-24.85-17.69-32.8-30.89-7.96-13.2-11.93-28.15-11.93-44.85s3.97-31.65,11.93-44.85c7.95-13.2,18.88-23.5,32.8-30.89,13.92-7.4,29.62-11.09,47.12-11.09,15.27,0,29.02,2.71,41.27,8.11,12.25,5.41,22.42,13.2,30.54,23.38l-30.06,27.2c-10.82-13.04-23.94-19.56-39.36-19.56-9.06,0-17.14,1.99-24.21,5.96-7.08,3.98-12.57,9.58-16.46,16.82-3.9,7.24-5.84,15.55-5.84,24.93s1.95,17.69,5.84,24.93c3.89,7.24,9.38,12.84,16.46,16.82,7.07,3.98,15.15,5.96,24.21,5.96,15.42,0,28.54-6.52,39.36-19.56l30.06,27.2c-8.11,10.18-18.29,17.97-30.54,23.38-12.25,5.41-26,8.11-41.27,8.11-17.5,0-33.2-3.7-47.12-11.09Z" />
      <path fill="#e11d24" d="m1182.36,15.59v166.99h-47.23v-65.13h-64.41v65.13h-47.23V15.59h47.23v62.74h64.41V15.59h47.23Z" />
    </svg>
  );
}

function AssetChip({ hub, onClick }: { hub: AssetHubPayload; onClick: () => void }) {
  const openCount = hub.tabs.openWorkOrders.count;
  const pmAction = hub.tabs.pm.needsAction;
  const ledClass =
    openCount > 0 || pmAction > 0 ? 'led led-warn' : 'led led-ok';
  return (
    <button
      type="button"
      onClick={onClick}
      className="app-topbar-chip app-topbar-chip-button"
      aria-label={`${hub.assetModel.displayName} — return to Overview`}
    >
      <span className={ledClass} aria-hidden />
      <span className="app-topbar-chip-name">{hub.assetModel.displayName}</span>
    </button>
  );
}
