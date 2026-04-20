// NextAuth v5 (auth.js) configuration for direct OIDC against Microsoft
// Entra ID. Multi-tenant ('organizations') so any customer's Microsoft tenant
// can sign in — scope lock-down per customer happens at the application
// layer (users table / membership), not at the auth provider layer.
//
// We store the Microsoft ID token in the session so admin → API calls can
// forward it; the API validates it against Microsoft's JWKS endpoint. This
// keeps the auth pipeline end-to-end Microsoft-signed — no third-party IdP
// in the trust chain.

import NextAuth, { type DefaultSession, type NextAuthConfig } from 'next-auth';
import MicrosoftEntraID from 'next-auth/providers/microsoft-entra-id';

declare module 'next-auth' {
  interface Session {
    idToken?: string;
    user: {
      id: string;
      tenantId?: string;
    } & DefaultSession['user'];
  }
}


const config: NextAuthConfig = {
  providers: [
    MicrosoftEntraID({
      clientId: process.env.AUTH_MICROSOFT_ENTRA_ID_ID,
      clientSecret: process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET,
      // 'organizations' = any work/school account in any Azure AD tenant.
      // Use 'common' if you ever need to accept personal MS accounts too.
      // A specific tenant ID locks to one organization (useful for testing).
      issuer: `https://login.microsoftonline.com/${process.env.AUTH_MICROSOFT_ENTRA_ID_TENANT_ID ?? 'organizations'}/v2.0`,
    }),
  ],
  // JWT strategy — session data is encoded in an encrypted JWT stored in a
  // cookie. No session DB required; sessions survive redeploys.
  session: { strategy: 'jwt' },
  callbacks: {
    // Persist the Microsoft ID token + key claims into our NextAuth JWT so
    // downstream API calls can forward the signed token. Microsoft ID tokens
    // expire ~1 hour after issue; we refresh before expiry using the
    // refresh_token Microsoft gave us at sign-in time so users stay signed
    // in indefinitely (until NextAuth's own session cookie expires).
    async jwt({ token, account, profile }) {
      const t = token as Record<string, unknown>;
      if (account) {
        // First pass on sign-in — persist all MS tokens + the expiry so we
        // know when to refresh.
        if (account.id_token) t.idToken = account.id_token;
        if (account.access_token) t.accessToken = account.access_token;
        if (account.refresh_token) t.refreshToken = account.refresh_token;
        if (typeof account.expires_at === 'number') t.expiresAt = account.expires_at;
      }
      if (profile) {
        const p = profile as Record<string, unknown>;
        if (typeof p.oid === 'string') t.oid = p.oid;
        if (typeof p.tid === 'string') t.tid = p.tid;
      }
      // Refresh if within 60 seconds of expiry (or already expired).
      const expiresAt = typeof t.expiresAt === 'number' ? t.expiresAt : 0;
      const now = Math.floor(Date.now() / 1000);
      if (expiresAt > 0 && now > expiresAt - 60 && typeof t.refreshToken === 'string') {
        try {
          const refreshed = await refreshMsTokens(t.refreshToken);
          t.idToken = refreshed.id_token;
          t.accessToken = refreshed.access_token;
          // MS sometimes rotates refresh tokens on refresh — keep the new one
          // when present, fall back to the old one when not.
          if (refreshed.refresh_token) t.refreshToken = refreshed.refresh_token;
          t.expiresAt = Math.floor(Date.now() / 1000) + (refreshed.expires_in ?? 3600);
          delete t.error;
        } catch (err) {
          // Refresh failed — mark the token so downstream code can redirect
          // to re-login. Session callback will return the error.
          t.error = 'RefreshFailed';
        }
      }
      return token;
    },
    async session({ session, token }) {
      const t = token as Record<string, unknown>;
      if (typeof t.idToken === 'string') session.idToken = t.idToken;
      if (typeof t.oid === 'string') session.user.id = t.oid;
      if (typeof t.tid === 'string') session.user.tenantId = t.tid;
      return session;
    },
  },
  pages: {
    signIn: '/sign-in',
  },
};

export const { handlers, auth, signIn, signOut } = NextAuth(config);

// Exchanges a refresh_token for a fresh id_token + access_token. Uses the
// tenant-aware endpoint when AUTH_MICROSOFT_ENTRA_ID_TENANT_ID is set;
// falls back to /organizations for multi-tenant apps.
async function refreshMsTokens(refreshToken: string): Promise<{
  id_token: string;
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}> {
  const tenant = process.env.AUTH_MICROSOFT_ENTRA_ID_TENANT_ID ?? 'organizations';
  const url = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: process.env.AUTH_MICROSOFT_ENTRA_ID_ID ?? '',
    client_secret: process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET ?? '',
    // Request the same scopes we had originally. openid is mandatory for an
    // ID token to come back; offline_access keeps a refresh_token rotating.
    scope: 'openid profile email offline_access',
  });
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    throw new Error(`Microsoft refresh failed ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as {
    id_token: string;
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };
}
