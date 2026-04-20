import type { FastifyInstance, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { createRemoteJWKSet, decodeJwt, jwtVerify, type JWTPayload } from 'jose';
import { schema } from '@platform/db';

/**
 * Auth middleware.
 *
 * Production path: Bearer token in Authorization header is a Microsoft Entra
 * ID–issued ID token. We validate the signature against Microsoft's JWKS
 * (per-tenant), then check audience + issuer. Claims give us the user's
 * Microsoft object ID (`oid` — immutable) and tenant (`tid`). We upsert a
 * local user record on first sign-in.
 *
 * Dev path (local only): a plain `x-dev-user: <userId>:<orgId>` header is
 * accepted if NODE_ENV != production OR ALLOW_DEV_AUTH=1. This lets us keep
 * using curl/scripts without spinning up the whole MS flow.
 */
export async function registerAuth(app: FastifyInstance) {
  const allowDevAuth =
    app.ctx.env.NODE_ENV !== 'production' || app.ctx.env.ALLOW_DEV_AUTH === '1';
  const audience = app.ctx.env.AUTH_MICROSOFT_CLIENT_ID;
  // Optional tenant allow-list. When set, tokens from other Microsoft tenants
  // are rejected even if otherwise valid — restricts admin access to the
  // listed customer orgs. Comma-separated. Empty = any validated tenant.
  const allowedTenants = (app.ctx.env.AUTH_ALLOWED_TENANTS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const tenantAllowed = (tid: string) =>
    allowedTenants.length === 0 || allowedTenants.includes(tid);

  app.addHook('preHandler', async (request) => {
    // 1. Microsoft Entra ID bearer token path (preferred in production).
    const header = request.headers.authorization;
    if (typeof header === 'string' && header.startsWith('Bearer ')) {
      const token = header.slice(7).trim();
      if (token) {
        try {
          if (!audience) {
            throw new Error('AUTH_MICROSOFT_CLIENT_ID not configured');
          }
          const claims = await verifyMsIdToken(token, audience);
          if (claims.tid && !tenantAllowed(claims.tid)) {
            app.log.warn({ tid: claims.tid }, 'auth: tenant not allowed');
            return;
          }
          const auth = await upsertUserFromClaims(app, claims);
          if (auth) request.auth = auth;
          return;
        } catch (err) {
          // Token invalid / expired / wrong audience — leave auth undefined.
          // requireAuth() will 401 when a protected endpoint is hit.
          app.log.warn({ err }, 'auth: token verification failed');
        }
      }
    }

    // 2. Dev header fallback.
    if (allowDevAuth) {
      const dev = request.headers['x-dev-user'];
      if (typeof dev === 'string' && dev.includes(':')) {
        const [userId, organizationId] = dev.split(':');
        if (userId && organizationId) {
          request.auth = { userId, organizationId };
        }
      }
    }
  });
}

export function requireAuth(request: FastifyRequest) {
  if (!request.auth) {
    const err = new Error('Unauthorized') as Error & { statusCode: number };
    err.statusCode = 401;
    throw err;
  }
  return request.auth;
}

// ---- Microsoft Entra ID token verification ---------------------------------

interface MsClaims extends JWTPayload {
  /** Immutable user object ID within the tenant. Our primary identity key. */
  oid?: string;
  /** Tenant ID. */
  tid?: string;
  /** User's email (may not always be present; falls back to preferred_username). */
  email?: string;
  preferred_username?: string;
  /** User's display name. */
  name?: string;
}

// One JWKS per Microsoft tenant. Jose caches the fetched keys and rotates
// when they expire, so we never hit Microsoft's JWKS endpoint per-request
// for a warm tenant.
const jwksByIssuer = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJwks(issuer: string): ReturnType<typeof createRemoteJWKSet> {
  let jwks = jwksByIssuer.get(issuer);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${issuer}/discovery/v2.0/keys`));
    jwksByIssuer.set(issuer, jwks);
  }
  return jwks;
}

async function verifyMsIdToken(token: string, audience: string): Promise<MsClaims> {
  // Peek at unverified claims to read the issuer (tenant-specific). The
  // signature is still validated below — we only use the unverified issuer
  // to locate the right JWKS. An attacker who forges the iss claim would
  // still fail signature verification because the JWKS at THAT issuer won't
  // sign their forged token.
  const unverified = decodeJwt(token);
  const issuer = unverified.iss;
  if (typeof issuer !== 'string' || !issuer.startsWith('https://login.microsoftonline.com/')) {
    throw new Error('token issuer is not Microsoft');
  }
  const jwks = getJwks(issuer);
  const { payload } = await jwtVerify(token, jwks, {
    audience,
    issuer,
  });
  return payload as MsClaims;
}

// ---- User provisioning on first sign-in ------------------------------------

async function upsertUserFromClaims(
  app: FastifyInstance,
  claims: MsClaims,
): Promise<{ userId: string; organizationId: string } | null> {
  const { db } = app.ctx;
  const email = claims.email ?? claims.preferred_username;
  if (!email) {
    app.log.warn('auth: token has no email / preferred_username');
    return null;
  }
  const displayName = claims.name ?? email;

  // Lookup existing user by email.
  let user = await db.query.users.findFirst({
    where: eq(schema.users.email, email),
  });

  if (!user) {
    // First sign-in — create a user record bound to the first end_customer
    // org as a placeholder home org. This is a minimal provisioning model:
    // all signed-in users share the same home org until we add per-tenant
    // mapping. The organization IDs are fine for running admin operations;
    // per-customer scoping is a separate schema + policy change.
    const endCustomer = await db.query.organizations.findFirst({
      where: eq(schema.organizations.type, 'end_customer'),
    });
    if (!endCustomer) {
      app.log.error('auth: no end_customer org exists — cannot auto-provision user');
      return null;
    }
    const [created] = await db
      .insert(schema.users)
      .values({
        homeOrganizationId: endCustomer.id,
        email,
        displayName,
      })
      .returning();
    if (!created) return null;
    user = created;
    app.log.info({ userId: user.id, email }, 'auth: provisioned new user from MS sign-in');
  }

  return { userId: user.id, organizationId: user.homeOrganizationId };
}
