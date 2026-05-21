'use client';

// InactivityWatcher — signs the admin user out after a window of zero
// user interaction. Mounted from the root layout when there's an active
// session. Replaces the "logs out while the user is mid-task" behavior
// the platform owner kept hitting; the only auto-logout trigger now is
// genuine idleness.
//
// How it works:
//   - Listens for mousemove / keydown / click / scroll / touchstart on
//     the document. Any one of those resets the inactivity countdown.
//   - At INACTIVITY_MS (30 min) of zero activity, calls signOut() and
//     redirects to /sign-in. The signOut endpoint clears the cookie
//     server-side, so the next request is treated as unauthenticated.
//   - Independently, pokes /api/auth/session every SESSION_POLL_MS (5
//     min) while the user is active. That triggers NextAuth's jwt
//     callback which renews the Microsoft ID token via refresh_token —
//     without it, the cookie's token can stale-out even while the user
//     is clicking around (the callback only runs when a request hits a
//     route that calls auth(), which an SPA-style page may not).
//
// Tunable via env at build time if a customer asks for shorter idle
// windows; the defaults match what most enterprise SaaS uses.

import { useEffect, useRef } from 'react';
import { signOut } from 'next-auth/react';

const INACTIVITY_MS = 30 * 60 * 1000; // 30 minutes
const SESSION_POLL_MS = 5 * 60 * 1000; // 5 minutes
const ACTIVITY_EVENTS: (keyof DocumentEventMap)[] = [
  'mousemove',
  'mousedown',
  'keydown',
  'scroll',
  'touchstart',
];

export function InactivityWatcher(): null {
  const lastActivityRef = useRef<number>(Date.now());
  // Throttle the activity timestamp updates — mousemove fires ~60Hz and
  // we don't want to thrash React state. We only read this ref inside a
  // separate interval, so updating it in a listener is fine.
  const armed = useRef<boolean>(true);

  useEffect(() => {
    function bump() {
      lastActivityRef.current = Date.now();
    }
    for (const evt of ACTIVITY_EVENTS) {
      document.addEventListener(evt, bump, { passive: true });
    }

    const idleTimer = window.setInterval(() => {
      if (!armed.current) return;
      const idleFor = Date.now() - lastActivityRef.current;
      if (idleFor >= INACTIVITY_MS) {
        armed.current = false;
        void signOut({ callbackUrl: '/sign-in?reason=inactive' });
      }
    }, 30_000);

    // Periodic session refresh while the user is active. The fetch
    // triggers NextAuth's session/jwt callback chain server-side, which
    // is where the Microsoft refresh_token gets exchanged for a new
    // id_token before the existing one expires.
    const sessionPoll = window.setInterval(() => {
      const idleFor = Date.now() - lastActivityRef.current;
      // Only poll while the user has been active recently — if they
      // walked away, let the idle timer handle the sign-out.
      if (idleFor < INACTIVITY_MS) {
        void fetch('/api/auth/session', { cache: 'no-store' }).catch(() => {});
      }
    }, SESSION_POLL_MS);

    return () => {
      for (const evt of ACTIVITY_EVENTS) {
        document.removeEventListener(evt, bump);
      }
      window.clearInterval(idleTimer);
      window.clearInterval(sessionPoll);
    };
  }, []);

  return null;
}
