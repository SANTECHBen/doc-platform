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
  const steps = await db.query.procedureSteps.findMany({
    where: eq(schema.procedureSteps.documentId, documentId),
    orderBy: (t, { asc }) => [asc(t.orderingHint)],
  });
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

  const lines: string[] = [`# ${fallbackTitle}`, ''];
  steps.forEach((s, i) => {
    const stepNumber = String(i + 1).padStart(2, '0');
    const safety = s.safetyCritical ? ' (safety-critical)' : '';
    lines.push(`## Step ${stepNumber} — ${s.title}${safety}`);
    if (s.bodyMarkdown && s.bodyMarkdown.trim().length > 0) {
      lines.push('', s.bodyMarkdown.trim());
    }
    if (s.requiresPhoto) {
      lines.push('', `_Photo evidence required (min ${s.minPhotoCount})._`);
    }
    if (s.measurementSpec) {
      const m = s.measurementSpec as { kind: string; label?: string; unit?: string };
      const label = m.label ?? 'measurement';
      const unit = m.unit ? ` (${m.unit})` : '';
      lines.push('', `_Measurement: ${label}${unit}, kind=${m.kind}._`);
    }
    const subs = subByStep.get(s.id) ?? [];
    if (subs.length > 0) {
      lines.push('');
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
    }
    lines.push('');
  });
  return lines.join('\n').trim();
}
