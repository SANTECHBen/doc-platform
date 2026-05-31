// FieldSupport PWA service worker (built with Serwist).
//
// Goal during beta: a tech who scans a QR, opens a manual, then walks into
// a dead-zone in the warehouse should still see the manual they just opened.
// Reports made offline get queued and submit when signal returns.
//
// What this caches (intentionally minimal — service workers cause more bugs
// than they prevent if too aggressive):
//   1. App shell (HTML/CSS/JS that Next.js precompiles)
//   2. Static assets in /icons/ and /images/
//   3. Recently fetched API responses for asset-hub + documents (stale-
//      while-revalidate so techs see *something* offline, fresh online)
//   4. Recently fetched PDF/image content from R2 (cache-first)
//
// What this does NOT cache:
//   - POST/PATCH/DELETE — never cache mutations.
//   - AI chat streams — must be live.
//   - QR resolution (/q/*) — must be fresh; redirects to /a/*.

/// <reference lib="webworker" />
import { defaultCache } from '@serwist/next/worker';
import type { PrecacheEntry, SerwistGlobalConfig } from 'serwist';
import { Serwist } from 'serwist';

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: ServiceWorkerGlobalScope & {
  __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
};

// Filter Serwist's defaultCache to remove any rule that would cache tenant-
// scoped or cross-origin opaque responses. On shared shop iPads, two techs
// can hit the same PWA from different scan sessions — anything the SW caches
// is potentially visible cross-user because the cache key is URL-only and
// does not vary by HttpOnly scan cookie.
//
// What we keep:
//   - Next.js static assets (precache + same-origin _next/static)
//   - App icons + own-origin static images
//   - Font files
//
// What we strip:
//   - All `/api/*` responses (tenant scoped)
//   - All cross-origin requests (R2 PDFs, Mux .m3u8, Sentry — caching opaque
//     responses defeats revocation and leaks across sessions)
function isTenantUnsafeRule(entry: { matcher: unknown }): boolean {
  // defaultCache rule matchers are functions or regex; we don't have a stable
  // identifier, so we tag by string-form of the matcher. The set below is
  // taken from @serwist/next/worker defaults.
  const src = String(entry.matcher);
  return (
    src.includes('/api/') ||
    src.includes('cross-origin') ||
    src.includes('crossOrigin') ||
    src.includes('image.mux.com') ||
    src.includes('stream.mux.com') ||
    src.includes('r2.dev') ||
    src.includes('cloudflarestorage.com')
  );
}

const safeRuntimeCaching = defaultCache.filter(
  (entry) => !isTenantUnsafeRule(entry as { matcher: unknown }),
);

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  runtimeCaching: safeRuntimeCaching,
  fallbacks: {
    entries: [
      {
        url: '/offline',
        matcher: ({ request }) => request.destination === 'document',
      },
    ],
  },
});

// Belt-and-suspenders: install a fetch listener that bypasses the SW for
// /api/* responses entirely. If a future defaultCache rule slips past the
// filter above, this guarantees no `/api/*` response ever enters any cache.
self.addEventListener('fetch', (event: FetchEvent) => {
  const url = new URL(event.request.url);
  if (url.origin === self.location.origin && url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(event.request));
  }
});

serwist.addEventListeners();
