import withSerwistInit from '@serwist/next';

// Service worker wrapper — caches app shell + recently-viewed manuals so the
// PWA stays partially usable when the warehouse wifi drops out. Disabled in
// dev to avoid the worker shadowing live HMR.
const withSerwist = withSerwistInit({
  swSrc: 'src/app/sw.ts',
  swDest: 'public/sw.js',
  cacheOnNavigation: true,
  reloadOnOnline: true,
  disable: process.env.NODE_ENV === 'development',
});

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Workspace TS packages consumed at runtime — Next must transpile these
  // because they ship as .ts/.tsx source (no build step). Without this,
  // webpack resolves `./components/pdf-page.js` literally and fails — the
  // actual file is `.tsx`. Discovered after every PWA deploy for 11 hours
  // failed with this exact error and reverted to a pre-sections build.
  transpilePackages: ['@platform/viewer'],
  // The viewer package writes ESM-style `.js` import suffixes in its source
  // (Node ESM convention), but the actual files are `.tsx`/`.ts`. Webpack
  // doesn't natively rewrite the suffix — extensionAlias makes it try .tsx
  // and .ts before .js so the workspace package resolves cleanly.
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      '.js': ['.tsx', '.ts', '.js'],
      '.jsx': ['.tsx', '.jsx'],
    };
    return config;
  },
  experimental: {
    // typedRoutes: true,
  },
  async headers() {
    // CSP — same pattern as the admin app. The PWA needs:
    //   - Mic + camera (voice search + photo upload)  → Permissions-Policy
    //   - Mux HLS playback                            → frame-src, media-src
    //   - R2 PDF/image fetch                          → img-src, connect-src
    //   - pdfjs worker (CDN until self-host lands)    → worker-src, script-src
    //   - Microsoft sign-in not needed (PWA is anon)  → no login.microsoftonline.com
    //
    // connect-src includes the API origin so the PWA's client-side fetches
    // to https://equipment-hub-api.fly.dev/* work. Most PWA traffic goes
    // through the same-origin /api/* proxy, but a handful of direct calls
    // (streaming endpoints, voice) still hit the API host directly.
    const apiOrigin = (() => {
      const raw = process.env.NEXT_PUBLIC_API_BASE ?? '';
      if (!raw) return 'https://equipment-hub-api.fly.dev';
      try {
        return new URL(raw).origin;
      } catch {
        return 'https://equipment-hub-api.fly.dev';
      }
    })();
    const csp = [
      "default-src 'self'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'self'",
      "object-src 'none'",
      `img-src 'self' data: blob: ${apiOrigin} https://*.r2.cloudflarestorage.com https://*.r2.dev https://image.mux.com`,
      `media-src 'self' blob: ${apiOrigin} https://stream.mux.com`,
      "frame-src 'self' https://stream.mux.com",
      "font-src 'self' data:",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net",
      "worker-src 'self' blob: https://cdn.jsdelivr.net",
      "style-src 'self' 'unsafe-inline'",
      `connect-src 'self' ${apiOrigin} https://*.ingest.sentry.io https://*.r2.cloudflarestorage.com https://*.r2.dev https://image.mux.com https://stream.mux.com`,
      "manifest-src 'self'",
      process.env.NODE_ENV === 'production' ? 'upgrade-insecure-requests' : null,
    ]
      .filter(Boolean)
      .join('; ');
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=31536000; includeSubDomains',
          },
          {
            key: 'Permissions-Policy',
            // Mic + camera allowed on this origin only; everything else
            // disabled. Geolocation is allowed because field techs scan
            // QR codes which sometimes capture geotag context.
            value:
              'camera=(self), microphone=(self), geolocation=(self), payment=(), usb=(), midi=(), xr-spatial-tracking=()',
          },
          { key: 'X-Permitted-Cross-Domain-Policies', value: 'none' },
        ],
      },
    ];
  },
};

export default withSerwist(nextConfig);
