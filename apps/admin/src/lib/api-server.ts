// Server-side API client. Used by server components / route handlers /
// layouts to call the admin API with the current user's Microsoft ID
// token. Mirrors the client `lib/api.ts` but reads the session via
// NextAuth's server `auth()` helper instead of the /api/auth/session
// endpoint.
//
// All functions here are 'use server' eligible (they read the session
// cookie, which only works on the server). Pages that need to gate
// access to an org should prefer this module over the client API.

import 'server-only';
import { setDefaultResultOrder } from 'node:dns';
import { auth } from '@/auth';
import type { OrganizationSummary, AdminOrganization } from './api';

// The Fly API is reachable over a shared IPv4 and a dedicated IPv6. We've
// observed the Vercel→Fly IPv6 path intermittently black-hole (connect
// timeouts / resets), which crashed server-rendered org pages with a 500.
// Prefer IPv4 (the reliable path) for all DNS lookups in this server runtime.
// This is process-wide and harmless: IPv6-only hosts still resolve normally,
// and every other upstream (Microsoft, S3) is dual-stack.
try {
  setDefaultResultOrder('ipv4first');
} catch {
  // Older/edge runtimes may not expose it; the retry logic below still covers
  // transient failures regardless.
}

const API_BASE =
  process.env.API_BASE_INTERNAL ??
  process.env.NEXT_PUBLIC_API_BASE ??
  'http://localhost:3001';

// Per-attempt budget. Short so a dead network path fails fast and we either
// retry or hand off to the client-side fallback quickly, rather than hanging
// for undici's 10s default connect timeout.
const ATTEMPT_TIMEOUT_MS = 5000;
const MAX_ATTEMPTS = 3;

/**
 * Thrown when the API can't be reached after retries — a network-level failure
 * (connect timeout, reset, DNS) or a transient gateway error, NOT a normal HTTP
 * "not found / no access". Callers (e.g. requireOrgAccess) use this to degrade
 * gracefully — render client-side instead of throwing a 500 — rather than
 * treating an unreachable API the same as a missing resource.
 */
export class ApiUnreachableError extends Error {
  constructor(
    public readonly path: string,
    options?: { cause?: unknown },
  ) {
    super(`API unreachable: ${path}`, options);
    this.name = 'ApiUnreachableError';
  }
}

interface FetchOptions {
  method?: string;
  body?: unknown;
}

// Transient gateway statuses worth retrying — the upstream is up but a proxy
// hop briefly couldn't reach it.
function isTransientStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
}

function backoffMs(attempt: number): number {
  return attempt * 300; // 300ms, 600ms between attempts
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Returns parsed JSON on 2xx, null on 404/401/403 (intentionally treated as a
 * normal "not found / no access" signal — the API uses 404 not 403 to prevent
 * org-id enumeration), throws ApiUnreachableError on network failure / transient
 * gateway errors after retries, and throws a plain Error on other non-ok
 * statuses (a real bug worth surfacing).
 *
 * Only idempotent requests (GET/HEAD) are retried, so a transient failure can
 * never duplicate a write.
 */
async function callOrNull<T>(path: string, opts: FetchOptions = {}): Promise<T | null> {
  const token = await bearer();
  if (!token) return null;

  const method = opts.method ?? 'GET';
  const idempotent = method === 'GET' || method === 'HEAD';
  const maxAttempts = idempotent ? MAX_ATTEMPTS : 1;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${API_BASE}${path}`, {
        method,
        cache: 'no-store',
        signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
        headers: {
          authorization: `Bearer ${token}`,
          ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
    } catch (err) {
      // Network-level failure: connect timeout, reset, abort (AbortSignal),
      // DNS. Retry idempotent calls; otherwise give up immediately.
      lastErr = err;
      if (attempt < maxAttempts) {
        await delay(backoffMs(attempt));
        continue;
      }
      throw new ApiUnreachableError(path, { cause: err });
    }

    if (res.status === 404 || res.status === 401 || res.status === 403) return null;

    if (isTransientStatus(res.status)) {
      lastErr = new Error(`API ${res.status}`);
      if (attempt < maxAttempts) {
        await delay(backoffMs(attempt));
        continue;
      }
      throw new ApiUnreachableError(path, { cause: lastErr });
    }

    if (!res.ok) {
      throw new Error(`API ${res.status}: ${await res.text()}`);
    }

    return (await res.json()) as T;
  }

  // Loop only exits via return/throw above; this satisfies the type checker.
  throw new ApiUnreachableError(path, { cause: lastErr });
}

async function bearer(): Promise<string | null> {
  const session = await auth();
  return session?.idToken ?? null;
}

export async function getOrgSummaryServer(
  id: string,
): Promise<OrganizationSummary | null> {
  return callOrNull<OrganizationSummary>(
    `/admin/organizations/${encodeURIComponent(id)}/summary`,
  );
}

export async function listOrganizationsServer(): Promise<AdminOrganization[] | null> {
  return callOrNull<AdminOrganization[]>('/admin/organizations');
}
