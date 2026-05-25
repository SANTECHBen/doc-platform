/** @type {import('next').NextConfig} */
// Content Security Policy. The admin console renders user-authored markdown
// (tiptap editor) and embeds PDFs via pdfjs + iframes, so we accept some
// known third-party origins (jsDelivr for pdfjs worker, Mux for video).
// Inline scripts use a per-request nonce in Server Components.
//
// Note: `script-src` includes 'unsafe-inline' because Next's hydration
// payload uses inline JSON without a nonce. The 'strict-dynamic' source
// pin makes browsers ignore 'unsafe-inline' when a nonce is present, but
// nonces require route-level middleware to mint per request — flagged as
// a follow-up. The current policy still blocks attacker-controlled remote
// scripts via the host allowlist.
const CSP_DIRECTIVES = [
  "default-src 'self'",
  "base-uri 'self'",
  "form-action 'self' https://login.microsoftonline.com",
  "frame-ancestors 'self'",
  "object-src 'none'",
  "img-src 'self' data: blob: https://*.r2.cloudflarestorage.com https://*.r2.dev https://image.mux.com",
  "media-src 'self' blob: https://stream.mux.com",
  "frame-src 'self' https://stream.mux.com",
  "font-src 'self' data:",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net",
  "worker-src 'self' blob: https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self' https://*.ingest.sentry.io https://login.microsoftonline.com https://*.r2.cloudflarestorage.com https://*.r2.dev https://image.mux.com https://stream.mux.com",
  "manifest-src 'self'",
  // Refuse to load resources over insecure HTTP in production.
  process.env.NODE_ENV === 'production' ? 'upgrade-insecure-requests' : null,
]
  .filter(Boolean)
  .join('; ');

export default {
  reactStrictMode: true,
  // Workspace TS packages consumed at runtime — Next must transpile them
  // because they ship as .ts/.tsx source. Without this, webpack tries to
  // resolve `./pdf-kernel.js` literally and fails — the actual file is
  // `.ts`. Same fix as the PWA's next.config.mjs.
  transpilePackages: ['@platform/viewer'],
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      '.js': ['.tsx', '.ts', '.js'],
      '.jsx': ['.tsx', '.jsx'],
    };
    return config;
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: CSP_DIRECTIVES },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=31536000; includeSubDomains',
          },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          { key: 'X-Permitted-Cross-Domain-Policies', value: 'none' },
        ],
      },
    ];
  },
};
