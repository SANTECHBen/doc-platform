// Admin sign-in page. Direct OIDC against Microsoft Entra ID — no third
// party IdP in the trust chain. The page itself is intentionally
// professional and quiet: a single decision (sign in with Microsoft),
// SANTECH attribution, and a non-alarming notice when the user got
// here because their session went idle.

import { signIn, auth } from '@/auth';
import { redirect } from 'next/navigation';

// Open-redirect guard. The callbackUrl querystring is attacker-controllable
// (anyone can craft a link to /sign-in?callbackUrl=https://evil.com/), so we
// constrain it to a same-origin relative path before either redirect() or
// signIn() consumes it. Anything that looks like an absolute URL, a protocol-
// relative URL (//evil.com), or a backslash-trick (\\evil.com) collapses to '/'.
function sanitizeCallbackUrl(raw: string | undefined): string {
  if (!raw) return '/';
  // Reject anything that isn't a leading single slash followed by a non-slash.
  // Disallows '//host', '/\\host', '/', empty, absolute URLs, javascript:, etc.
  if (raw.length < 2) return '/';
  if (raw[0] !== '/') return '/';
  if (raw[1] === '/' || raw[1] === '\\') return '/';
  // Reject URLs with embedded credentials or schemes — defensive.
  if (/^\/[a-z]+:/i.test(raw)) return '/';
  return raw;
}

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string; reason?: string }>;
}) {
  const { callbackUrl: rawCallback, reason } = await searchParams;
  const callbackUrl = sanitizeCallbackUrl(rawCallback);
  const session = await auth();
  if (session) redirect(callbackUrl);

  const signedOutForInactivity = reason === 'inactive';

  return (
    <main className="signin-page">
      <div className="signin-card">
        <header className="signin-brand">
          <span className="signin-product-mark" aria-hidden>
            EH
          </span>
          <div>
            <h1 className="signin-product-name">Equipment Hub</h1>
            <p className="signin-product-tagline">Admin console</p>
          </div>
        </header>

        {signedOutForInactivity && (
          <div className="signin-notice" role="status">
            <p>
              You were signed out after 30 minutes of inactivity. Sign in
              again to pick up where you left off.
            </p>
          </div>
        )}

        <p className="signin-lede">
          Sign in with your Microsoft work account to manage equipment,
          documentation, training, and field captures.
        </p>

        <form
          action={async () => {
            'use server';
            await signIn('microsoft-entra-id', {
              redirectTo: callbackUrl,
            });
          }}
        >
          <button type="submit" className="signin-microsoft-btn">
            <MicrosoftLogo />
            <span>Sign in with Microsoft</span>
          </button>
        </form>

        <p className="signin-help">
          Don't have access? Contact your Equipment Hub administrator.
        </p>

        <footer className="signin-footer">
          <span>Powered by</span>
          <SantechWordmark />
        </footer>
      </div>
    </main>
  );
}

// Microsoft's four-color brand mark. Public spec from Microsoft's brand
// guidelines — solid squares in a 2×2 grid, equal padding. Drawn inline
// rather than imported so the page has zero asset dependencies.
function MicrosoftLogo() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 21 21"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <rect x="1" y="1" width="9" height="9" fill="#f25022" />
      <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
      <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
      <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
    </svg>
  );
}

// SANTECH wordmark — same paths used in the PWA topbar. The "SAN"
// portion uses currentColor so it picks up the surrounding text color
// (works in light + dark). "TECH" stays the brand red regardless.
function SantechWordmark() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 1200 200"
      role="img"
      aria-label="SANTECH"
      fill="currentColor"
      className="signin-santech-mark"
    >
      <path d="m46.02,180.91c-12.73-3.34-23.06-7.79-31.01-13.36l15.51-34.83c7.47,4.93,16.14,8.91,26,11.93,9.86,3.02,19.56,4.53,29.1,4.53,18.13,0,27.2-4.53,27.2-13.6,0-4.77-2.59-8.31-7.75-10.62-5.17-2.3-13.48-4.73-24.93-7.28-12.56-2.7-23.06-5.61-31.49-8.71-8.43-3.1-15.67-8.07-21.71-14.91-6.05-6.84-9.06-16.06-9.06-27.67,0-10.18,2.78-19.36,8.35-27.55,5.56-8.19,13.87-14.67,24.93-19.44,11.05-4.77,24.61-7.16,40.67-7.16,10.97,0,21.79,1.23,32.44,3.7,10.65,2.47,20.04,6.08,28.15,10.85l-14.55,35.07c-15.91-8.59-31.33-12.88-46.28-12.88-9.39,0-16.22,1.39-20.52,4.17-4.29,2.78-6.44,6.4-6.44,10.85s2.54,7.79,7.63,10.02c5.09,2.23,13.28,4.53,24.57,6.92,12.72,2.71,23.26,5.61,31.61,8.71,8.35,3.1,15.58,8.03,21.71,14.79,6.12,6.76,9.18,15.95,9.18,27.55,0,10.02-2.78,19.08-8.35,27.2-5.57,8.11-13.92,14.59-25.05,19.44-11.13,4.85-24.65,7.28-40.55,7.28-13.52,0-26.64-1.67-39.36-5.01Z" />
      <path d="m288.87,150.14h-70.61l-13.12,32.44h-48.19L230.66,15.59h46.52l73.95,166.99h-49.14l-13.12-32.44Zm-13.84-34.83l-21.47-53.44-21.47,53.44h42.94Z" />
      <path d="m519.31,15.59v166.99h-38.88l-73.71-88.98v88.98h-46.28V15.59h38.88l73.71,88.98V15.59h46.28Z" />
      <path fill="#e11d24" d="m583.59,53.04h-51.29V15.59h149.57v37.45h-51.05v129.54h-47.23V53.04Z" />
      <path fill="#e11d24" d="m829.53,146.08v36.5h-134.07V15.59h130.97v36.5h-84.21v28.15h74.19v35.31h-74.19v30.54h87.31Z" />
      <path fill="#e11d24" d="m887.62,174.83c-13.92-7.4-24.85-17.69-32.8-30.89-7.96-13.2-11.93-28.15-11.93-44.85s3.97-31.65,11.93-44.85c7.95-13.2,18.88-23.5,32.8-30.89,13.92-7.4,29.62-11.09,47.12-11.09,15.27,0,29.02,2.71,41.27,8.11,12.25,5.41,22.42,13.2,30.54,23.38l-30.06,27.2c-10.82-13.04-23.94-19.56-39.36-19.56-9.06,0-17.14,1.99-24.21,5.96-7.08,3.98-12.57,9.58-16.46,16.82-3.9,7.24-5.84,15.55-5.84,24.93s1.95,17.69,5.84,24.93c3.89,7.24,9.38,12.84,16.46,16.82,7.07,3.98,15.15,5.96,24.21,5.96,15.42,0,28.54-6.52,39.36-19.56l30.06,27.2c-8.11,10.18-18.29,17.97-30.54,23.38-12.25,5.41-26,8.11-41.27,8.11-17.5,0-33.2-3.7-47.12-11.09Z" />
      <path fill="#e11d24" d="m1182.36,15.59v166.99h-47.23v-65.13h-64.41v65.13h-47.23V15.59h47.23v62.74h64.41V15.59h47.23Z" />
    </svg>
  );
}
