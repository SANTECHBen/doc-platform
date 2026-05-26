import { NextResponse, type NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { SCAN_COOKIE_NAME } from '@/lib/scan-session';

// Same-origin proxy for SCORM package files.
//
// The SCORM API (window.API for 1.2, window.API_1484_11 for 2004) is
// exposed by the parent page hosting the iframe. The in-frame content
// reaches the API via window.parent.* — which throws SecurityError
// when the iframe is cross-origin. Hosting the package files under
// the PWA's own origin keeps the iframe same-origin so the bridge
// works.
//
// We forward the URL path to the upstream API's /scorm-content/* route
// which streams the bytes back from object storage. The PWA's scan
// cookie is forwarded as X-Scan-Session so the upstream can authorize
// the read against the package's owner org.

const UPSTREAM =
  process.env.API_BASE_INTERNAL ??
  process.env.NEXT_PUBLIC_API_BASE ??
  'http://localhost:3001';

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ packageId: string; path: string[] }> },
) {
  const { packageId, path } = await context.params;
  if (!packageId || !path?.length) {
    return new NextResponse('Not found', { status: 404 });
  }
  const cookieStore = await cookies();
  const scan = cookieStore.get(SCAN_COOKIE_NAME)?.value;
  const headers: HeadersInit = {};
  if (scan) headers['x-scan-session'] = scan;

  const upstreamUrl = new URL(
    `${UPSTREAM}/scorm-content/${encodeURIComponent(packageId)}/${path
      .map((p) => encodeURIComponent(p))
      .join('/')}`,
  );
  const res = await fetch(upstreamUrl.toString(), {
    headers,
    redirect: 'manual',
  });
  // Stream the body back. Mirror the content-type and cache-control
  // from the upstream so HTML, JS, audio etc. render correctly in the
  // iframe.
  const out = new NextResponse(res.body, {
    status: res.status,
    statusText: res.statusText,
  });
  const ct = res.headers.get('content-type');
  if (ct) out.headers.set('content-type', ct);
  const cc = res.headers.get('cache-control');
  if (cc) out.headers.set('cache-control', cc);
  // Allow framing under same-origin only.
  out.headers.set('x-frame-options', 'SAMEORIGIN');
  return out;
}

// Cookie-driven fetch can't run on the static edge — stay on Node.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
