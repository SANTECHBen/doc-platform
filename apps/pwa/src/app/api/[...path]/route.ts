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

// Identity headers the browser must NEVER be allowed to set. The PWA is an
// anonymous trust boundary — anything an attacker can put in browser memory
// (XSS, extension, SW compromise) would otherwise pivot to admin identity
// upstream. We unconditionally drop these from the inbound request and let
// the proxy rebuild identity exclusively from server-side cookie state.
const IDENTITY_HEADERS = new Set([
  'authorization',
  'x-dev-user',
  'x-scan-session',
  // Defense-in-depth: some Microsoft client libraries set proprietary auth
  // headers — strip them too.
  'x-ms-token-aad-id-token',
  'x-ms-token-aad-access-token',
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
    const lk = k.toLowerCase();
    if (HOP_BY_HOP.has(lk)) continue;
    if (IDENTITY_HEADERS.has(lk)) continue;
    headers.set(k, v);
  }

  // Rebuild identity exclusively from server-side cookie state. The browser
  // cannot read the HttpOnly scan cookie, so reading it here and minting the
  // upstream header is the *only* path to scan-session identity through the
  // proxy.
  const jar = await cookies();
  const scan = jar.get(SCAN_COOKIE_NAME);
  if (scan) headers.set('x-scan-session', scan.value);

  const method = request.method.toUpperCase();
  // Buffer the request body for non-multipart uploads. Streaming via
  // `duplex: 'half'` is required when the upstream consumes the body
  // (file uploads), but it's a footgun otherwise: if the upstream
  // returns early (e.g., 401 before reading the body), Node's fetch
  // ends up with a half-aborted response stream that NextResponse then
  // can't forward, surfacing as a 500 to the browser. JSON / text / form
  // bodies are tiny enough to buffer cleanly. Multipart/octet-stream
  // keep streaming (with the trade-off of the early-reject footgun for
  // file uploads — typically fine since file-upload endpoints validate
  // auth without rejecting).
  const contentType = request.headers.get('content-type') ?? '';
  const wantStreaming =
    contentType.startsWith('multipart/') ||
    contentType.startsWith('application/octet-stream');

  let body: BodyInit | undefined;
  if (method === 'GET' || method === 'HEAD') {
    body = undefined;
  } else if (wantStreaming) {
    body = request.body ?? undefined;
  } else {
    // Buffer to a string (or empty for no body). text() handles JSON
    // and urlencoded fine since both are UTF-8 text on the wire.
    body = (await request.text()) || undefined;
  }

  const fetchInit: RequestInit & { duplex?: 'half' } = {
    method,
    headers,
    body,
    cache: 'no-store',
    redirect: 'manual',
  };
  if (wantStreaming && body) fetchInit.duplex = 'half';

  const upstream = await fetch(target, fetchInit);

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
