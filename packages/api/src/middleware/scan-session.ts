import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, eq } from 'drizzle-orm';
import crypto from 'node:crypto';
import { schema, type Database } from '@platform/db';
import { getScope } from './scope';

/**
 * Scan-session middleware.
 *
 * The PWA signs a self-contained session value on every QR scan
 * (<code>.<expUnixSeconds>.<hmac>) and forwards it on each API call as
 * the X-Scan-Session header. The API verifies the HMAC against the shared
 * PWA_SESSION_SECRET, resolves the QR code to its asset instance + owning
 * org, and attaches the result to request.scanSession.
 *
 * Callers that need to serve scanned traffic treat request.scanSession as
 * a narrow authorization: it grants access to data belonging to the QR's
 * org, nothing else. Non-scan traffic (admin, authored tooling) should
 * stick with requireAuth()/getScope() — scanSession is for the anonymous
 * scan-and-view flow only.
 */
export async function registerScanSession(app: FastifyInstance) {
  const secret = app.ctx.env.PWA_SESSION_SECRET;
  if (!secret) {
    app.log.warn(
      'PWA_SESSION_SECRET not set — scan-session verification disabled; endpoints that rely on it will reject all scan traffic',
    );
  }

  app.addHook('preHandler', async (request) => {
    const raw = request.headers['x-scan-session'];
    const value = typeof raw === 'string' ? raw : null;
    if (!value || !secret) return;

    const parts = value.split('.');
    if (parts.length !== 3) return;
    const [code, expStr, sig] = parts;
    if (!code || !expStr || !sig) return;

    const exp = Number(expStr);
    if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return;

    const expected = hmac(`${code}.${exp}`, secret);
    const a = Buffer.from(sig, 'base64url');
    const b = Buffer.from(expected, 'base64url');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return;

    // Signature good. Resolve the QR to its owning org — one extra query
    // per scan-authenticated request. The QR row is small, the index on
    // (code, active) makes this ~sub-ms.
    const { db } = app.ctx;
    const qr = await db.query.qrCodes.findFirst({
      where: and(eq(schema.qrCodes.code, code), eq(schema.qrCodes.active, true)),
    });
    if (!qr || !qr.assetInstanceId) return;

    const instance = await db.query.assetInstances.findFirst({
      where: eq(schema.assetInstances.id, qr.assetInstanceId),
      with: { site: true },
    });
    if (!instance) return;

    request.scanSession = {
      qrCode: code,
      assetInstanceId: instance.id,
      organizationId: instance.site.organizationId,
    };
  });
}

function hmac(payload: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

/**
 * Resolve the set of organization IDs the request is authorized to see.
 * Precedence: user auth wins (full home-org + descendant tree via getScope).
 * If only a scan session is present, returns that QR's single org. Returns
 * null when neither is present — callers should treat this as 401.
 *
 * The return type collapses both "authenticated" and "scanned" callers
 * into one org-id list, so endpoints just filter `WHERE org_id = ANY(...)`
 * without branching on the auth mode.
 */
export async function getEffectiveOrgScope(
  request: FastifyRequest,
  db: Database,
): Promise<{ all: boolean; orgIds: string[]; source: 'auth' | 'scan' } | null> {
  if (request.auth) {
    const scope = await getScope(request, db);
    return { all: scope.all, orgIds: scope.orgIds, source: 'auth' };
  }
  if (request.scanSession) {
    return {
      all: false,
      orgIds: [request.scanSession.organizationId],
      source: 'scan',
    };
  }
  return null;
}

/**
 * Require either auth or a valid scan session. Throws 401 otherwise.
 * Most public-facing endpoints that expose org-owned data should call
 * this at the top.
 */
export function requireAuthOrScan(request: FastifyRequest): void {
  if (request.auth) return;
  if (request.scanSession) return;
  const err = new Error('Unauthorized') as Error & { statusCode: number };
  err.statusCode = 401;
  throw err;
}
