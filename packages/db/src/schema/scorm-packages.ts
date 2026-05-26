// SCORM package metadata.
//
// A SCORM package is a zip published by Storyline, Captivate, Lectora,
// or any tool that targets SCORM 1.2 / 2004. On upload we extract every
// file into object storage under a per-package key prefix and parse the
// imsmanifest.xml to find the entry-point HTML and the SCORM version.
// The PWA player iframes that entry point through a same-origin proxy
// so the in-frame SCORM API stub on the parent stays reachable.

import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
  unique,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { documents } from './content';

export const scormPackages = pgTable(
  'scorm_packages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    // Storage-key prefix shared by every extracted file. Example:
    // 'org/<orgId>/scorm/<packageId>/'. The entry path below is
    // appended to this for the iframe src; relative URLs inside the
    // package resolve correctly because the iframe's base URL stays
    // within the prefix.
    storageKeyPrefix: text('storage_key_prefix').notNull(),
    // Relative path of the launch file inside the package, e.g.
    // 'story.html' or 'index_lms.html'. Pulled from
    // imsmanifest.xml.resources.resource[@identifier].href.
    entryPath: text('entry_path').notNull(),
    // '1.2' or '2004 3rd Edition' / '2004 4th Edition' / 'CAM 1.3'.
    // Free-form because the manifest's schemaversion field is.
    scormVersion: text('scorm_version'),
    // Title from the manifest (informational; the document.title is
    // the authoritative learner-visible name).
    manifestTitle: text('manifest_title'),
    // Map of relative path within the package → storage key. Populated
    // on upload by iterating the zip and putBuffer'ing each entry. The
    // serve route reads this to translate the URL path back to a key.
    // Storyline packages average 50–200 files; the JSON stays well
    // under a kilobyte even at the high end.
    filesIndex: jsonb('files_index')
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqDocument: unique('scorm_packages_document_id_key').on(t.documentId),
    documentIdx: index('scorm_packages_document_idx').on(t.documentId),
  }),
);

export const scormPackagesRelations = relations(scormPackages, ({ one }) => ({
  document: one(documents, {
    fields: [scormPackages.documentId],
    references: [documents.id],
  }),
}));

export type ScormPackage = typeof scormPackages.$inferSelect;
export type NewScormPackage = typeof scormPackages.$inferInsert;
