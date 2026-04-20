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
    // downstream API calls can forward the signed token.
    async jwt({ token, account, profile }) {
      if (account?.id_token) {
        (token as Record<string, unknown>).idToken = account.id_token;
      }
      if (profile) {
        // MS-specific claims. `oid` is the user's immutable object ID across
        // password resets and email changes — safer than email as a user key.
        // `tid` is the tenant ID — which customer org the user belongs to.
        const p = profile as Record<string, unknown>;
        if (typeof p.oid === 'string') (token as Record<string, unknown>).oid = p.oid;
        if (typeof p.tid === 'string') (token as Record<string, unknown>).tid = p.tid;
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
