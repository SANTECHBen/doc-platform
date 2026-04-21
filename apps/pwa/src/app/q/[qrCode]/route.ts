import { NextResponse, type NextRequest } from 'next/server';
import {
  mintScanSessionValue,
  SCAN_COOKIE_NAME,
  SCAN_COOKIE_MAX_AGE,
} from '@/lib/scan-session';

// QR stickers print URLs of the form /q/<code>. This is a Route Handler
// rather than a Server Component because Next.js 15 only permits cookie
// mutation from Route Handlers / Server Actions.
//
// The scan-session cookie is now minted on every scan (not just when the
// org has requireScanAccess enabled). The API uses the cookie as its
// primary tenant gate for anonymous /documents, /parts, etc. — without
// one, those endpoints 401. The requireScanAccess flag still governs
// whether the PWA shows a scan-wall; it no longer gates cookie minting.
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ qrCode: string }> },
) {
  const { qrCode } = await context.params;

  const response = NextResponse.redirect(new URL(`/a/${qrCode}`, request.url));
  response.cookies.set(SCAN_COOKIE_NAME, mintScanSessionValue(qrCode), {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: SCAN_COOKIE_MAX_AGE,
  });
  return response;
}
