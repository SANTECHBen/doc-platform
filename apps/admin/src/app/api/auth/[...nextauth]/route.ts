// NextAuth v5 handler. Exposes /api/auth/signin, /api/auth/signout,
// /api/auth/callback/microsoft-entra-id, /api/auth/session, etc.
import { handlers } from '@/auth';

export const { GET, POST } = handlers;

// Pin to Node runtime — jose (for JWT verification) and NextAuth v5's
// cookie signing use APIs that need full Node, not edge.
export const runtime = 'nodejs';
