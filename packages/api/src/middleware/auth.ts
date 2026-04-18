import type { FastifyInstance } from 'fastify';

/**
 * Auth middleware stub. WorkOS integration lands in Phase 1 per the plan.
 *
 * For now we:
 *   - Accept a dev-only `x-dev-user` header to impersonate a user in development.
 *   - Leave `request.auth` undefined for unauthenticated requests; route handlers
 *     decide whether to require it (QR-scan entry points are intentionally open
 *     to allow anonymous preview of an asset's public-safe content).
 */
export async function registerAuth(app: FastifyInstance) {
  app.addHook('preHandler', async (request) => {
    if (app.ctx.env.NODE_ENV !== 'production') {
      const dev = request.headers['x-dev-user'];
      if (typeof dev === 'string' && dev.includes(':')) {
        const [userId, organizationId] = dev.split(':');
        if (userId && organizationId) {
          request.auth = { userId, organizationId };
        }
      }
    }
    // TODO: WorkOS JWT validation → populate request.auth.
  });
}

export function requireAuth(request: import('fastify').FastifyRequest) {
  if (!request.auth) {
    const err = new Error('Unauthorized') as Error & { statusCode: number };
    err.statusCode = 401;
    throw err;
  }
  return request.auth;
}
