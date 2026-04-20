// Admin sign-in page — branded landing with a single "Sign in with Microsoft"
// button that kicks off the Entra ID OAuth flow. Direct OIDC; no third-party
// IdP in the path.

import { signIn, auth } from '@/auth';
import { redirect } from 'next/navigation';

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string }>;
}) {
  const { callbackUrl } = await searchParams;
  const session = await auth();
  if (session) redirect(callbackUrl ?? '/');

  return (
    <main className="flex min-h-screen items-center justify-center bg-surface-base p-6">
      <div className="w-full max-w-sm rounded-md border border-line bg-surface-raised p-8 shadow-lg">
        <div className="mb-6 flex items-center gap-3">
          <div className="brand-mark-square">EH</div>
          <div className="flex flex-col leading-tight">
            <span className="text-sm font-semibold text-ink-primary">Equipment Hub</span>
            <span className="font-mono text-[10.5px] font-medium uppercase tracking-[0.08em] text-ink-tertiary">
              Admin · sign in
            </span>
          </div>
        </div>

        <p className="mb-6 text-sm text-ink-secondary">
          Sign in with your Microsoft work account to access the admin console.
        </p>

        <form
          action={async () => {
            'use server';
            await signIn('microsoft-entra-id', { redirectTo: callbackUrl ?? '/' });
          }}
        >
          <button
            type="submit"
            className="btn btn-primary w-full"
          >
            Sign in with Microsoft
          </button>
        </form>

        <p className="mt-6 text-xs text-ink-tertiary">
          Don't have access? Contact your Equipment Hub administrator.
        </p>
      </div>
    </main>
  );
}
