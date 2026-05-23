// Drafter executor — turns an approved DraftProposalTree into real
// procedure_steps + media + audio rows. Idempotent per (executionId,
// clientToken). Designed to be invoked from the API admin-procedure-drafts
// route in a fire-and-forget pattern (caller writes progress through the
// existing agent SSE bus).
//
// Responsibilities per step:
//   1. Fetch Mux thumbnail at proposed timestamp → upload via storage.putBuffer
//   2. Synthesize OpenAI TTS-1-HD from voiceoverText → upload via storage.putBuffer
//   3. Insert procedure_steps row with media[] + audio_storage_key set
//   4. Mark the ledger row succeeded; if a previously-succeeded row already
//      exists with the same client_token, surface skipped_existing instead.
//
// Concurrency: capped at 3 (one Mux thumbnail download + one TTS call per
// step in flight). Anything higher hammered the per-org rate limits in
// internal tests.

import { eq } from 'drizzle-orm';
import { schema, type Database } from '@platform/db';
import {
  buildDraftClientToken,
  type DraftProposalTree,
  type DraftStepProposal,
} from './schema.js';

export interface DrafterExecutorContext {
  db: Database;
  /** Synthesize TTS audio from text. Returns { storageKey, sizeBytes,
   *  contentType, durationMs }. Injected so the ai package stays free of
   *  the API's storage + OpenAI coupling. */
  synthesizeTts: (text: string) => Promise<{
    storageKey: string;
    sizeBytes: number;
    contentType: string;
    durationMs: number;
  }>;
  /** Download a JPEG thumbnail from Mux at a specific timestamp; upload
   *  it to storage; return the storage key for media[]. */
  fetchKeyframe: (
    playbackId: string,
    timestampMs: number,
  ) => Promise<{ storageKey: string; mime: string; sizeBytes: number }>;
  /** Called once per step with a per-step status update. The API wires
   *  this to the SSE bus so the reviewer page can show live progress. */
  onProgress?: (event: {
    clientId: string;
    phase: 'starting' | 'keyframe' | 'tts' | 'inserting' | 'done' | 'failed';
    error?: string;
  }) => void;
  /** Abort signal so the API can cancel an executing draft. */
  signal?: AbortSignal;
  /** Concurrency cap. Default 3. Lower for ratelimited environments. */
  concurrency?: number;
}

export interface ExecuteDrafterParams {
  ctx: DrafterExecutorContext;
  runId: string;
  proposalId: string;
  proposal: DraftProposalTree;
  /** The execution row already created by the route handler. */
  executionId: string;
  /** Author user id — recorded as createdByUserId on the materialized steps. */
  actorUserId: string;
  /** Target document for the new steps. Created earlier in the route
   *  handler (often the same call that started this execute). */
  targetDocumentId: string;
}

export interface ExecuteDrafterResult {
  createdStepIds: string[];
  skipped: string[];
  failed: Array<{ clientId: string; error: string }>;
}

export async function executeDrafter(
  params: ExecuteDrafterParams,
): Promise<ExecuteDrafterResult> {
  const { ctx, runId: _runId, proposalId, proposal, executionId, actorUserId, targetDocumentId } =
    params;
  const concurrency = ctx.concurrency ?? 3;

  // Pre-load existing ledger rows for this execution so retries / parallel
  // workers don't double-process. Maps clientToken → existing row.
  const existing = await ctx.db.query.procedureDraftExecutionSteps.findMany({
    where: eq(schema.procedureDraftExecutionSteps.executionId, executionId),
  });
  const ledgerByToken = new Map(existing.map((r) => [r.clientToken, r]));

  const createdStepIds: string[] = [];
  const skipped: string[] = [];
  const failed: Array<{ clientId: string; error: string }> = [];

  // Compute target ordering hints so the inserted steps preserve the LLM's
  // intended order. 100-stride per the existing convention.
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

    async function runStep(step: DraftStepProposal, orderingHint: number) {
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

        // 1. Keyframe.
        ctx.onProgress?.({ clientId: step.clientId, phase: 'keyframe' });
        // playbackId comes from the run row — fetched once outside the
        // loop and threaded through `fetchKeyframe` by the caller's
        // closure. We don't know the playbackId here; ctx.fetchKeyframe
        // is bound to it.
        const keyframe = await ctx.fetchKeyframe(
          // The executor doesn't know the playbackId; the caller binds it
          // into fetchKeyframe via closure. So we pass an empty string;
          // contract is that fetchKeyframe ignores playbackId entirely.
          // Documented in the route handler.
          '',
          step.keyframeTimestampMs,
        );

        // 2. TTS.
        ctx.onProgress?.({ clientId: step.clientId, phase: 'tts' });
        const audio = await ctx.synthesizeTts(step.voiceoverText);

        // 3. Insert procedure_steps row + finalize ledger atomically.
        ctx.onProgress?.({ clientId: step.clientId, phase: 'inserting' });
        const insertedStepId = await ctx.db.transaction(async (tx) => {
          // photo_required steps need requiresPhoto + minPhotoCount; LLM
          // schema enforces this, but we coerce here as belt-and-suspenders.
          const minPhotoCount =
            step.kind === 'photo_required'
              ? Math.max(1, step.minPhotoCount)
              : step.minPhotoCount;
          const requiresPhoto =
            step.kind === 'photo_required' ? true : step.requiresPhoto;
          const measurementSpec =
            step.kind === 'measurement_required' ? step.measurementSpec ?? null : null;

          const [row] = await tx
            .insert(schema.procedureSteps)
            .values({
              documentId: targetDocumentId,
              kind: step.kind,
              title: step.title,
              blocks: step.blocks,
              safetyCritical: step.safetyCritical || step.kind === 'safety_check',
              orderingHint,
              requiresPhoto,
              minPhotoCount,
              measurementSpec,
              media: [
                {
                  kind: 'image' as const,
                  storageKey: keyframe.storageKey,
                  mime: keyframe.mime,
                  caption: undefined,
                },
              ],
              audioStorageKey: audio.storageKey,
              audioContentType: audio.contentType,
              audioSizeBytes: audio.sizeBytes,
              audioDurationMs: audio.durationMs,
              audioSource: 'generated' as const,
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
            .set({
              status: 'failed',
              error: message,
              finishedAt: new Date(),
            })
            .where(eq(schema.procedureDraftExecutionSteps.id, ledgerId));
        }
        ctx.onProgress?.({ clientId: step.clientId, phase: 'failed', error: message });
      }
    }

    startNext();
  });

  return { createdStepIds, skipped, failed };
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
