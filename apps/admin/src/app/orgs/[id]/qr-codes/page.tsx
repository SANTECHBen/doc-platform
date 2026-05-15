'use client';

// Render the full-featured legacy QR codes page inside the org
// workspace chrome. The legacy page already uses the scope-respecting
// API (listQrCodes / listAssetInstances) so codes shown are limited to
// what the user can see; the workspace sidebar continues to render
// because the URL is under /orgs/[id]/...
//
// This restores the rich functionality the v1 stripped-down listing
// was missing: mint form (pick instance → caption → template → Generate),
// QR preview thumbnails per row, full PWA URL display, batch selection,
// print sheet builder, per-code template overrides.
//
// Org-id filtering of the instance dropdown is a follow-up — today it
// shows every instance in scope (likely a small superset for most
// users; descendants of the home org).

import LegacyQrCodes from '@/app/qr-codes/page';

export default function OrgQrCodes() {
  return <LegacyQrCodes />;
}
