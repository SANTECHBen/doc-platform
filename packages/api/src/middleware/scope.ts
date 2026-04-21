// Per-user data scoping. Non-platform-admin users can only see data owned
// by their home organization or any descendant in the parent chain. The
// scope helper returns either "see all" (platformAdmin) or a concrete set
// of organization IDs that gate every listing.
//
// Descent rule: a user belonging to an OEM sees their OEM plus all dealers /
// integrators / end_customers whose parent chain climbs back to the OEM.
// A dealer sees itself + its end_customers. An end_customer sees itself.

import { sql } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { Database } from '@platform/db';

export interface Scope {
  /** When true, skip all org filters — the user is a platform admin. */
  all: boolean;
  /** When all=false, the concrete set of org IDs the user can see. */
  orgIds: string[];
}

/**
 * Resolve the scope for the authenticated user. Throws if the request is
 * unauthenticated — callers must call requireAuth() first.
 */
export async function getScope(request: FastifyRequest, db: Database): Promise<Scope> {
  if (!request.auth) throw new Error('getScope called without auth');
  if (request.auth.platformAdmin) return { all: true, orgIds: [] };

  // Descendant lookup via recursive CTE. Starts at the user's home org and
  // walks child orgs via parent_organization_id. Cheap at this scale; add
  // a materialized path column if the chain ever gets deep.
  const rows = (await db.execute(
    sql`WITH RECURSIVE tree AS (
          SELECT id FROM organizations WHERE id = ${request.auth.organizationId}
          UNION ALL
          SELECT o.id FROM organizations o
            JOIN tree t ON o.parent_organization_id = t.id
        )
        SELECT id FROM tree`,
  )) as unknown as Array<{ id: string }>;

  return { all: false, orgIds: rows.map((r) => r.id) };
}

/**
 * Helper for SQL `x = ANY(...)` guards in raw queries. Returns a Postgres
 * array literal suitable for casting with `::uuid[]`.
 */
export function orgIdsLiteral(scope: Scope): string {
  return `{${scope.orgIds.join(',')}}`;
}

/**
 * Throw 404 if the target org isn't in the caller's scope. Used on mutation
 * endpoints to block writes against resources in other orgs. 404 (not 403)
 * is deliberate — a scoped caller probing unknown IDs should not be able
 * to distinguish "exists elsewhere" from "doesn't exist".
 *
 * Platform admins (scope.all) bypass the check.
 */
export function requireOrgInScope(scope: Scope, orgId: string): void {
  if (scope.all) return;
  if (scope.orgIds.includes(orgId)) return;
  const err = new Error('Not found') as Error & { statusCode: number };
  err.statusCode = 404;
  throw err;
}
