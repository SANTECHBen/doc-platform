import { createDb } from './client';
import * as schema from './schema';

// One-shot prod bootstrap. Inserts a single admin org + user with fixed IDs
// matching NEXT_PUBLIC_DEV_USER_ID / NEXT_PUBLIC_DEV_ORG_ID on the admin, so
// the x-dev-user header resolves. Run once against prod Neon; idempotent.

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');

const ORG_ID = process.env.BOOTSTRAP_ORG_ID;
const USER_ID = process.env.BOOTSTRAP_USER_ID;
const USER_EMAIL = process.env.BOOTSTRAP_USER_EMAIL ?? 'admin@local';
if (!ORG_ID || !USER_ID) {
  throw new Error('BOOTSTRAP_ORG_ID and BOOTSTRAP_USER_ID are required');
}

const db = createDb(url);

await db
  .insert(schema.organizations)
  .values({
    id: ORG_ID,
    type: 'oem',
    name: 'Platform Admin',
    slug: 'platform-admin',
    oemCode: 'PLATFORM',
  })
  .onConflictDoNothing();

await db
  .insert(schema.users)
  .values({
    id: USER_ID,
    homeOrganizationId: ORG_ID,
    email: USER_EMAIL,
    displayName: 'Platform Admin',
  })
  .onConflictDoNothing();

await db
  .insert(schema.memberships)
  .values({
    userId: USER_ID,
    organizationId: ORG_ID,
    role: 'admin',
  })
  .onConflictDoNothing();

console.log(`Bootstrap complete — org ${ORG_ID}, user ${USER_ID}`);
process.exit(0);
