import { createDb } from './client';
import * as schema from './schema';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL required');
const db = createDb(url);

const packs = await db.select().from(schema.contentPacks);
console.log('content packs:', packs);

const versions = await db.select().from(schema.contentPackVersions);
console.log('versions:', versions);

const docs = await db.select().from(schema.documents);
console.log('documents:', docs.length, docs.map((d) => ({ id: d.id, title: d.title, versionId: d.contentPackVersionId })));

const instances = await db.select().from(schema.assetInstances);
console.log('asset instances:', instances.map((i) => ({ id: i.id, sn: i.serialNumber, pinned: i.pinnedContentPackVersionId })));

process.exit(0);
