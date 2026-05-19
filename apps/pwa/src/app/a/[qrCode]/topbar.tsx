'use client';

import { useEffect, useState } from 'react';
import type { AssetHubPayload } from '@/lib/shared-schema';
import { BrandLogo } from '@/components/brand-logo';
import { ThemeToggle } from '@/components/theme-toggle';

// Asset hub topbar. Two presentations driven by the URL hash:
//
//   • Overview (no hash / #overview) — OEM brand mark on the left. The
//     identity band beneath carries the asset photo + title.
//   • Any other tab — compact asset name in the topbar so the tech
//     never loses "what am I working on" context as they move between
//     Library / Parts / Maintenance / Assistant. The status LED before
//     the name communicates whether anything needs attention.
//
// Right cluster: theme toggle only. Density is still available via
// the DensityToggle component but lives elsewhere — promoting it
// into the topbar made the surface read as "settings cluster" rather
// than a service-tool chrome.

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
    return () => {
      window.removeEventListener('popstate', readHash);
      window.removeEventListener('hashchange', readHash);
    };
  }, []);

  return (
    <header className="app-topbar">
      {showChip ? (
        <AssetChip hub={hub} />
      ) : (
        <div className="app-topbar-brand">
          {hub.brand.logoUrl ? (
            <BrandLogo
              src={hub.brand.logoUrl}
              alt={hub.brand.displayName}
              initials={hub.brand.initials}
            />
          ) : (
            <div className="brand-mark-square" style={{ width: 28, height: 28, fontSize: 11 }}>
              {hub.brand.initials}
            </div>
          )}
        </div>
      )}
      <div className="app-topbar-actions">
        <ThemeToggle />
      </div>
    </header>
  );
}

function AssetChip({ hub }: { hub: AssetHubPayload }) {
  const openCount = hub.tabs.openWorkOrders.count;
  const pmAction = hub.tabs.pm.needsAction;
  const ledClass =
    openCount > 0 || pmAction > 0 ? 'led led-warn' : 'led led-ok';
  return (
    <div className="app-topbar-chip" aria-label="Asset identity">
      <span className={ledClass} aria-hidden />
      <span className="app-topbar-chip-name">{hub.assetModel.displayName}</span>
    </div>
  );
}
