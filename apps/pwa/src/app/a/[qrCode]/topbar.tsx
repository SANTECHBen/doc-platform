'use client';

import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { SantechWordmark } from '@platform/ui';
import type { AssetHubPayload } from '@/lib/shared-schema';
import { BrandLogo } from '@/components/brand-logo';

// Asset hub topbar. Two presentations driven by the URL hash:
//
//   • Overview (no hash / #overview) — OEM brand mark on the left. The
//     identity band beneath carries the asset photo + title.
//   • Any other tab — compact asset name in the topbar so the tech
//     never loses "what am I working on" context as they move between
//     Library / Parts / Maintenance / Assistant. The status LED before
//     the name communicates whether anything needs attention.
//
// Right cluster: Powered-by wordmark. Voice-search and dark-mode toggle
// have been removed from the beta topbar; both features remain in the
// codebase (VoiceSearch component, ThemeToggle component) and can be
// re-introduced through a new entry point.

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
      <div className="app-topbar-actions">
        {/* Tablet+ create affordance. On phones the bottom-bar FAB handles
            this; on tablet (≥768px) the bottom bar is hidden and the FAB
            disappears with it, leaving the topbar as the only persistent
            global chrome. Dispatching a window event (rather than
            threading a callback) keeps the topbar a thin presentation
            component — AssetHubTabs owns the create state and listens
            for 'asset-hub:create' the same way it already listens for
            'asset-hub:tab' on brand-mark taps. */}
        <button
          type="button"
          onClick={() => window.dispatchEvent(new Event('asset-hub:create'))}
          className="app-topbar-create"
          aria-label="Document a procedure"
        >
          <Plus size={16} strokeWidth={2.5} aria-hidden />
          <span>Create</span>
        </button>
        <PoweredBy />
      </div>
    </header>
  );
}

// Platform attribution shown on the right of the topbar. "SAN" is
// inlined with currentColor so it adapts to light/dark theme; "TECH"
// stays the SANTECH brand red regardless. Wordmark itself is the
// shared SantechWordmark primitive from @platform/ui — the local
// .app-topbar-powered-by-mark class controls size + theme color.
function PoweredBy() {
  return (
    <span className="app-topbar-powered-by" aria-label="Powered by SANTECH">
      <span aria-hidden>Powered by</span>
      <SantechWordmark className="app-topbar-powered-by-mark" />
    </span>
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
