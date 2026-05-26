'use client';

// Bridge sign-in for the PWA.
//
// The PWA doesn't yet have its own Microsoft Entra sign-in flow — the
// canonical OIDC integration is still on the roadmap (see auth-prompt.tsx).
// Until then, an admin who is already signed in to the admin app can hand
// off their fresh Entra ID token to the PWA on a single device, which lets
// them test write paths (training enrollment, slide-course player scoring,
// procedure-run evidence) without a parallel auth flow.
//
// URL contract:
//   /admin-signin?token=<idToken>&next=<absoluteOrRelativeUrl>
//
// The token lives in localStorage under `pwa_bridge_id_token`. lib/api.ts
// reads it and forwards it as `Authorization: Bearer …`. The API
// validates it against Microsoft's JWKS exactly like an admin call.
//
// Security note: this is a stop-gap for the platform admin during
// testing. The token is visible to client JS on this origin, so a
// compromised PWA bundle could exfiltrate it. Once proper PWA OIDC
// lands, this route should be removed.

import { useEffect, useState } from 'react';
import { setBridgeIdToken, clearBridgeIdToken } from '@/lib/api';

export default function AdminSignInBridge() {
  const [state, setState] = useState<'pending' | 'ok' | 'missing' | 'cleared'>(
    'pending',
  );
  const [next, setNext] = useState<string>('/');

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token');
    const nextParam = params.get('next');
    const action = params.get('action');
    if (nextParam) setNext(nextParam);

    if (action === 'clear') {
      clearBridgeIdToken();
      setState('cleared');
      return;
    }

    if (!token) {
      setState('missing');
      return;
    }
    setBridgeIdToken(token);
    setState('ok');
    // Strip the token from the URL so it's not in the back-button
    // history. Use replace so this entry is removed from the stack.
    const cleanUrl = window.location.pathname + (nextParam ? `?next=${encodeURIComponent(nextParam)}` : '');
    window.history.replaceState(null, '', cleanUrl);
  }, []);

  return (
    <main className="mx-auto max-w-md p-6 text-sm">
      <h1 className="text-base font-semibold text-ink-primary">PWA sign-in bridge</h1>
      {state === 'pending' && <p className="mt-2 text-ink-tertiary">Working…</p>}
      {state === 'missing' && (
        <p className="mt-2 text-ink-tertiary">
          No <code>?token=</code> in the URL. Open this page from the admin app
          via the &ldquo;Sign in to PWA&rdquo; button.
        </p>
      )}
      {state === 'ok' && (
        <div className="mt-3 space-y-3">
          <p className="text-ink-secondary">
            Token stored. You can now use training, procedures, and other
            write paths on this device.
          </p>
          <a className="btn btn-primary" href={next}>
            Continue
          </a>
        </div>
      )}
      {state === 'cleared' && (
        <p className="mt-2 text-ink-tertiary">
          Stored token cleared. Future write paths will fail with 401 until
          you sign in again.
        </p>
      )}
    </main>
  );
}
