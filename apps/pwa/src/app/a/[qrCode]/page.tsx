import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { ThemeToggle } from '@/components/theme-toggle';
import { FullscreenButton } from '@/components/fullscreen-button';
import { ScanWall } from '@/components/scan-wall';
import { AssetHubTabs } from './tabs';
import { resolveAssetHub } from '@/lib/api';
import { SCAN_COOKIE_NAME, verifyScanSessionValue } from '@/lib/scan-session';

// Hex "#F77531" → [247, 117, 49]. Returns null on invalid input.
function hexToRgb(hex: string | null | undefined): [number, number, number] | null {
  if (!hex) return null;
  const match = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  const n = parseInt(match[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToTriplet(rgb: [number, number, number]): string {
  return `${rgb[0]} ${rgb[1]} ${rgb[2]}`;
}

// WCAG relative luminance.
function luminance(rgb: [number, number, number]): number {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: [number, number, number], b: [number, number, number]): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

export default async function AssetHubPage({
  params,
}: {
  params: Promise<{ qrCode: string }>;
}) {
  const { qrCode } = await params;
  const hub = await resolveAssetHub(qrCode);
  if (!hub) notFound();

  // Scan-gate enforcement. If the owning org has opted in, a valid scan
  // session cookie is required — it's minted when a user lands on /q/<code>
  // (where QR codes point). Anyone sharing a /a/<code> URL out-of-band
  // lacks the cookie and sees a scan-wall instead of the hub. Blocked
  // attempts are audit-logged so customers can see URL-sharing attempts.
  if (hub.organization.requireScanAccess) {
    const cookieStore = await cookies();
    const session = cookieStore.get(SCAN_COOKIE_NAME)?.value;
    if (!session || !verifyScanSessionValue(session, qrCode)) {
      // Fire-and-forget blocked audit event.
      void resolveAssetHub(qrCode, 'blocked').catch(() => {});
      return <ScanWall organizationName={hub.organization.name} />;
    }
  }

  const openWo = hub.tabs.openWorkOrders.count;
  const ledClass = openWo > 0 ? 'led-warn' : 'led-ok';

  const brandRgb = hexToRgb(hub.brand.primary);
  const onBrandRgb = hexToRgb(hub.brand.onPrimary);

  // Reject the OEM palette if it would produce unreadable text. We need the
  // brand color to hit roughly 3.0:1 against whatever ink sits on top of it —
  // either the OEM-supplied onPrimary, or default white. Below that, buttons
  // and pills become illegible; better to fall back to the platform brand.
  const effectiveOnBrand: [number, number, number] = onBrandRgb ?? [255, 255, 255];
  const brandIsUsable =
    brandRgb !== null && contrast(brandRgb, effectiveOnBrand) >= 3.0;

  // A very light brand can't stand in for --ink-brand (used for text on light
  // surfaces). Demand 3.0:1 against the light-mode surface (≈#F5F6F8).
  const inkBrandIsUsable =
    brandRgb !== null && contrast(brandRgb, [245, 246, 248]) >= 3.0;

  const brandStyle: React.CSSProperties | undefined = brandIsUsable
    ? ({
        ['--brand' as any]: rgbToTriplet(brandRgb!),
        ['--brand-strong' as any]: rgbToTriplet(brandRgb!),
        ['--brand-glow' as any]: rgbToTriplet(brandRgb!),
        ['--signal-info' as any]: rgbToTriplet(brandRgb!),
        ...(inkBrandIsUsable
          ? { ['--ink-brand' as any]: rgbToTriplet(brandRgb!) }
          : {}),
        ...(onBrandRgb ? { ['--brand-ink' as any]: rgbToTriplet(onBrandRgb) } : {}),
      } as React.CSSProperties)
    : undefined;

  return (
    <main className="app-shell" style={brandStyle}>
      <header className="app-topbar">
        <div className="app-topbar-brand">
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
          <span className="text-sm font-medium text-ink-primary">
            {hub.brand.displayName}
          </span>
        </div>
        <FullscreenButton />
        <ThemeToggle />
      </header>

      <div className="app-scroll page-enter flex flex-col gap-4">
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
            {hub.assetModel.imageUrl && (
              <div
                className="nameplate-thumb"
                style={{
                  width: 56,
                  height: 56,
                  borderRadius: 8,
                  border: '1px solid rgb(var(--surface-plate-edge))',
                  background: 'rgb(var(--surface-elevated))',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                  overflow: 'hidden',
                  padding: 4,
                }}
              >
                <img
                  src={hub.assetModel.imageUrl}
                  alt=""
                  style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
                />
              </div>
            )}
            <div style={{ flex: 1, minWidth: 0 }}>
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
