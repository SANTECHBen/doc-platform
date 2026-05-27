import { eq } from 'drizzle-orm';
import { schema, type Database } from '@platform/db';

// Anonymous PWA scan traffic doesn't carry a real user identity — the
// caller authenticated via the QR scan cookie, not OIDC. But ai_conversations
// and ai_messages reference users.id with NOT NULL, so we mint one sentinel
// "PWA Anonymous" user per organization and attribute all scan-session AI
// activity to it. Multiple techs scanning the same QR in a shift share this
// row; per-conversation identity lives in the conversationId stored in the
// PWA's localStorage. The sentinel email is deterministic so concurrent
// first-chats from the same org race on the unique constraint, not on
// duplicate rows.
const ANON_EMAIL_PREFIX = 'pwa-anonymous+';
const ANON_EMAIL_SUFFIX = '@anon.equipmenthub.local';
const ANON_DISPLAY_NAME = 'PWA Anonymous (Scan Session)';

export async function getOrCreateAnonymousPwaUserId(
  db: Database,
  organizationId: string,
): Promise<string> {
  const email = `${ANON_EMAIL_PREFIX}${organizationId}${ANON_EMAIL_SUFFIX}`;
  const existing = await db.query.users.findFirst({
    where: eq(schema.users.email, email),
    columns: { id: true },
  });
  if (existing) return existing.id;
  // onConflictDoNothing handles the race where two concurrent scans both
  // miss the SELECT above and try to INSERT — the loser silently no-ops,
  // and the follow-up SELECT returns the winner's row.
  await db
    .insert(schema.users)
    .values({
      homeOrganizationId: organizationId,
      email,
      displayName: ANON_DISPLAY_NAME,
      platformAdmin: false,
    })
    .onConflictDoNothing({ target: schema.users.email });
  const after = await db.query.users.findFirst({
    where: eq(schema.users.email, email),
    columns: { id: true },
  });
  if (!after) {
    throw new Error(
      `failed to mint anonymous PWA user for org ${organizationId}`,
    );
  }
  return after.id;
}
