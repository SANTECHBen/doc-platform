// Orchestration glue for the AI video-walkthrough drafter.
//
// Public surface:
//   onDraftMuxAssetReady(app, runId, asset)
//   onDraftMuxTrackReady(app, runId, track)
//   onDraftMuxErrored(app, runId, message)
//   runDrafterLoop(app, runId)
//   runDrafterExecution(app, runId, proposalId, executionId, actorUserId)
//
// The Mux webhook handler discriminates on the upload's `passthrough` field:
// passthrough='draft:<runId>' routes here; bare ids route to the existing
// onboarding-agent path. The handler doesn't know about drafter internals
// beyond that one dispatch — every cross-cutting concern (transcript
// fetching, storyboard URL, LLM loop, executor) lives in this module.

import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  buildDraftClientToken,
  runDrafterLoop as runLoop,
  executeDrafter,
  type DraftProposalTree,
} from '@platform/ai';
import { schema, type Database } from '@platform/db';
import { agentBus, runChannel } from '../lib/agent-bus.js';
import { synthesizeStepTts } from './step-tts.js';

const DRAFT_PASSTHROUGH_PREFIX = 'draft:';

/** Helper: parse the runId out of an upload passthrough field. Returns
 *  null if the passthrough isn't a draft marker so the caller can route
 *  to the onboarding agent instead. */
export function parseDraftPassthrough(passthrough: string | null | undefined): string | null {
  if (!passthrough) return null;
  if (!passthrough.startsWith(DRAFT_PASSTHROUGH_PREFIX)) return null;
  return passthrough.slice(DRAFT_PASSTHROUGH_PREFIX.length);
}

/** Inverse of parseDraftPassthrough — assembled by routes when minting
 *  the Mux Direct Upload. */
export function makeDraftPassthrough(runId: string): string {
  return `${DRAFT_PASSTHROUGH_PREFIX}${runId}`;
}

// ---------------------------------------------------------------------------
// Webhook handlers — invoked from admin-agent.ts when the Mux webhook
// arrives with a passthrough starting with 'draft:'.
// ---------------------------------------------------------------------------

interface MuxAssetEvent {
  asset_id?: string;
  playback_ids?: Array<{ id: string; policy?: string }>;
  duration?: number;
  static_renditions?: { files?: Array<{ name?: string }> };
}

/** video.upload.asset_created — Mux just created the asset row.
 *  We persist asset id; the playbackId arrives on video.asset.ready. */
export async function onDraftMuxAssetCreated(
  app: FastifyInstance,
  runId: string,
  data: MuxAssetEvent,
): Promise<void> {
  const assetId = data.asset_id;
  if (!assetId) return;
  await app.ctx.db
    .update(schema.procedureDraftRuns)
    .set({
      muxAssetId: assetId,
      status: 'transcribing',
      updatedAt: new Date(),
    })
    .where(eq(schema.procedureDraftRuns.id, runId));
  agentBus.publish(runChannel(runId, 'propose'), 'mux_asset_created', { assetId });
}

/** video.asset.ready — playback is available. We don't start the LLM yet
 *  (we want captions first); on track.ready or after a 5-minute timeout
 *  we fall back to Whisper. */
export async function onDraftMuxAssetReady(
  app: FastifyInstance,
  runId: string,
  data: MuxAssetEvent,
): Promise<void> {
  const playbackId = data.playback_ids?.[0]?.id ?? null;
  const durationMs = data.duration ? Math.round(data.duration * 1000) : null;
  const updates: Record<string, unknown> = {
    muxPlaybackId: playbackId,
    updatedAt: new Date(),
  };
  if (durationMs != null) updates.sourceVideoDurationMs = durationMs;
  // Mux storyboard sprite is accessible at a deterministic URL given the
  // playbackId (Mux serves it as an animated sprite + JPEG; we use the
  // JPEG sprite for the LLM image attachment).
  if (playbackId) {
    updates.storyboardVttUrl = `https://image.mux.com/${playbackId}/storyboard.vtt`;
  }
  await app.ctx.db
    .update(schema.procedureDraftRuns)
    .set(updates)
    .where(eq(schema.procedureDraftRuns.id, runId));
  agentBus.publish(runChannel(runId, 'propose'), 'mux_asset_ready', {
    playbackId,
    durationMs,
  });

  // Kick a 5-minute Whisper-fallback timer. If track.ready arrives first
  // the timer is a no-op (status will have advanced past 'transcribing').
  setTimeout(() => {
    void runWhisperFallbackIfStuck(app, runId).catch((err) => {
      app.log.warn({ err, runId }, 'draft-pipeline: whisper fallback failed');
    });
  }, 5 * 60_000);
}

/** video.asset.track.ready — Mux's auto-generated caption track is
 *  fetchable. We pull the VTT, persist it, and kick the LLM loop. */
export async function onDraftMuxTrackReady(
  app: FastifyInstance,
  runId: string,
  track: { id?: string; type?: string; text_source?: string; status?: string },
): Promise<void> {
  // We only care about auto-generated VOD caption tracks.
  if (track.type !== 'text' || track.text_source !== 'generated_vod') return;
  if (track.status !== 'ready') return;

  const run = await app.ctx.db.query.procedureDraftRuns.findFirst({
    where: eq(schema.procedureDraftRuns.id, runId),
  });
  if (!run || !run.muxPlaybackId) return;
  if (run.status === 'cancelled' || run.status === 'completed' || run.status === 'failed') {
    return;
  }
  // Already have a transcript (Whisper raced ahead) — skip.
  if (run.sourceTranscript && run.transcriptSource) return;

  try {
    const vtt = await fetchMuxCaptionVtt(run.muxPlaybackId, track.id);
    const { plain, withTimestamps } = parseVtt(vtt);
    await app.ctx.db
      .update(schema.procedureDraftRuns)
      .set({
        sourceTranscript: plain,
        sourceCaptionsVtt: vtt,
        transcriptSource: 'mux_captions',
        updatedAt: new Date(),
      })
      .where(eq(schema.procedureDraftRuns.id, runId));
    agentBus.publish(runChannel(runId, 'propose'), 'transcript_ready', {
      source: 'mux_captions',
      lengthChars: plain.length,
    });
    // Persist the with-timestamps text on a separate column? Skip — we
    // can re-derive it from the VTT on demand. runDrafterLoop reads it.
    void runDrafterLoop(app, runId, { transcriptWithTimestamps: withTimestamps }).catch(
      (err) => app.log.error({ err, runId }, 'draft-pipeline: loop failed'),
    );
  } catch (err) {
    app.log.warn({ err, runId }, 'draft-pipeline: mux caption fetch failed');
  }
}

export async function onDraftMuxErrored(
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

// ---------------------------------------------------------------------------
// LLM loop runner
// ---------------------------------------------------------------------------

async function runDrafterLoop(
  app: FastifyInstance,
  runId: string,
  opts?: { transcriptWithTimestamps?: string },
): Promise<void> {
  const run = await app.ctx.db.query.procedureDraftRuns.findFirst({
    where: eq(schema.procedureDraftRuns.id, runId),
  });
  if (!run) return;
  if (run.status !== 'transcribing' && run.status !== 'storyboarding') {
    // Already past propose; do nothing.
    return;
  }

  await app.ctx.db
    .update(schema.procedureDraftRuns)
    .set({ status: 'proposing', updatedAt: new Date() })
    .where(eq(schema.procedureDraftRuns.id, runId));
  agentBus.publish(runChannel(runId, 'propose'), 'proposing', {});

  const transcriptWithTimestamps =
    opts?.transcriptWithTimestamps ?? deriveTranscriptWithTimestamps(run);

  const storyboardImageUrl = run.muxPlaybackId
    ? `https://image.mux.com/${run.muxPlaybackId}/thumbnail.jpg?width=1280&height=720&fit_mode=preserve`
    : null;

  try {
    const result = await runLoop({
      transcriptWithTimestamps: transcriptWithTimestamps.slice(0, 60_000),
      durationMs: run.sourceVideoDurationMs ?? 0,
      storyboardImageUrl,
      proposedTitle: run.proposedTitle,
      onStepEmitted: (step) => {
        agentBus.publish(runChannel(runId, 'propose'), 'step_emitted', {
          clientId: step.clientId,
          title: step.title,
          timestampMs: step.keyframeTimestampMs,
        });
      },
    });

    if (!result.finalized || result.proposal.steps.length === 0) {
      await app.ctx.db
        .update(schema.procedureDraftRuns)
        .set({
          status: 'failed',
          error: result.error ?? 'no steps proposed',
          updatedAt: new Date(),
        })
        .where(eq(schema.procedureDraftRuns.id, runId));
      agentBus.publish(runChannel(runId, 'propose'), 'failed', {
        error: result.error ?? 'no steps',
      });
      return;
    }

    // Persist proposal + flip status. Upsert via the unique(runId)
    // constraint so re-runs replace the prior proposal.
    await app.ctx.db
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
          version: 1, // fresh proposal — reviewer will bump via PATCH
          content: result.proposal,
          summary: result.proposal.summary,
          modelUsed: result.modelUsed,
          tokenUsage: result.usage,
          updatedAt: new Date(),
        },
      });
    await app.ctx.db
      .update(schema.procedureDraftRuns)
      .set({ status: 'awaiting_review', updatedAt: new Date() })
      .where(eq(schema.procedureDraftRuns.id, runId));
    agentBus.publish(runChannel(runId, 'propose'), 'awaiting_review', {
      stepCount: result.proposal.steps.length,
      tokenUsage: result.usage,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await app.ctx.db
      .update(schema.procedureDraftRuns)
      .set({ status: 'failed', error: message, updatedAt: new Date() })
      .where(eq(schema.procedureDraftRuns.id, runId));
    agentBus.publish(runChannel(runId, 'propose'), 'failed', { error: message });
  }
}

// ---------------------------------------------------------------------------
// Executor wrapper — wires the AI executor against the API's storage + TTS.
// ---------------------------------------------------------------------------

export async function runDrafterExecution(params: {
  app: FastifyInstance;
  runId: string;
  proposalId: string;
  proposalVersion: number;
  executionId: string;
  actorUserId: string;
  targetDocumentId: string;
  proposal: DraftProposalTree;
  signal?: AbortSignal;
}): Promise<void> {
  const { app, runId, proposalId, executionId, actorUserId, targetDocumentId, proposal, signal } =
    params;
  const { db, storage, env } = app.ctx;

  const run = await db.query.procedureDraftRuns.findFirst({
    where: eq(schema.procedureDraftRuns.id, runId),
  });
  if (!run?.muxPlaybackId) {
    throw new Error('draft run is missing muxPlaybackId; cannot fetch keyframes');
  }
  const playbackId = run.muxPlaybackId;

  // Closure-bind playbackId so the AI-side executor doesn't need to know
  // about Mux. It calls ctx.fetchKeyframe(_, timestampMs) and gets bytes
  // pulled from the right asset every time.
  const fetchKeyframe = async (_ignored: string, timestampMs: number) => {
    const seconds = Math.max(0, Math.floor(timestampMs / 1000));
    const url = `https://image.mux.com/${playbackId}/thumbnail.jpg?time=${seconds}&width=1280&fit_mode=preserve`;
    const resp = await fetch(url);
    if (!resp.ok) {
      throw new Error(`Mux thumbnail ${resp.status}: ${await resp.text().catch(() => '')}`);
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    const stored = await storage.putBuffer({
      buffer: buf,
      filename: `draft-${runId}-keyframe-${seconds}.jpg`,
      contentType: 'image/jpeg',
    });
    return {
      storageKey: stored.storageKey,
      mime: 'image/jpeg' as const,
      sizeBytes: stored.size,
    };
  };

  const synthesizeTts = async (text: string) => {
    if (!env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY required for draft TTS synthesis');
    }
    return synthesizeStepTts({
      text,
      voice: env.OPENAI_TTS_VOICE ?? 'alloy',
      model: env.OPENAI_TTS_MODEL,
      openaiApiKey: env.OPENAI_API_KEY,
      storage,
      filenameStem: `draft-${runId}-tts`,
    });
  };

  await db
    .update(schema.procedureDraftRuns)
    .set({ status: 'executing', updatedAt: new Date() })
    .where(eq(schema.procedureDraftRuns.id, runId));
  agentBus.publish(runChannel(runId, 'execute'), 'executing', {});

  const result = await executeDrafter({
    ctx: {
      db,
      synthesizeTts,
      fetchKeyframe,
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
        ? 'completed' // partial success — keep visible, surface failed count to UI
        : 'failed';

  await db.transaction(async (tx) => {
    await tx
      .update(schema.procedureDraftRuns)
      .set({
        status: completionStatus,
        targetDocumentId,
        updatedAt: new Date(),
      })
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
    skipped: result.skipped,
    failed: result.failed,
  });
}

// ---------------------------------------------------------------------------
// Whisper fallback — used when Mux captions don't arrive within 5 minutes
// of video.asset.ready.
// ---------------------------------------------------------------------------

async function runWhisperFallbackIfStuck(
  app: FastifyInstance,
  runId: string,
): Promise<void> {
  const run = await app.ctx.db.query.procedureDraftRuns.findFirst({
    where: eq(schema.procedureDraftRuns.id, runId),
  });
  if (!run) return;
  if (run.status !== 'transcribing') return; // already past it
  if (run.sourceTranscript) return; // captions arrived in time

  if (!run.muxPlaybackId) return;
  if (!app.ctx.env.OPENAI_API_KEY) {
    app.log.warn({ runId }, 'draft-pipeline: no OPENAI_API_KEY for whisper fallback');
    return;
  }

  try {
    // Mux serves a low-bitrate MP4 rendition at predictable URL. We pull
    // audio_only when available; otherwise grab the smallest video and
    // let Whisper handle it.
    const renditionUrl = `https://stream.mux.com/${run.muxPlaybackId}/low.mp4`;
    const audioResp = await fetch(renditionUrl);
    if (!audioResp.ok) {
      throw new Error(`Mux rendition fetch ${audioResp.status}`);
    }
    const buf = Buffer.from(await audioResp.arrayBuffer());
    if (buf.byteLength > 25 * 1024 * 1024) {
      throw new Error('rendition exceeds Whisper 25 MB limit');
    }
    const form = new FormData();
    const blob = new Blob([buf], { type: 'video/mp4' });
    form.append('file', blob, 'audio.mp4');
    form.append('model', app.ctx.env.OPENAI_STT_MODEL);
    form.append('response_format', 'verbose_json');
    form.append(
      'prompt',
      'Senior maintenance technician narrating a maintenance procedure.',
    );
    const whisperResp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { authorization: `Bearer ${app.ctx.env.OPENAI_API_KEY}` },
      body: form,
    });
    if (!whisperResp.ok) {
      throw new Error(`Whisper ${whisperResp.status}`);
    }
    const json = (await whisperResp.json()) as {
      text?: string;
      segments?: Array<{ start: number; end: number; text: string }>;
    };
    const plain = (json.text ?? '').trim();
    const withTimestamps = (json.segments ?? [])
      .map((s) => `[${formatMmSs(s.start)}] ${s.text.trim()}`)
      .join('\n');

    await app.ctx.db
      .update(schema.procedureDraftRuns)
      .set({
        sourceTranscript: plain,
        transcriptSource: 'whisper_fallback',
        updatedAt: new Date(),
      })
      .where(eq(schema.procedureDraftRuns.id, runId));
    agentBus.publish(runChannel(runId, 'propose'), 'transcript_ready', {
      source: 'whisper_fallback',
      lengthChars: plain.length,
    });
    void runDrafterLoop(app, runId, {
      transcriptWithTimestamps: withTimestamps || plain,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await app.ctx.db
      .update(schema.procedureDraftRuns)
      .set({ status: 'failed', error: `transcript fallback failed: ${message}`, updatedAt: new Date() })
      .where(eq(schema.procedureDraftRuns.id, runId));
    agentBus.publish(runChannel(runId, 'propose'), 'failed', { error: message });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fetchMuxCaptionVtt(playbackId: string, trackId?: string): Promise<string> {
  // Mux exposes generated_vod tracks as /text/<trackId>.vtt under the
  // playback domain. The trackId is provided in the webhook payload.
  if (!trackId) throw new Error('missing track id on track.ready event');
  const url = `https://stream.mux.com/${playbackId}/text/${trackId}.vtt`;
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`mux caption fetch ${resp.status}: ${await resp.text().catch(() => '')}`);
  }
  return resp.text();
}

/** Parse a WebVTT into a plain transcript + a transcript annotated with
 *  [mm:ss] markers at cue start times. Forgiving: malformed cues are
 *  skipped without throwing. */
function parseVtt(vtt: string): { plain: string; withTimestamps: string } {
  const lines = vtt.split(/\r?\n/);
  const plainParts: string[] = [];
  const tsParts: string[] = [];
  let lastTs: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    const m = line.match(/^(\d{1,2}:\d{2}(?::\d{2})?\.\d+)\s+-->\s+/);
    if (m) {
      lastTs = m[1] ?? null;
      continue;
    }
    if (!line || line === 'WEBVTT' || /^NOTE/i.test(line)) continue;
    if (/^\d+$/.test(line)) continue; // cue numbering
    plainParts.push(line);
    if (lastTs) {
      tsParts.push(`[${vttToMmSs(lastTs)}] ${line}`);
      lastTs = null;
    } else {
      tsParts.push(line);
    }
  }
  return {
    plain: plainParts.join(' '),
    withTimestamps: tsParts.join('\n'),
  };
}

function vttToMmSs(ts: string): string {
  // VTT timestamp: hh:mm:ss.mmm OR mm:ss.mmm
  const parts = ts.split(':');
  let mm: number;
  let ss: number;
  if (parts.length === 3) {
    mm = Number(parts[0]) * 60 + Number(parts[1]);
    ss = Math.floor(Number(parts[2]));
  } else {
    mm = Number(parts[0]);
    ss = Math.floor(Number(parts[1]));
  }
  return `${mm.toString().padStart(2, '0')}:${ss.toString().padStart(2, '0')}`;
}

function formatMmSs(seconds: number): string {
  const mm = Math.floor(seconds / 60);
  const ss = Math.floor(seconds % 60);
  return `${mm.toString().padStart(2, '0')}:${ss.toString().padStart(2, '0')}`;
}

function deriveTranscriptWithTimestamps(run: { sourceCaptionsVtt: string | null; sourceTranscript: string | null }): string {
  if (run.sourceCaptionsVtt) {
    return parseVtt(run.sourceCaptionsVtt).withTimestamps;
  }
  return run.sourceTranscript ?? '';
}
