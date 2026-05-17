import { eq, inArray } from 'drizzle-orm';
import { schema, type Database } from '@platform/db';

// Build a flat markdown body from a structured_procedure document's
// captured steps + substeps. The chat retriever runs on document_chunks,
// which the AI pipeline produces by chunking documents.bodyMarkdown — but
// field-authored procedures store their content in procedure_steps, not in
// the documents row. Without this synthesis the doc has no chunks and is
// invisible to chat ("no procedure for X" even though the tech literally
// just authored one).
//
// Output shape mirrors what a hand-written procedure markdown would look
// like, so retrieval scoring is comparable across both authoring paths.
export async function synthesizeProcedureMarkdown(
  db: Database,
  documentId: string,
  fallbackTitle: string,
): Promise<string> {
  const [steps, sections] = await Promise.all([
    db.query.procedureSteps.findMany({
      where: eq(schema.procedureSteps.documentId, documentId),
      orderBy: (t, { asc }) => [asc(t.orderingHint)],
    }),
    db.query.procedureSections.findMany({
      where: eq(schema.procedureSections.documentId, documentId),
      orderBy: (t, { asc }) => [asc(t.orderingHint)],
    }),
  ]);
  if (steps.length === 0) return '';

  const stepIds = steps.map((s) => s.id);
  const substeps = await db.query.procedureSubsteps.findMany({
    where: inArray(schema.procedureSubsteps.procedureStepId, stepIds),
    orderBy: (t, { asc }) => [asc(t.orderingHint)],
  });
  const subByStep = new Map<string, typeof substeps>();
  for (const ss of substeps) {
    const list = subByStep.get(ss.procedureStepId) ?? [];
    list.push(ss);
    subByStep.set(ss.procedureStepId, list);
  }

  // Group steps by section so "Removal" and "Replacement" land in separate
  // markdown sections — gives the chunker semantic boundaries the retriever
  // can match (a user asking about "removal" should match a Removal-titled
  // chunk, not a generic mid-procedure step).
  const sectionOrderById = new Map<string, number>(
    sections.map((sec) => [sec.id, sec.orderingHint]),
  );
  const sectionTitleById = new Map<string, string>(
    sections.map((sec) => [sec.id, sec.title]),
  );
  const sortedSteps = [...steps].sort((a, b) => {
    const sa =
      a.sectionId == null ? -1 : sectionOrderById.get(a.sectionId) ?? Infinity;
    const sb =
      b.sectionId == null ? -1 : sectionOrderById.get(b.sectionId) ?? Infinity;
    if (sa !== sb) return sa - sb;
    return a.orderingHint - b.orderingHint;
  });

  const lines: string[] = [
    `# ${fallbackTitle}`,
    '',
    `Field-authored procedure — ${sortedSteps.length} step${sortedSteps.length === 1 ? '' : 's'}${
      sections.length > 0 ? ` across ${sections.length} section${sections.length === 1 ? '' : 's'}` : ''
    }.`,
    '',
  ];

  // Track which section we're rendering so we can emit an H2 heading on
  // each section change, and restart the per-section step counter.
  let currentSectionId: string | null | undefined = undefined;
  let perSectionIdx = 0;

  sortedSteps.forEach((s, i) => {
    if (s.sectionId !== currentSectionId) {
      currentSectionId = s.sectionId;
      perSectionIdx = 0;
      const title = s.sectionId == null
        ? null
        : sectionTitleById.get(s.sectionId) ?? null;
      if (title) {
        lines.push(`## ${title}`, '');
      }
    }
    perSectionIdx += 1;
    const stepNumber = String(perSectionIdx).padStart(2, '0');
    const safety = s.safetyCritical ? ' (safety-critical)' : '';
    // Use H3 for steps when there are section H2s; otherwise H2 (keeps
    // ungrouped procedures rendering as before).
    const stepHeading = sections.length > 0 ? '###' : '##';
    lines.push(`${stepHeading} Step ${stepNumber} — ${s.title}${safety}`, '');

    // Always emit at least one paragraph so chunkMarkdown has a non-heading
    // block to consume. A step with only a title (no body, no flags, no
    // substeps) would otherwise produce a heading-only doc, which the
    // chunker correctly drops as zero chunks. Restating the title as a
    // sentence makes "belt removal" findable when the technician asks
    // "how do I remove the belt?".
    const flags: string[] = [];
    if (s.safetyCritical) flags.push('safety-critical');
    if (s.requiresPhoto) flags.push(`photo evidence required (min ${s.minPhotoCount})`);
    if (s.measurementSpec) {
      const m = s.measurementSpec as { kind: string; label?: string; unit?: string };
      const label = m.label ?? 'measurement';
      const unit = m.unit ? ` (${m.unit})` : '';
      flags.push(`measurement: ${label}${unit}, kind=${m.kind}`);
    }
    // Summary line stays globally-numbered ("step 7 of 23") because the
    // retriever scores against verbatim phrases like "step 7" — preserving
    // a doc-wide ordinal keeps that match working even when the doc has
    // sections. The H3 heading above already shows the per-section number.
    const summary = `Step ${i + 1} of ${sortedSteps.length}: ${s.title}.`;
    const flagsClause = flags.length > 0 ? ` Flags: ${flags.join('; ')}.` : '';
    lines.push(`${summary}${flagsClause}`, '');

    if (s.bodyMarkdown && s.bodyMarkdown.trim().length > 0) {
      lines.push(s.bodyMarkdown.trim(), '');
    }

    const subs = subByStep.get(s.id) ?? [];
    if (subs.length > 0) {
      subs.forEach((ss, j) => {
        lines.push(`${j + 1}. ${ss.title}`);
        if (ss.bodyMarkdown && ss.bodyMarkdown.trim().length > 0) {
          const indented = ss.bodyMarkdown
            .trim()
            .split('\n')
            .map((l) => `   ${l}`)
            .join('\n');
          lines.push(indented);
        }
      });
      lines.push('');
    }
  });
  return lines.join('\n').trim();
}
