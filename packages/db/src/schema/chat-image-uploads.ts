import { pgTable, uuid, text, timestamp, index } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { organizations } from './organizations';
import { users } from './users';

// Tracks short-lived attribution of chat-image uploads to a specific user
// and org. The /ai/chat endpoint requires that any `imageStorageKey` it
// receives correspond to a row in this table owned by the calling user
// and not yet expired. Without this, any authenticated caller could pass
// an arbitrary storage key (e.g. a guessed/leaked key from another tenant)
// and have Claude vision return a natural-language description of the
// bytes — a clean cross-tenant image read.
//
// Lifecycle:
//   - POST /ai/chat-images/upload uploads + inserts a row with TTL ~24h.
//   - POST /ai/chat marks the row consumed and proceeds with vision.
//   - A background sweep deletes consumed/expired rows + the S3 object.
export const chatImageUploads = pgTable(
  'chat_image_uploads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storageKey: text('storage_key').notNull().unique(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    contentType: text('content_type').notNull(),
    sizeBytes: text('size_bytes').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
  },
  (t) => ({
    userIdx: index('chat_image_uploads_user_idx').on(t.userId),
    orgIdx: index('chat_image_uploads_org_idx').on(t.organizationId),
    expiresIdx: index('chat_image_uploads_expires_idx').on(t.expiresAt),
  }),
);

export const chatImageUploadsRelations = relations(chatImageUploads, ({ one }) => ({
  user: one(users, {
    fields: [chatImageUploads.userId],
    references: [users.id],
  }),
  organization: one(organizations, {
    fields: [chatImageUploads.organizationId],
    references: [organizations.id],
  }),
}));

export type ChatImageUpload = typeof chatImageUploads.$inferSelect;
export type NewChatImageUpload = typeof chatImageUploads.$inferInsert;
