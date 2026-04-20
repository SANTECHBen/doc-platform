import { NextResponse, type NextRequest } from 'next/server';
import { resolveAssetHub } from '@/lib/api';
import {
  mintScanSessionValue,
  SCAN_COOKIE_NAME,
  SCAN_COOKIE_MAX_AGE,
} from '@/lib/scan-session';

// QR stickers print URLs of the form /q/<code>. This is a Route Handler
// rather than a Server Component because Next.js 15 only permits cookie
// mutation from Route Handlers / Server Actions — and we need to mint the
// short-lived scan-session cookie for orgs that have opted into the
// scan-gate. Resolving the hub inline tells us whether the owning org
// requires scan access; we set the cookie only when it does, then redirect
// to /a/<code> so the user lands on the asset hub.
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ qrCode: string }> },
) {
  const { qrCode } = await context.params;

  const hub = await resolveAssetHub(qrCode, 'qr');

  const response = NextResponse.redirect(new URL(`/a/${qrCode}`, request.url));
  if (hub?.organization.requireScanAccess) {
    response.cookies.set(SCAN_COOKIE_NAME, mintScanSessionValue(qrCode), {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: SCAN_COOKIE_MAX_AGE,
    });
  }
  return response;
}
