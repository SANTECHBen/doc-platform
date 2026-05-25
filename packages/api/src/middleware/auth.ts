import type { FastifyInstance, FastifyRequest } from 'fastify';
import { eq, sql } from 'drizzle-orm';
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
  // Dev auth is build-gated on NODE_ENV — no runtime env can re-enable it in
  // production. The legacy ALLOW_DEV_AUTH env switch was removed in the
  // security hardening pass (loadEnv() now refuses to start if it's set to
  // '1' in production).
  const allowDevAuth = app.ctx.env.NODE_ENV !== 'production';
  const audience = app.ctx.env.AUTH_MICROSOFT_CLIENT_ID;
  // Tenant allow-list. Comma-separated MS tenant IDs. In production this is
  // mandatory (enforced by env.ts loadEnv) and we treat an empty list as
  // fail-closed (no tenant accepted). In development, an empty list means
  // "any validated tenant" so local Microsoft work-account testing is easy.
  const allowedTenants = (app.ctx.env.AUTH_ALLOWED_TENANTS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const tenantAllowed = (tid: string) => {
    if (allowedTenants.length === 0) {
      // Fail-open ONLY in non-production environments where the operator
      // explicitly omitted the allow-list. Production loadEnv rejects this
      // config so this branch is unreachable in prod.
      return app.ctx.env.NODE_ENV !== 'production';
    }
    return allowedTenants.includes(tid);
  };
  // SANTECH's own Microsoft Entra tenant. Required in production. The
  // platform-admin elevation grant is pinned to this tenant — a token from
  // any other tenant whose preferred_username/email happens to match an
  // entry in PLATFORM_ADMIN_EMAILS is NOT granted platform-admin.
  const santechTenantId = app.ctx.env.AUTH_SANTECH_TENANT_ID;

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
  // Prefer the verified `email` claim. preferred_username is a UPN and is
  // attacker-controllable on tenants the attacker owns (Microsoft does not
  // validate cross-tenant UPN uniqueness), so we no longer fall back to it
  // for identity. If `email` is missing entirely, refuse to provision.
  const rawEmail = claims.email;
  if (!rawEmail) {
    app.log.warn(
      { tid: claims.tid, oid: claims.oid },
      'auth: token has no verified email claim — refusing to provision user',
    );
    return null;
  }
  // Normalize email to lowercase. Microsoft can return mixed case across
  // tokens; lowercasing prevents shadow accounts and makes admin-elevation
  // comparisons stable.
  const email = rawEmail.toLowerCase();
  const displayName = claims.name ?? email;

  // Platform-admin grant. Pinned to (a) the SANTECH tenant and (b) the email
  // allow-list. Both conditions must hold. This closes the prior fail-open
  // where any attacker tenant containing a user with UPN
  // 'bnichols@santechservices.com' would be auto-elevated.
  const santechTenantId = app.ctx.env.AUTH_SANTECH_TENANT_ID;
  const platformAdminEmails = (app.ctx.env.PLATFORM_ADMIN_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  const isFromSantech =
    !!santechTenantId && !!claims.tid && claims.tid === santechTenantId;
  const isPlatformAdmin =
    isFromSantech && platformAdminEmails.includes(email);

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

  // Lookup existing user by email (case-insensitive — the email is already
  // lowercased above, so an existing row inserted before lowercasing was
  // enforced will only match if we LOWER(email) on both sides).
  let user = await db.query.users.findFirst({
    where: sql`LOWER(${schema.users.email}) = ${email}`,
  });

  if (!user) {
    // No tenant mapping AND no platform-admin grant ⇒ refuse the sign-in.
    // Previously we auto-mapped unknown tenants into the "first end_customer
    // org" which silently dropped strangers into a real customer's data.
    // The replacement flow is an admin-issued invite (see tenant_invites);
    // until that lands, unmapped tenants get a clean 401 rather than a
    // confused-deputy provisioning.
    if (!resolvedHomeOrgId && !isPlatformAdmin) {
      app.log.warn(
        { tid: claims.tid, email },
        'auth: refusing to provision — tenant has no organization mapping and email is not platform admin',
      );
      // Audit the rejected sign-in so security has a record. We log
      // against the SANTECH org if known (so the event is queryable);
      // otherwise we fall back to the first organization row available.
      // Either way the event records who tried and why.
      void recordSignInRejection(app, { tid: claims.tid ?? null, email });
      return null;
    }
    // SANTECH staff with no explicit tenant-mapped org: provision into the
    // SANTECH home org if one is tagged with the SANTECH tenant id; otherwise
    // refuse — we won't silently mint a SANTECH user into a customer org.
    const homeOrgId = resolvedHomeOrgId;
    if (!homeOrgId) {
      app.log.error(
        { tid: claims.tid, email, isPlatformAdmin },
        'auth: no home org available — SANTECH tenant must be tagged on its own organization row',
      );
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
      { userId: user.id, email, platformAdmin: isPlatformAdmin, homeOrgId, tid: claims.tid },
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
    // Audit the platform-admin grant/revoke — silent role changes via env
    // mutation are a quiet escalation path; visibility is the defense.
    if (user.platformAdmin !== isPlatformAdmin) {
      void db.insert(schema.auditEvents).values({
        organizationId: user.homeOrganizationId,
        actorUserId: user.id,
        eventType: isPlatformAdmin
          ? 'auth.platform_admin.granted'
          : 'auth.platform_admin.revoked',
        targetType: 'user',
        targetId: user.id,
        payload: { email, tid: claims.tid ?? null, source: 'PLATFORM_ADMIN_EMAILS' },
      }).catch((err) => app.log.warn({ err }, 'audit: platform-admin change write failed'));
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

/**
 * Record a sign-in rejection in the audit log. Best-effort — failures
 * here must not break the auth path. Used when an MS token verifies but
 * the user has no tenant mapping and no platform-admin grant (the
 * confused-deputy auto-provisioning was removed in the security pass).
 */
async function recordSignInRejection(
  app: FastifyInstance,
  info: { tid: string | null; email: string },
): Promise<void> {
  try {
    const fallbackOrg = await app.ctx.db.query.organizations.findFirst({
      columns: { id: true },
    });
    if (!fallbackOrg) return;
    await app.ctx.db.insert(schema.auditEvents).values({
      organizationId: fallbackOrg.id,
      actorUserId: null,
      eventType: 'auth.sign_in.rejected',
      targetType: 'user',
      targetId: null,
      payload: {
        reason: 'unmapped_tenant_no_admin_grant',
        tid: info.tid,
        email: info.email,
      },
    });
  } catch (err) {
    app.log.warn({ err }, 'audit: sign-in rejection write failed');
  }
}
