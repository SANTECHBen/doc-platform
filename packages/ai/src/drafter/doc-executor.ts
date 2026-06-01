// Document-import drafter executor — turns an approved DraftDocProposalTree
// into real procedure_sections + procedure_steps + media + audio rows.
// Idempotent per (executionId, clientToken), reusing the same ledger the
// video executor uses.
//
// Differences from executor.ts (the video path):
//   - Creates procedure_sections from the distinct step.sectionTitle values
//     (first-appearance order), idempotently keyed by (documentId, title).
//   - No Mux/keyframe. Figures are already uploaded at extract time; each
//     figureRef becomes an image media entry + a photo_inline block that
//     points at the same storage key.
//   - Still synthesizes TTS per step from voiceoverText.

import { and, eq } from 'drizzle-orm';
import { schema, type Database } from '@platform/db';
import type { StepBlock, ProcedureStepMedia } from '@platform/db';
import {
  buildDraftClientToken,
  type DraftDocFigure,
  type DraftDocProposalTree,
  type DraftDocStepProposal,
} from './schema.js';

export interface DocDrafterExecutorContext {
  db: Database;
  /** Optional TTS synthesis. When omitted, steps are materialized WITHOUT
   *  audio and the author generates voiceover per step in the Step Editor
   *  (the default for the doc importer — matches authoring from scratch and
   *  avoids paying TTS on steps the author may rewrite). When provided, each
   *  step is voiced at execute time. */
  synthesizeTts?: (text: string) => Promise<{
    storageKey: string;
    sizeBytes: number;
    contentType: string;
    durationMs: number;
  }>;
  /** Per-step progress for the SSE bus. */
  onProgress?: (event: {
    clientId: string;
    phase: 'starting' | 'sections' | 'tts' | 'inserting' | 'done' | 'failed';
    error?: string;
  }) => void;
  signal?: AbortSignal;
  /** Concurrency cap for the per-step TTS + insert work. Default 3. */
  concurrency?: number;
}

export interface ExecuteDocDrafterParams {
  ctx: DocDrafterExecutorContext;
  runId: string;
  proposalId: string;
  proposal: DraftDocProposalTree;
  executionId: string;
  actorUserId: string;
  targetDocumentId: string;
}

export interface ExecuteDocDrafterResult {
  createdStepIds: string[];
  createdSectionIds: string[];
  skipped: string[];
  failed: Array<{ clientId: string; error: string }>;
}

export async function executeDocDrafter(
  params: ExecuteDocDrafterParams,
): Promise<ExecuteDocDrafterResult> {
  const {
    ctx,
    proposalId,
    proposal,
    executionId,
    actorUserId,
    targetDocumentId,
  } = params;
  const concurrency = ctx.concurrency ?? 3;

  // 1. Materialize sections first (sequential, fast) so every step can be
  //    assigned its sectionId before the concurrent step loop. Idempotent:
  //    reuse an existing same-title section on the target document.
  ctx.onProgress?.({ clientId: '', phase: 'sections' });
  const sectionIdByTitle = await ensureSections(
    ctx.db,
    targetDocumentId,
    proposal.steps,
    actorUserId,
  );
  const createdSectionIds = [...new Set(sectionIdByTitle.values())];

  // Figure lookup for media/photo_inline wiring.
  const figById = new Map<string, DraftDocFigure>(
    proposal.figures.map((f) => [f.figureId, f]),
  );

  // 2. Pre-load ledger rows for idempotency.
  const existing = await ctx.db.query.procedureDraftExecutionSteps.findMany({
    where: eq(schema.procedureDraftExecutionSteps.executionId, executionId),
  });
  const ledgerByToken = new Map(existing.map((r) => [r.clientToken, r]));

  const createdStepIds: string[] = [];
  const skipped: string[] = [];
  const failed: Array<{ clientId: string; error: string }> = [];

  let nextOrdering = 100;
  const queue = [...proposal.steps];
  let activeCount = 0;
  let cursor = 0;

  await new Promise<void>((resolve) => {
    const startNext = () => {
      if (ctx.signal?.aborted) return resolve();
      while (activeCount < concurrency && cursor < queue.length) {
        const step = queue[cursor++]!;
        activeCount++;
        const orderingHint = nextOrdering;
        nextOrdering += 100;
        void runStep(step, orderingHint).finally(() => {
          activeCount--;
          if (cursor >= queue.length && activeCount === 0) resolve();
          else startNext();
        });
      }
      if (queue.length === 0) resolve();
    };

    async function runStep(step: DraftDocStepProposal, orderingHint: number) {
      const clientToken = buildDraftClientToken(proposalId, step.clientId);
      const prior = ledgerByToken.get(clientToken);
      if (prior?.status === 'succeeded' || prior?.status === 'skipped_existing') {
        skipped.push(step.clientId);
        if (prior.targetProcedureStepId) {
          createdStepIds.push(prior.targetProcedureStepId);
        }
        return;
      }
      const ledger = prior
        ? null
        : await insertLedgerRow(ctx.db, executionId, clientToken, step.clientId);
      const ledgerId = (prior ?? ledger)?.id;
      try {
        ctx.onProgress?.({ clientId: step.clientId, phase: 'starting' });

        // Voiceover: only synthesize when a TTS impl is injected. The doc
        // importer leaves this off so the author generates audio in the
        // editor (the AI's spoken text survives in the title + paragraph
        // blocks, which the editor's voiceover panel reads).
        let audio:
          | { storageKey: string; sizeBytes: number; contentType: string; durationMs: number }
          | null = null;
        if (ctx.synthesizeTts) {
          ctx.onProgress?.({ clientId: step.clientId, phase: 'tts' });
          audio = await ctx.synthesizeTts(step.voiceoverText);
        }

        // Resolve figure refs → media images + photo_inline blocks.
        const { media, photoBlocks } = resolveFigures(step.figureRefs, figById);

        ctx.onProgress?.({ clientId: step.clientId, phase: 'inserting' });
        const insertedStepId = await ctx.db.transaction(async (tx) => {
          const minPhotoCount =
            step.kind === 'photo_required'
              ? Math.max(1, step.minPhotoCount)
              : step.minPhotoCount;
          const requiresPhoto =
            step.kind === 'photo_required' ? true : step.requiresPhoto;
          const measurementSpec =
            step.kind === 'measurement_required'
              ? step.measurementSpec ?? null
              : null;

          // Author blocks first, then the figure photo_inline blocks so the
          // image renders beneath the instruction text.
          const blocks: StepBlock[] = [...step.blocks, ...photoBlocks];
          const sectionId = step.sectionTitle
            ? sectionIdByTitle.get(step.sectionTitle) ?? null
            : null;

          const [row] = await tx
            .insert(schema.procedureSteps)
            .values({
              documentId: targetDocumentId,
              sectionId,
              kind: step.kind,
              title: step.title,
              blocks,
              media,
              safetyCritical:
                step.safetyCritical || step.kind === 'safety_check',
              orderingHint,
              requiresPhoto,
              minPhotoCount,
              measurementSpec,
              audioStorageKey: audio?.storageKey ?? null,
              audioContentType: audio?.contentType ?? null,
              audioSizeBytes: audio?.sizeBytes ?? null,
              audioDurationMs: audio?.durationMs ?? null,
              audioSource: audio ? ('generated' as const) : null,
              proposedByDraftRunId: params.runId,
              createdByUserId: actorUserId,
              searchIndexStaleAt: new Date(),
            })
            .returning({ id: schema.procedureSteps.id });
          if (!row) throw new Error('procedure_steps insert returned nothing');

          if (ledgerId) {
            await tx
              .update(schema.procedureDraftExecutionSteps)
              .set({
                status: 'succeeded',
                targetProcedureStepId: row.id,
                finishedAt: new Date(),
              })
              .where(eq(schema.procedureDraftExecutionSteps.id, ledgerId));
          }
          return row.id;
        });
        createdStepIds.push(insertedStepId);
        ctx.onProgress?.({ clientId: step.clientId, phase: 'done' });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failed.push({ clientId: step.clientId, error: message });
        if (ledgerId) {
          await ctx.db
            .update(schema.procedureDraftExecutionSteps)
            .set({ status: 'failed', error: message, finishedAt: new Date() })
            .where(eq(schema.procedureDraftExecutionSteps.id, ledgerId));
        }
        ctx.onProgress?.({
          clientId: step.clientId,
          phase: 'failed',
          error: message,
        });
      }
    }

    startNext();
  });

  return { createdStepIds, createdSectionIds, skipped, failed };
}

/** Build media entries + photo_inline blocks for a step's figure refs. Both
 *  point at the same already-uploaded storage key — no copy needed (storage
 *  is org-scoped + content-addressed, so the reference resolves for the same
 *  org's procedure steps). */
function resolveFigures(
  figureRefs: string[],
  figById: Map<string, DraftDocFigure>,
): { media: ProcedureStepMedia[]; photoBlocks: StepBlock[] } {
  const media: ProcedureStepMedia[] = [];
  const photoBlocks: StepBlock[] = [];
  const seen = new Set<string>();
  for (const ref of figureRefs) {
    const fig = figById.get(ref);
    if (!fig || seen.has(fig.storageKey)) continue;
    seen.add(fig.storageKey);
    media.push({
      kind: 'image',
      storageKey: fig.storageKey,
      mime: fig.mime,
      ...(fig.caption ? { caption: fig.caption } : {}),
    });
    photoBlocks.push({
      kind: 'photo_inline',
      storageKey: fig.storageKey,
      ...(fig.caption ? { caption: fig.caption } : {}),
    });
  }
  return { media, photoBlocks };
}

/** Create (or reuse) a procedure section per distinct sectionTitle, in
 *  first-appearance order. Returns title → sectionId. Idempotent: a section
 *  with the same (documentId, title) is reused rather than duplicated, so a
 *  re-run of the executor doesn't fan out duplicate sections. */
async function ensureSections(
  db: Database,
  documentId: string,
  steps: DraftDocStepProposal[],
  actorUserId: string,
): Promise<Map<string, string>> {
  // Distinct titles in first-appearance order.
  const titles: string[] = [];
  const seen = new Set<string>();
  for (const s of steps) {
    if (s.sectionTitle && !seen.has(s.sectionTitle)) {
      seen.add(s.sectionTitle);
      titles.push(s.sectionTitle);
    }
  }
  const result = new Map<string, string>();
  if (titles.length === 0) return result;

  // Existing sections on this document (idempotency across re-runs).
  const existing = await db.query.procedureSections.findMany({
    where: eq(schema.procedureSections.documentId, documentId),
  });
  const existingByTitle = new Map(existing.map((s) => [s.title, s.id]));

  let ordering = 100;
  for (const title of titles) {
    const found = existingByTitle.get(title);
    if (found) {
      result.set(title, found);
      ordering += 100;
      continue;
    }
    const [row] = await db
      .insert(schema.procedureSections)
      .values({
        documentId,
        title,
        orderingHint: ordering,
        createdByUserId: actorUserId,
        searchIndexStaleAt: new Date(),
      })
      .returning({ id: schema.procedureSections.id });
    if (!row) throw new Error('procedure_sections insert returned nothing');
    result.set(title, row.id);
    ordering += 100;
  }
  return result;
}

async function insertLedgerRow(
  db: Database,
  executionId: string,
  clientToken: string,
  clientId: string,
) {
  const [row] = await db
    .insert(schema.procedureDraftExecutionSteps)
    .values({
      executionId,
      clientToken,
      stepType: 'procedure_step',
      status: 'in_progress',
      startedAt: new Date(),
      notes: `clientId=${clientId}`,
    })
    .returning();
  return row;
}
