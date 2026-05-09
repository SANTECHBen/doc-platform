import postgres from 'postgres';
const sql = postgres(process.env.DATABASE_URL, { ssl: 'require' });
const partId = '289dfec6-9b8a-448d-8339-ec9bc9aa9c3c';
const instanceId = '23b607ee-1071-4141-bd84-4e6979a1ce28';

const inst = await sql`SELECT id, pinned_content_pack_version_id FROM asset_instances WHERE id = ${instanceId}`;
console.log('instance:', inst[0]);
const pinned = inst[0]?.pinned_content_pack_version_id;

const partDocs = await sql`SELECT pd.id, pd.document_id, d.title, d.content_pack_version_id FROM part_documents pd JOIN documents d ON d.id = pd.document_id WHERE pd.part_id = ${partId}`;
console.log('part_documents (legacy doc-level links):', partDocs);

const sections = await sql`SELECT s.id, s.title, s.kind, s.document_id, s.needs_revalidation FROM document_sections s WHERE s.document_id = ANY(${partDocs.map(d => d.document_id)})`;
console.log('sections on those docs:', sections);

const sectionLinks = await sql`SELECT pds.id, pds.part_id, pds.document_section_id FROM part_document_sections pds WHERE pds.part_id = ${partId}`;
console.log('part_document_sections (new section-level links):', sectionLinks);

await sql.end();
