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

  // Kick off JWKS prewarm for known tenants so the first user request
  // after boot doesn't race a cold MS connection. Async, fire-and-forget.
  if (allowedTenants.length > 0) {
    prewarmTenantJwks(allowedTenants, app.log);
  }

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
          // Look up the actual user row so `platformAdmin` flows through
          // correctly. Without this, dev-auth bypasses the flag entirely
          // and SANTECH staff get treated like single-org customers.
          const row = await app.ctx.db.query.users.findFirst({
            where: eq(schema.users.id, userId),
            columns: { platformAdmin: true },
          });
          request.auth = {
            userId,
            organizationId,
            platformAdmin: row?.platformAdmin ?? false,
          };
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
    // Microsoft's JWKS lives at https://login.microsoftonline.com/{tenant}/discovery/v2.0/keys
    // — the issuer URL ends in /v2.0, but the discovery path drops it. Strip
    // the trailing /v2.0 segment before appending /discovery/v2.0/keys.
    const base = issuer.replace(/\/v2\.0\/?$/, '');
    jwks = createRemoteJWKSet(new URL(`${base}/discovery/v2.0/keys`), {
      // Fail the JWKS fetch fast instead of letting Node's default TCP
      // retry/keepalive timeouts stretch a 401 to 17+ seconds. We retry
      // at a higher level (verifyMsIdToken) so the user-facing request
      // can still succeed when the first attempt hits a TLS reset.
      timeoutDuration: 3000,
      cooldownDuration: 5000,
    });
    jwksByIssuer.set(issuer, jwks);
  }
  return jwks;
}

/** Pre-fetch JWKS for the listed Microsoft tenants so the first real
 *  request doesn't pay a cold-cache penalty (the failure mode we hit on
 *  Fly redeploys, where an in-flight upload + cold JWKS racing each
 *  other produced a 17s ECONNRESET 401). Fire-and-forget — a temporary
 *  MS outage at boot must not block API startup.
 *
 *  We hit the discovery URL with a plain fetch. That's enough to warm
 *  DNS, TLS session tickets, and Undici's keepalive pool, so jose's
 *  first internal fetch on a real request lands on an already-open
 *  connection. We don't populate jose's key cache directly — jose will
 *  do that on the first verification, but by then the network path is
 *  warm and the fetch returns in single-digit ms instead of hanging. */
export function prewarmTenantJwks(
  tenantIds: string[],
  log?: { warn: (o: unknown, m?: string) => void; info?: (o: unknown, m?: string) => void },
): void {
  for (const tid of tenantIds) {
    const url = `https://login.microsoftonline.com/${tid}/discovery/v2.0/keys`;
    fetch(url, { signal: AbortSignal.timeout(3000) })
      .then((r) => log?.info?.({ tid, status: r.status }, 'auth: jwks prewarm ok'))
      .catch((err) => log?.warn({ err, tid }, 'auth: jwks prewarm failed (non-fatal)'));
  }
}

function isTransientNetworkError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; name?: string; cause?: unknown };
  // Node net errors, AbortError from a hit timeout, and Undici fetch
  // errors that wrap a deeper cause.
  if (e.code === 'ECONNRESET' || e.code === 'ETIMEDOUT' || e.code === 'UND_ERR_SOCKET') return true;
  if (e.name === 'AbortError' || e.name === 'TimeoutError') return true;
  if (e.cause) return isTransientNetworkError(e.cause);
  return false;
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
  // Retry the verification when the JWKS fetch hits a transient network
  // error (ECONNRESET, timeout, etc.). Permanent failures — bad
  // signature, wrong audience, expired token — are NOT retried; they
  // surface immediately so genuine 401s stay fast.
  const maxAttempts = 3;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { payload } = await jwtVerify(token, jwks, { audience, issuer });
      return payload as MsClaims;
    } catch (err) {
      lastErr = err;
      if (!isTransientNetworkError(err) || attempt === maxAttempts) throw err;
      // 100ms, 300ms backoff. Total worst case ~400ms + 2× 3s timeouts
      // = ~6.4s ceiling instead of jose's open-ended default.
      await new Promise((r) => setTimeout(r, attempt === 1 ? 100 : 300));
    }
  }
  throw lastErr;
}

// ---- User provisioning on first sign-in ------------------------------------

async function upsertUserFromClaims(
  app: FastifyInstance,
  claims: MsClaims,
): Promise<{ userId: string; organizationId: string; platformAdmin: boolean } | null> {
  const { db } = app.ctx;
  const email = claims.email ?? claims.preferred_username;
  if (!email) {
    app.log.warn('auth: token has no email / preferred_username');
    return null;
  }
  const displayName = claims.name ?? email;

  // Bootstrap platform admins: emails in this env list get platform_admin=true
  // on every sign-in. This is the chicken-and-egg workaround for setting up
  // the first SANTECH admin — no UI required to grant admin to myself.
  const platformAdminEmails = (app.ctx.env.PLATFORM_ADMIN_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  const isPlatformAdmin = platformAdminEmails.includes(email.toLowerCase());

  // Resolve the user's home org from their Microsoft tenant ID when a
  // matching organizations.msft_tenant_id row exists. This is how customer
  // admins get mapped to their own org: we tag the org with their tenant,
  // they sign in, they land in their own scope automatically.
  let resolvedHomeOrgId: string | null = null;
  if (claims.tid) {
    const tenantMatch = await db.query.organizations.findFirst({
      where: eq(schema.organizations.msftTenantId, claims.tid),
    });
    if (tenantMatch) resolvedHomeOrgId = tenantMatch.id;
  }

  // Lookup existing user by email.
  let user = await db.query.users.findFirst({
    where: eq(schema.users.email, email),
  });

  if (!user) {
    // First sign-in — create a user record. Home org preference:
    //   1. Tenant-mapped org (claims.tid → organizations.msft_tenant_id)
    //   2. First end_customer org (placeholder — unmapped tenant fallback)
    const fallback = await db.query.organizations.findFirst({
      where: eq(schema.organizations.type, 'end_customer'),
    });
    const homeOrgId = resolvedHomeOrgId ?? fallback?.id;
    if (!homeOrgId) {
      app.log.error('auth: no home org available — cannot auto-provision user');
      return null;
    }
    const [created] = await db
      .insert(schema.users)
      .values({
        homeOrganizationId: homeOrgId,
        email,
        displayName,
        platformAdmin: isPlatformAdmin,
      })
      .returning();
    if (!created) return null;
    user = created;
    app.log.info(
      { userId: user.id, email, platformAdmin: isPlatformAdmin, homeOrgId },
      'auth: provisioned new user from MS sign-in',
    );
  } else {
    // Keep platform_admin in sync with env on every sign-in. Also update
    // homeOrg if the tenant mapping has changed (rare but possible).
    const updates: Record<string, unknown> = {};
    if (user.platformAdmin !== isPlatformAdmin) updates.platformAdmin = isPlatformAdmin;
    if (resolvedHomeOrgId && user.homeOrganizationId !== resolvedHomeOrgId) {
      updates.homeOrganizationId = resolvedHomeOrgId;
    }
    if (Object.keys(updates).length > 0) {
      const [updated] = await db
        .update(schema.users)
        .set(updates)
        .where(eq(schema.users.id, user.id))
        .returning();
      if (updated) user = updated;
    }
  }

  return {
    userId: user.id,
    organizationId: user.homeOrganizationId,
    platformAdmin: user.platformAdmin,
  };
}
