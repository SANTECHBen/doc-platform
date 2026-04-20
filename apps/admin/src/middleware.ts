// Route-level auth middleware. Every request to an admin page passes through
// here; unauthenticated users are redirected to the sign-in page. Uses
// NextAuth v5's `auth()` wrapper which handles the session cookie verification.

import { auth } from '@/auth';

export default auth((req) => {
  const { pathname } = req.nextUrl;
  const isSignInPage = pathname === '/sign-in';
  const isAuthRoute = pathname.startsWith('/api/auth');

  // Public: sign-in page itself and the NextAuth endpoints.
  if (isSignInPage || isAuthRoute) return;

  // Everything else requires a session. Redirect to sign-in with the
  // attempted URL as the callback so we can return the user after login.
  if (!req.auth) {
    const signInUrl = new URL('/sign-in', req.url);
    signInUrl.searchParams.set('callbackUrl', req.nextUrl.pathname + req.nextUrl.search);
    return Response.redirect(signInUrl);
  }
});

export const config = {
  // Match all routes except static assets and Next's internals. This ensures
  // every page hit is gated, even the home dashboard.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.svg|manifest.webmanifest).*)'],
};
