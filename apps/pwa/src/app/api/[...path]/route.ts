import { NextResponse, type NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { SCAN_COOKIE_NAME } from '@/lib/scan-session';

// Catch-all proxy from the PWA to the upstream Fastify API. The browser
// can't read the HttpOnly scan cookie (by design), and cross-origin cookie
// forwarding via CORS is brittle, so every client-side API call hits this
// same-origin route. We read the scan cookie server-side, forward the
// signed value as X-Scan-Session to the API, then stream the response back.
//
// What we forward:
//   - Method, body, and a sanitized subset of the incoming headers
//   - X-Scan-Session: <signed cookie value>  (when the cookie is present)
//
// What we strip:
//   - The cookie header itself (the API has no notion of our PWA cookies)
//   - Connection/host headers that don't make sense upstream
//
// The upstream API base is read from a server-only env var so no secret
// or internal URL leaks into the client bundle.

const UPSTREAM =
  process.env.API_BASE_INTERNAL ??
  process.env.NEXT_PUBLIC_API_BASE ??
  'http://localhost:3001';

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
  'cookie',
]);

// Response headers to strip in addition to hop-by-hop. Node's fetch auto-
// decompresses the upstream body, so forwarding content-encoding/content-
// length as-is would make the browser try to decode already-decoded bytes
// (ERR_CONTENT_DECODING_FAILED) or truncate on a wrong length.
const STRIPPED_RESPONSE_HEADERS = new Set(['content-encoding', 'content-length']);

async function proxy(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  const target = `${UPSTREAM}/${path.map(encodeURIComponent).join('/')}${request.nextUrl.search}`;

  const headers = new Headers();
  for (const [k, v] of request.headers.entries()) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) headers.set(k, v);
  }

  const jar = await cookies();
  const scan = jar.get(SCAN_COOKIE_NAME);
  if (scan) headers.set('x-scan-session', scan.value);

  const method = request.method.toUpperCase();
  const body = method === 'GET' || method === 'HEAD' ? undefined : request.body;

  const upstream = await fetch(target, {
    method,
    headers,
    body,
    // @ts-expect-error — Next.js fetch extension for streaming request bodies.
    duplex: body ? 'half' : undefined,
    cache: 'no-store',
    redirect: 'manual',
  });

  const respHeaders = new Headers();
  upstream.headers.forEach((v, k) => {
    const lk = k.toLowerCase();
    if (HOP_BY_HOP.has(lk) || STRIPPED_RESPONSE_HEADERS.has(lk)) return;
    respHeaders.set(k, v);
  });

  return new NextResponse(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: respHeaders,
  });
}

export { proxy as GET, proxy as POST, proxy as PUT, proxy as PATCH, proxy as DELETE };
