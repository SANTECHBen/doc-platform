// Server-side API client. Used by server components / route handlers /
// layouts to call the admin API with the current user's Microsoft ID
// token. Mirrors the client `lib/api.ts` but reads the session via
// NextAuth's server `auth()` helper instead of the /api/auth/session
// endpoint.
//
// All functions here are 'use server' eligible (they read the session
// cookie, which only works on the server). Pages that need to gate
// access to an org should prefer this module over the client API.

import { auth } from '@/auth';
import type { OrganizationSummary, AdminOrganization } from './api';

const API_BASE =
  process.env.API_BASE_INTERNAL ??
  process.env.NEXT_PUBLIC_API_BASE ??
  'http://localhost:3001';

async function bearer(): Promise<string | null> {
  const session = await auth();
  return session?.idToken ?? null;
}

interface FetchOptions {
  method?: string;
  body?: unknown;
}

// Returns parsed JSON on 2xx, null on 404, throws on any other status.
// 404 is intentionally treated as a normal "not found / no access" signal
// because the API uses 404 (not 403) when a user lacks scope to an org —
// this prevents enumeration of org IDs the user shouldn't know about.
async function callOrNull<T>(path: string, opts: FetchOptions = {}): Promise<T | null> {
  const token = await bearer();
  if (!token) return null;
  const res = await fetch(`${API_BASE}${path}`, {
    method: opts.method ?? 'GET',
    cache: 'no-store',
    headers: {
      authorization: `Bearer ${token}`,
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 404 || res.status === 401 || res.status === 403) return null;
  if (!res.ok) {
    throw new Error(`API ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as T;
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
