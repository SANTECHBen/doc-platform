import Link from 'next/link';

// Rendered when requireOrgAccess() calls notFound() — i.e. the org id
// in the URL doesn't exist OR the signed-in user lacks scope to it.
// We intentionally don't distinguish between those two cases; the
// generic "we couldn't find that workspace" copy covers both without
// leaking whether the id is real.

export default function OrgNotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-base px-6 py-10">
      <div className="max-w-md text-center">
        <p className="caption mb-2">404</p>
        <h1 className="mb-3 text-2xl font-semibold text-ink-primary">
          Workspace not found
        </h1>
        <p className="mb-6 text-sm text-ink-secondary">
          We couldn't find that organization, or you don't have access to it.
          Check the link, or return to the organization picker to pick another.
        </p>
        <Link href="/orgs" className="btn btn-primary">
          ← All organizations
        </Link>
      </div>
    </div>
  );
}
