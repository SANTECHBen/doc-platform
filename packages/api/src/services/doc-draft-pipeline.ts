// Orchestration glue for the document-import drafter (sourceKind 'docx'|'pdf').
//
// Sibling of draft-pipeline.ts (the video path). Where the video pipeline is
// driven by Mux webhooks, this one is driven by the admin flow:
//   1. startDocExtraction  — parse the uploaded doc into markdown + figures,
//      upload figures to storage, persist the manifest, await section pick.
//   2. startDocDrafterLoop — slice the markdown to the chosen sections, run
//      the LLM, persist the proposal, await review.
//   3. runDocDrafterExecution — materialize sections + steps + media + audio.
//
// Reuses the same procedure_draft_* tables, the same proposal upsert, the same
// SSE bus channels ('propose' / 'execute'), and the same TTS binding as the
// video path. No Mux anywhere.

import { randomUUID } from 'node:crypto';
import { createWriteStream, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  extractWithFigures,
  runDocDrafterLoop,
  executeDocDrafter,
  type DraftDocFigure,
  type DraftDocProposalTree,
} from '@platform/ai';
import { schema, type DraftFigure } from '@platform/db';
import { agentBus, runChannel } from '../lib/agent-bus.js';
import { synthesizeStepTts } from './step-tts.js';

const MIME_BY_KIND: Record<'docx' | 'pdf', string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
};

// ---------------------------------------------------------------------------
// 1. Extraction — parse the uploaded document into markdown + figures.
// ---------------------------------------------------------------------------

export async function startDocExtraction(
  app: FastifyInstance,
  runId: string,
): Promise<void> {
  const { db, storage, env } = app.ctx;
  const run = await db.query.procedureDraftRuns.findFirst({
    where: eq(schema.procedureDraftRuns.id, runId),
  });
  if (!run) return;
  if (run.sourceKind !== 'docx' && run.sourceKind !== 'pdf') return;
  if (!run.sourceStorageKey) {
    await failRun(app, runId, 'no source file on the draft run');
    return;
  }
  if (run.status !== 'extracting') {
    await db
      .update(schema.procedureDraftRuns)
      .set({ status: 'extracting', updatedAt: new Date() })
      .where(eq(schema.procedureDraftRuns.id, runId));
  }
  agentBus.publish(runChannel(runId, 'propose'), 'extracting', {});

  // Download the source to a temp file — the docx/pdf extractors need a path.
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'docdraft-'));
  const tmpPath = path.join(tmpDir, `source.${run.sourceKind}`);
  try {
    const streamed = await storage.stream(run.sourceStorageKey);
    if (!streamed) throw new Error(`source not found in storage: ${run.sourceStorageKey}`);
    await pipeline(streamed.stream, createWriteStream(tmpPath));

    // sourceUrl lets LlamaParse pull the PDF directly in prod (S3 public
    // base). In dev (FS storage) leave it null so the extractor uploads the
    // temp file instead — a /files URL isn't reachable by LlamaParse.
    const sourceUrl = env.S3_PUBLIC_URL
      ? storage.publicUrl(run.sourceStorageKey)
      : null;

    const extraction = await extractWithFigures({
      filePath: tmpPath,
      sourceUrl,
      contentType: MIME_BY_KIND[run.sourceKind],
      kind: run.sourceKind,
    });

    // Upload each figure's bytes; build the persisted manifest (storage keys).
    const manifest: DraftFigure[] = [];
    for (const fig of extraction.figures) {
      const stored = await storage.putBuffer({
        buffer: fig.bytes,
        filename: `draft-${runId}-${fig.figureId}.${fig.mime === 'image/png' ? 'png' : 'jpg'}`,
        contentType: fig.mime,
        ownerOrganizationId: run.ownerOrganizationId,
      });
      manifest.push({
        figureId: fig.figureId,
        order: fig.order,
        storageKey: stored.storageKey,
        mime: fig.mime,
        width: fig.width,
        height: fig.height,
        ...(fig.caption ? { caption: fig.caption } : {}),
      });
    }

    await db
      .update(schema.procedureDraftRuns)
      .set({
        sourceMarkdown: extraction.markdown,
        figuresManifest: manifest,
        status: 'awaiting_section_pick',
        error: null,
        updatedAt: new Date(),
      })
      .where(eq(schema.procedureDraftRuns.id, runId));
    agentBus.publish(runChannel(runId, 'propose'), 'awaiting_section_pick', {
      figureCount: manifest.length,
      sectionCount: deriveOutline(extraction.markdown).length,
    });
  } catch (err) {
    await failRun(app, runId, err instanceof Error ? err.message : String(err));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// 2. LLM loop — propose steps for the chosen sections.
// ---------------------------------------------------------------------------

export async function startDocDrafterLoop(
  app: FastifyInstance,
  runId: string,
): Promise<void> {
  const { db } = app.ctx;
  const run = await db.query.procedureDraftRuns.findFirst({
    where: eq(schema.procedureDraftRuns.id, runId),
  });
  if (!run) return;
  if (!run.sourceMarkdown) {
    await failRun(app, runId, 'no extracted markdown to draft from');
    return;
  }

  const selectedSections = run.selectedSectionTitles ?? [];
  const markdown = sliceMarkdownToSections(run.sourceMarkdown, selectedSections);

  // Only offer the LLM figures that actually appear in the sliced markdown.
  const presentIds = new Set(
    [...markdown.matchAll(/\[\[FIGURE:(fig-\d+)\]\]/g)].map((m) => m[1]!),
  );
  const manifest = run.figuresManifest ?? [];
  const figures: DraftDocFigure[] = manifest
    .filter((f) => presentIds.size === 0 || presentIds.has(f.figureId))
    .map((f) => ({
      figureId: f.figureId,
      storageKey: f.storageKey,
      mime: f.mime,
      width: f.width ?? null,
      height: f.height ?? null,
      ...(f.caption ? { caption: f.caption } : {}),
    }));

  await db
    .update(schema.procedureDraftRuns)
    .set({ status: 'proposing', updatedAt: new Date() })
    .where(eq(schema.procedureDraftRuns.id, runId));
  agentBus.publish(runChannel(runId, 'propose'), 'proposing', {});

  try {
    const result = await runDocDrafterLoop({
      markdown,
      selectedSections,
      figures,
      proposedTitle: run.proposedTitle,
      procedureCategory: run.procedureCategory ?? null,
      onStepEmitted: (step) => {
        agentBus.publish(runChannel(runId, 'propose'), 'step_emitted', {
          clientId: step.clientId,
          title: step.title,
          sectionTitle: step.sectionTitle ?? null,
          figureRefs: step.figureRefs,
        });
      },
    });

    if (!result.finalized || result.proposal.steps.length === 0) {
      await failRun(app, runId, result.error ?? 'no steps proposed');
      return;
    }

    await db
      .insert(schema.procedureDraftProposals)
      .values({
        runId,
        version: 1,
        content: result.proposal,
        summary: result.proposal.summary,
        modelUsed: result.modelUsed,
        tokenUsage: result.usage,
      })
      .onConflictDoUpdate({
        target: schema.procedureDraftProposals.runId,
        set: {
          version: 1,
          content: result.proposal,
          summary: result.proposal.summary,
          modelUsed: result.modelUsed,
          tokenUsage: result.usage,
          updatedAt: new Date(),
        },
      });
    await db
      .update(schema.procedureDraftRuns)
      .set({ status: 'awaiting_review', updatedAt: new Date() })
      .where(eq(schema.procedureDraftRuns.id, runId));
    agentBus.publish(runChannel(runId, 'propose'), 'awaiting_review', {
      stepCount: result.proposal.steps.length,
      tokenUsage: result.usage,
    });
  } catch (err) {
    await failRun(app, runId, err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// 3. Executor — materialize sections + steps + figures + audio.
// ---------------------------------------------------------------------------

export async function runDocDrafterExecution(params: {
  app: FastifyInstance;
  runId: string;
  proposalId: string;
  executionId: string;
  actorUserId: string;
  targetDocumentId: string;
  proposal: DraftDocProposalTree;
  signal?: AbortSignal;
}): Promise<void> {
  const { app, runId, proposalId, executionId, actorUserId, targetDocumentId, proposal, signal } =
    params;
  const { db, storage, env } = app.ctx;

  const run = await db.query.procedureDraftRuns.findFirst({
    where: eq(schema.procedureDraftRuns.id, runId),
  });
  if (!run) throw new Error('draft run not found');

  const synthesizeTts = async (text: string) => {
    const hasElevenLabs = !!(env.ELEVENLABS_API_KEY && env.ELEVENLABS_VOICE_ID);
    const hasOpenAi = !!env.OPENAI_API_KEY;
    if (!hasElevenLabs && !hasOpenAi) {
      throw new Error(
        'Draft TTS requires ELEVENLABS_API_KEY + ELEVENLABS_VOICE_ID (preferred) or OPENAI_API_KEY.',
      );
    }
    return synthesizeStepTts({
      text,
      storage,
      filenameStem: `docdraft-${runId}-tts`,
      ownerOrganizationId: run.ownerOrganizationId,
      elevenlabs: hasElevenLabs
        ? {
            apiKey: env.ELEVENLABS_API_KEY!,
            voiceId: env.ELEVENLABS_VOICE_ID!,
            modelId: env.ELEVENLABS_TTS_MODEL_ID,
          }
        : undefined,
      openai: hasOpenAi
        ? {
            apiKey: env.OPENAI_API_KEY!,
            voice: env.OPENAI_TTS_VOICE ?? 'alloy',
            model: env.OPENAI_TTS_MODEL,
          }
        : undefined,
    });
  };

  await db
    .update(schema.procedureDraftRuns)
    .set({ status: 'executing', updatedAt: new Date() })
    .where(eq(schema.procedureDraftRuns.id, runId));
  agentBus.publish(runChannel(runId, 'execute'), 'executing', {});

  const result = await executeDocDrafter({
    ctx: {
      db,
      synthesizeTts,
      onProgress: (event) => {
        agentBus.publish(runChannel(runId, 'execute'), event.phase, {
          clientId: event.clientId,
          error: event.error,
        });
      },
      signal,
      concurrency: 3,
    },
    runId,
    proposalId,
    proposal,
    executionId,
    actorUserId,
    targetDocumentId,
  });

  const completionStatus =
    result.failed.length === 0
      ? 'completed'
      : result.createdStepIds.length > 0
        ? 'completed'
        : 'failed';

  await db.transaction(async (tx) => {
    await tx
      .update(schema.procedureDraftRuns)
      .set({ status: completionStatus, targetDocumentId, updatedAt: new Date() })
      .where(eq(schema.procedureDraftRuns.id, runId));
    await tx
      .update(schema.procedureDraftExecutions)
      .set({
        status: result.failed.length === 0 ? 'succeeded' : 'partial',
        finishedAt: new Date(),
      })
      .where(eq(schema.procedureDraftExecutions.id, executionId));
  });

  agentBus.publish(runChannel(runId, 'execute'), 'completed', {
    createdStepIds: result.createdStepIds,
    createdSectionIds: result.createdSectionIds,
    skipped: result.skipped,
    failed: result.failed,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export interface DocOutlineEntry {
  title: string;
  level: number;
}

/** Derive a section outline from extracted markdown headings. Used by the
 *  admin section-picker UI to list candidate procedures. */
export function deriveOutline(markdown: string): DocOutlineEntry[] {
  const out: DocOutlineEntry[] = [];
  const seen = new Set<string>();
  for (const line of markdown.split('\n')) {
    const m = line.match(/^(#{1,4})\s+(.+?)\s*$/);
    if (!m) continue;
    const level = m[1]!.length;
    const title = m[2]!.replace(/\[\[FIGURE:fig-\d+\]\]/g, '').trim();
    if (!title) continue;
    const key = `${level}:${title.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ title, level });
  }
  return out;
}

/** Slice markdown down to the chosen section headings (plus their content,
 *  up to the next heading of the same or higher level). Returns the full
 *  markdown when no titles are selected or none match — better to over-include
 *  than hand the LLM an empty document. */
export function sliceMarkdownToSections(
  markdown: string,
  selectedTitles: string[],
): string {
  if (selectedTitles.length === 0) return markdown;
  const wanted = new Set(selectedTitles.map((t) => t.trim().toLowerCase()));
  const lines = markdown.split('\n');
  const kept: string[] = [];
  let capturing = false;
  let captureLevel = 0;
  for (const line of lines) {
    const m = line.match(/^(#{1,4})\s+(.+?)\s*$/);
    if (m) {
      const level = m[1]!.length;
      const title = m[2]!.replace(/\[\[FIGURE:fig-\d+\]\]/g, '').trim().toLowerCase();
      if (capturing && level <= captureLevel) {
        // A heading at the same or higher level ends the current capture.
        capturing = false;
      }
      if (wanted.has(title)) {
        capturing = true;
        captureLevel = level;
      }
    }
    if (capturing) kept.push(line);
  }
  const sliced = kept.join('\n').trim();
  return sliced.length > 0 ? sliced : markdown;
}

async function failRun(
  app: FastifyInstance,
  runId: string,
  message: string,
): Promise<void> {
  await app.ctx.db
    .update(schema.procedureDraftRuns)
    .set({ status: 'failed', error: message, updatedAt: new Date() })
    .where(eq(schema.procedureDraftRuns.id, runId));
  agentBus.publish(runChannel(runId, 'propose'), 'failed', { error: message });
}
