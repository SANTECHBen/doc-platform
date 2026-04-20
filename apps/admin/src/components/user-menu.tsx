// Current signed-in user + sign-out action. Server component — reads the
// NextAuth session directly. Sign-out is a server action to invalidate the
// cookie server-side, which is more robust than a client-only signOut().

import { LogOut } from 'lucide-react';
import { auth, signOut } from '@/auth';

export async function UserMenu() {
  const session = await auth();
  if (!session?.user) return null;

  const name = session.user.name ?? session.user.email ?? 'Signed in';

  return (
    <div
      className="flex items-center gap-2"
      style={{ color: 'rgba(255,255,255,0.65)' }}
    >
      <span
        className="max-w-[9rem] truncate text-[11px] font-medium"
        style={{ color: 'rgba(255,255,255,0.75)' }}
        title={session.user.email ?? name}
      >
        {name}
      </span>
      <form
        action={async () => {
          'use server';
          await signOut({ redirectTo: '/sign-in' });
        }}
      >
        <button
          type="submit"
          aria-label="Sign out"
          title="Sign out"
          className="inline-flex h-6 w-6 items-center justify-center rounded transition hover:bg-white/10"
          style={{ color: 'rgba(255,255,255,0.55)' }}
        >
          <LogOut size={12} strokeWidth={2} />
        </button>
      </form>
    </div>
  );
}
