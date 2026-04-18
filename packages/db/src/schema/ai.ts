import { pgTable, uuid, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { users } from './users';
import { assetInstances } from './assets';
import { contentPackVersions } from './content';
import { aiMessageRoleEnum } from './enums';

// An AIConversation is scoped to a single AssetInstance and pinned to a specific
// ContentPackVersion at creation time — all grounding retrieval happens against
// that exact version so responses are reproducible/auditable.
export const aiConversations = pgTable(
  'ai_conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    assetInstanceId: uuid('asset_instance_id')
      .notNull()
      .references(() => assetInstances.id, { onDelete: 'restrict' }),
    contentPackVersionId: uuid('content_pack_version_id')
      .notNull()
      .references(() => contentPackVersions.id, { onDelete: 'restrict' }),
    title: text('title'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (t) => ({
    userIdx: index('ai_conversations_user_idx').on(t.userId),
    assetIdx: index('ai_conversations_asset_idx').on(t.assetInstanceId),
  }),
);

// Citations carry exact provenance:
//   { documentId, contentPackVersionId, quote, charStart, charEnd, page? }
// Every assistant message that makes a claim from content MUST include citations.
export const aiMessages = pgTable(
  'ai_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => aiConversations.id, { onDelete: 'cascade' }),
    role: aiMessageRoleEnum('role').notNull(),
    content: text('content').notNull(),
    citations: jsonb('citations')
      .$type<
        Array<{
          documentId: string;
          contentPackVersionId: string;
          quote: string;
          charStart?: number;
          charEnd?: number;
          page?: number;
        }>
      >()
      .notNull()
      .default([]),
    // Provenance + cost accounting.
    modelId: text('model_id'),
    inputTokens: jsonb('input_tokens').$type<{
      total: number;
      cached?: number;
      cacheWrite?: number;
    }>(),
    outputTokens: jsonb('output_tokens').$type<{ total: number }>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    convIdx: index('ai_messages_conversation_idx').on(t.conversationId),
  }),
);

export const aiConversationsRelations = relations(aiConversations, ({ one, many }) => ({
  user: one(users, { fields: [aiConversations.userId], references: [users.id] }),
  assetInstance: one(assetInstances, {
    fields: [aiConversations.assetInstanceId],
    references: [assetInstances.id],
  }),
  pinnedVersion: one(contentPackVersions, {
    fields: [aiConversations.contentPackVersionId],
    references: [contentPackVersions.id],
  }),
  messages: many(aiMessages),
}));

export type AIConversation = typeof aiConversations.$inferSelect;
export type AIMessage = typeof aiMessages.$inferSelect;
