import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { ThemeToggle } from '@/components/theme-toggle';
import { IOSInstallBanner } from '@/components/ios-install-banner';
import { AssetHubTabs } from './tabs';
import { resolveAssetHub } from '@/lib/api';

// Hex "#F77531" → "247 117 49" for plugging into my CSS variables.
// Returns null on invalid input — caller falls back to the default brand.
function hexToRgbTriplet(hex: string | null | undefined): string | null {
  if (!hex) return null;
  const match = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  const n = parseInt(match[1]!, 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
}

export default async function AssetHubPage({
  params,
}: {
  params: Promise<{ qrCode: string }>;
}) {
  const { qrCode } = await params;
  const hub = await resolveAssetHub(qrCode);
  if (!hub) notFound();

  const openWo = hub.tabs.openWorkOrders.count;
  const ledClass = openWo > 0 ? 'led-warn' : 'led-ok';

  const brandRgb = hexToRgbTriplet(hub.brand.primary);
  const onBrandRgb = hexToRgbTriplet(hub.brand.onPrimary);

  // Inline style overrides the token values for this subtree only. Every
  // `rgb(var(--brand))` deeper in the tree picks up the OEM's brand.
  const brandStyle: React.CSSProperties | undefined = brandRgb
    ? ({
        ['--brand' as any]: brandRgb,
        ['--brand-strong' as any]: brandRgb,
        ['--ink-brand' as any]: brandRgb,
        ['--brand-glow' as any]: brandRgb,
        ['--signal-info' as any]: brandRgb,
        ...(onBrandRgb ? { ['--brand-ink' as any]: onBrandRgb } : {}),
      } as React.CSSProperties)
    : undefined;

  return (
    <main
      className="mx-auto flex max-w-3xl flex-col gap-4 px-3 py-3 md:px-4 md:py-4"
      style={brandStyle}
    >
      <header className="flex items-center justify-between">
        <Link
          href="/scan"
          className="inline-flex items-center gap-1.5 text-sm text-ink-secondary transition hover:text-ink-primary"
        >
          <ChevronLeft size={16} strokeWidth={2} />
          Scan another
        </Link>
        <div className="flex items-center gap-2.5">
          {hub.brand.logoUrl ? (
            <img
              src={hub.brand.logoUrl}
              alt={hub.brand.displayName}
              style={{ maxHeight: 22, maxWidth: 120, objectFit: 'contain' }}
            />
          ) : (
            <div
              className="brand-mark-square"
              style={{ width: 22, height: 22, fontSize: 10 }}
            >
              {hub.brand.initials}
            </div>
          )}
          <span className="hidden text-sm font-medium text-ink-secondary sm:inline">
            {hub.brand.displayName}
          </span>
        </div>
        <ThemeToggle />
      </header>

      <IOSInstallBanner />

      <div className="page-enter flex flex-col gap-6">
        {hub.assetModel.imageUrl && (
          <figure
            className="relative overflow-hidden rounded-lg border mx-auto"
            style={{
              borderColor: 'rgb(var(--surface-plate-edge))',
              height: 180,
              maxWidth: 520,
              width: '100%',
              background: 'rgb(var(--surface-elevated))',
            }}
          >
            <img
              src={hub.assetModel.imageUrl}
              alt={hub.assetModel.displayName}
              className="h-full w-full object-contain"
              style={{ padding: 12 }}
            />
          </figure>
        )}

        <header className="nameplate">
          <span className="corner-mark tl" />
          <span className="corner-mark tr" />
          <span className="corner-mark bl" />
          <span className="corner-mark br" />

          <div className="nameplate-top">
            <span className={`led ${ledClass}`} />
            <span className="caption">
              {hub.organization.name} · {hub.site.name}
            </span>
          </div>

          <div className="nameplate-row">
            <div>
              <div className="nameplate-title">{hub.assetModel.displayName}</div>
              <div className="nameplate-meta">
                <span>{hub.assetModel.modelCode}</span>
                <span className="sep">·</span>
                <span>
                  S/N <span className="serial">{hub.assetInstance.serialNumber}</span>
                </span>
                {hub.assetModel.category && (
                  <>
                    <span className="sep">·</span>
                    <span style={{ textTransform: 'uppercase' }}>
                      {hub.assetModel.category}
                    </span>
                  </>
                )}
              </div>
            </div>

            <div className="nameplate-metrics">
              <div className="nameplate-metric">
                <span className="cap">Rev</span>
                <span className="val">
                  {hub.pinnedContentPackVersion?.versionLabel ?? '—'}
                </span>
              </div>
              <div className="nameplate-metric">
                <span className="cap">Open WO</span>
                <span
                  className="val"
                  style={{
                    color:
                      openWo > 0
                        ? 'rgb(var(--signal-warn))'
                        : 'rgb(var(--signal-ok))',
                  }}
                >
                  {openWo}
                </span>
              </div>
            </div>
          </div>
        </header>

        <AssetHubTabs hub={hub} qrCode={qrCode} />
      </div>
    </main>
  );
}
