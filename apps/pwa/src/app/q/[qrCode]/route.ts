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

  // Honor the actual request scheme. In production the PWA is served over
  // HTTPS so Secure must stay on, but for on-device testing across the LAN
  // (phone hitting http://<lan-ip>:3000), a Secure cookie is silently
  // dropped by the browser — the user lands on /a/<code> with no scan
  // session and every API tab fails 401. Detect HTTPS via the proxy header
  // first (covers Vercel + Fly), fall back to the URL scheme.
  const proto =
    request.headers.get('x-forwarded-proto') ??
    new URL(request.url).protocol.replace(':', '');
  const isHttps = proto === 'https';

  // Tag the redirect so the asset hub knows to play the intro splash on
  // this arrival. The client component strips ?intro=1 from the URL on
  // mount so a refresh during the animation doesn't replay it, and so
  // a shared /a/<code>?intro=1 link doesn't replay it for someone who
  // didn't actually scan a code.
  const target = new URL(`/a/${qrCode}`, request.url);
  target.searchParams.set('intro', '1');
  const response = NextResponse.redirect(target);
  response.cookies.set(SCAN_COOKIE_NAME, mintScanSessionValue(qrCode), {
    httpOnly: true,
    secure: isHttps,
    sameSite: 'lax',
    path: '/',
    maxAge: SCAN_COOKIE_MAX_AGE,
  });
  return response;
}
