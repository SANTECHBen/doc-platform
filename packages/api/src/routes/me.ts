// Lightweight identity endpoint. The PWA polls this once per session to
// decide which admin-only affordances to show ("Promote answer to
// procedure" being the first). Server still enforces auth on the actual
// admin endpoints — the client check is purely cosmetic.
//
//   GET /me  →  { userId, organizationId, platformAdmin } | { unauthenticated: true }

import type { FastifyInstance } from 'fastify';

export async function registerMeRoutes(app: FastifyInstance) {
  app.get('/me', async (request) => {
    if (!request.auth) {
      return { unauthenticated: true as const };
    }
    return {
      userId: request.auth.userId,
      organizationId: request.auth.organizationId,
      platformAdmin: request.auth.platformAdmin === true,
    };
  });
}
