'use client';

// Render the full-featured legacy parts catalog inside the workspace
// chrome. The v1 org-scoped version filtered strictly to
// owner === orgId, which hid parts owned by sibling orgs in scope and
// missed any parts the user had just created. Wrapping the legacy
// page restores parity with what the user can see elsewhere.
//
// Trade-off: clicks into a part navigate to /parts/[id] (legacy URL)
// and lose the workspace chrome briefly. Acceptable for v1 — the
// alternative is refactoring the 800-line legacy page to be
// scope-aware, which is a larger change.

import LegacyParts from '@/app/parts/page';

export default function OrgParts() {
  return <LegacyParts />;
}
