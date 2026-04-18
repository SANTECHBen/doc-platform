import { eq, inArray } from 'drizzle-orm';
import { createDb } from './client';
import * as schema from './schema';

// Run after `pnpm db:seed`. This script:
//   1. Ensures a dev user exists at the end-customer org (for the x-dev-user header).
//   2. Splits every document's markdown body into chunks and inserts them into
//      document_chunks. Embedding is left NULL (we're using Postgres FTS for now).
//   3. Prints the dev user + org IDs and the QR URL so you can wire the PWA
//      env with dev identity.

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const db = createDb(url);

// Find the first end_customer org — that's where technicians live in our seed.
const [endCustomer] = await db
  .select()
  .from(schema.organizations)
  .where(eq(schema.organizations.type, 'end_customer'))
  .limit(1);
if (!endCustomer) {
  console.error('No end_customer organization found. Run `pnpm db:seed` first.');
  process.exit(1);
}

// Ensure dev user.
const devEmail = 'dev@doc-platform.local';
let [devUser] = await db
  .select()
  .from(schema.users)
  .where(eq(schema.users.email, devEmail))
  .limit(1);
if (!devUser) {
  const [created] = await db
    .insert(schema.users)
    .values({
      homeOrganizationId: endCustomer.id,
      email: devEmail,
      displayName: 'Dev Technician',
    })
    .returning();
  if (!created) throw new Error('Failed to insert dev user');
  devUser = created;
  await db.insert(schema.memberships).values({
    userId: devUser.id,
    organizationId: endCustomer.id,
    role: 'technician',
  });
  console.log('Created dev user.');
} else {
  console.log('Dev user already exists.');
}

// Chunk every document's markdown body. Idempotent per document via delete+insert.
const docs = await db.select().from(schema.documents);
let totalChunks = 0;
for (const doc of docs) {
  if (!doc.bodyMarkdown) continue;
  await db
    .delete(schema.documentChunks)
    .where(eq(schema.documentChunks.documentId, doc.id));

  const chunks = splitIntoChunks(doc.bodyMarkdown, {
    maxChars: 800,
    minChars: 40,
  });
  if (chunks.length === 0) continue;
  await db.insert(schema.documentChunks).values(
    chunks.map((c, i) => ({
      documentId: doc.id,
      contentPackVersionId: doc.contentPackVersionId,
      chunkIndex: i,
      content: c.content,
      charStart: c.start,
      charEnd: c.end,
    })),
  );
  totalChunks += chunks.length;
}

console.log(`\nChunked ${docs.length} documents into ${totalChunks} chunks.`);
console.log('\nDev identity for the PWA:');
console.log(`  DEV_USER_ID  = ${devUser.id}`);
console.log(`  DEV_ORG_ID   = ${endCustomer.id}`);
console.log('\nAdd these to apps/pwa/.env.local so the chat tab can authenticate:');
console.log(`  NEXT_PUBLIC_DEV_USER_ID=${devUser.id}`);
console.log(`  NEXT_PUBLIC_DEV_ORG_ID=${endCustomer.id}`);

process.exit(0);

/**
 * Paragraph-aware chunker. Splits on blank-line boundaries, accumulates until
 * max size, emits with source offsets preserved for citations.
 */
function splitIntoChunks(
  body: string,
  opts: { maxChars: number; minChars: number },
): Array<{ content: string; start: number; end: number }> {
  const paragraphs: Array<{ text: string; start: number }> = [];
  const re = /(?:^|\n\n)([\s\S]+?)(?=\n\n|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const text = m[1]?.trim();
    if (!text) continue;
    const offset = m.index + (m[0]?.startsWith('\n\n') ? 2 : 0);
    paragraphs.push({ text, start: offset });
  }
  if (paragraphs.length === 0 && body.trim()) {
    paragraphs.push({ text: body.trim(), start: 0 });
  }

  const chunks: Array<{ content: string; start: number; end: number }> = [];
  let buffer = '';
  let bufferStart = 0;
  let bufferEnd = 0;

  for (const p of paragraphs) {
    if (buffer === '') {
      buffer = p.text;
      bufferStart = p.start;
      bufferEnd = p.start + p.text.length;
      continue;
    }
    if (buffer.length + p.text.length + 2 <= opts.maxChars) {
      buffer = buffer + '\n\n' + p.text;
      bufferEnd = p.start + p.text.length;
    } else {
      if (buffer.length >= opts.minChars) {
        chunks.push({ content: buffer, start: bufferStart, end: bufferEnd });
      }
      buffer = p.text;
      bufferStart = p.start;
      bufferEnd = p.start + p.text.length;
    }
  }
  if (buffer && buffer.length >= Math.min(opts.minChars, buffer.length)) {
    chunks.push({ content: buffer, start: bufferStart, end: bufferEnd });
  }
  return chunks;
}
