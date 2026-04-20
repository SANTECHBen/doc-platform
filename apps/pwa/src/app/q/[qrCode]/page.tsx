import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { resolveAssetHub } from '@/lib/api';
import {
  mintScanSessionValue,
  SCAN_COOKIE_NAME,
  SCAN_COOKIE_MAX_AGE,
} from '@/lib/scan-session';

// Stickers print URLs of the form /q/<code>. We resolve server-side and
// forward to the stable asset URL. When the owning org has opted into
// scan-access gating, we also mint a short-lived signed cookie bound to
// this specific code — the /a/<code> server component verifies it before
// showing content. Visitors with just a shared URL (no cookie) hit a
// scan-wall instead.
export default async function QrResolvePage({
  params,
}: {
  params: Promise<{ qrCode: string }>;
}) {
  const { qrCode } = await params;

  // Always resolve the hub here so we know whether the owning org wants a
  // scan cookie. Avoids an extra network hop on the /a/<code> side and
  // keeps the logic centralized at the QR entry point.
  const hub = await resolveAssetHub(qrCode);

  // Unknown/inactive QR → let /a/<code> show a 404. Nothing to protect yet.
  if (hub?.organization.requireScanAccess) {
    const store = await cookies();
    store.set(SCAN_COOKIE_NAME, mintScanSessionValue(qrCode), {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: SCAN_COOKIE_MAX_AGE,
    });
  }

  redirect(`/a/${qrCode}`);
}
