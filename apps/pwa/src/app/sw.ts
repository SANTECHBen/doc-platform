// Equipment Hub PWA service worker (built with Serwist).
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

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  runtimeCaching: defaultCache,
  fallbacks: {
    entries: [
      {
        url: '/offline',
        matcher: ({ request }) => request.destination === 'document',
      },
    ],
  },
});

serwist.addEventListeners();
