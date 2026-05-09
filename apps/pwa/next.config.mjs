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
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
};

export default withSerwist(nextConfig);
