// Admin sign-in page. Direct OIDC against Microsoft Entra ID — no third
// party IdP in the trust chain. The page itself is intentionally
// professional and quiet: a single decision (sign in with Microsoft),
// SANTECH attribution, and a non-alarming notice when the user got
// here because their session went idle.

import { signIn, auth } from '@/auth';
import { redirect } from 'next/navigation';
import { SantechWordmark } from '@platform/ui';

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
    <main
      id="main"
      tabIndex={-1}
      data-theme="light"
      className="signin-page focus:outline-none"
    >
      <div className="signin-card">
        <header className="signin-brand">
          <span className="signin-product-mark" aria-hidden>
            FS
          </span>
          <div>
            <h1 className="signin-product-name">FieldSupport</h1>
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
          Don't have access? Contact your FieldSupport administrator.
        </p>

        <footer className="signin-footer">
          <span>Powered by</span>
          <SantechWordmark className="signin-santech-mark" />
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

