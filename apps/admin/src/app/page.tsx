// The root page now redirects to the canonical entry point — the
// organization picker. After the workspace refactor there's no
// "global dashboard" by default; admins start with "pick a customer
// to work on", which mirrors how the work actually decomposes.
//
// If we ever want a cross-org platform-admin dashboard back, it
// belongs at a separate URL (e.g. /admin/dashboard) so it doesn't
// crowd the customer-picker entry.

import { redirect } from 'next/navigation';

export default function HomePage() {
  redirect('/orgs');
}
