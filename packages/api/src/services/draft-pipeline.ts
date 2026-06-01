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

import { and, eq, inArray, lt } from 'drizzle-orm';
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
  aspect_ratio?: string;
}

/** Classify a Mux `aspect_ratio` ("16:9", "9:16", "4:3", "1:1") into the
 *  coarse buckets the runner needs: portrait, landscape, or square. Falls
 *  back to landscape when the ratio is malformed (the runner's default
 *  styling assumes landscape). */
function classifyOrientation(
  aspectRatio: string | null | undefined,
): 'portrait' | 'landscape' | 'square' | null {
  if (!aspectRatio) return null;
  const m = aspectRatio.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  // 2% tolerance around square so something like 1.02:1 still reads square.
  const ratio = w / h;
  if (Math.abs(ratio - 1) < 0.02) return 'square';
  return ratio < 1 ? 'portrait' : 'landscape';
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
  const aspectRatio = data.aspect_ratio ?? null;
  const orientation = classifyOrientation(aspectRatio);

  // Read the existing row before mutating so we can respect any
  // tech-asserted orientation override the PWA submitted (we treat any
  // pre-existing sourceVideoOrientation as authoritative — Mux's
  // auto-detection only fills in when there's no explicit hint).
  const existing = await app.ctx.db.query.procedureDraftRuns.findFirst({
    where: eq(schema.procedureDraftRuns.id, runId),
    columns: { sourceVideoOrientation: true },
  });

  const updates: Record<string, unknown> = {
    muxPlaybackId: playbackId,
    updatedAt: new Date(),
  };
  if (durationMs != null) updates.sourceVideoDurationMs = durationMs;
  if (aspectRatio) updates.sourceVideoAspectRatio = aspectRatio;
  if (orientation && !existing?.sourceVideoOrientation) {
    updates.sourceVideoOrientation = orientation;
  }
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
    // PWA-submitted drafts pause here. The admin reviews the transcript
    // and the asset context, then explicitly taps Run AI to spend on
    // the LLM. Admin-initiated drafts kick the loop automatically.
    if (run.pwaSubmitted) {
      await app.ctx.db
        .update(schema.procedureDraftRuns)
        .set({ status: 'pending_admin_decision', updatedAt: new Date() })
        .where(eq(schema.procedureDraftRuns.id, runId));
      agentBus.publish(runChannel(runId, 'propose'), 'awaiting_review', {
        gate: 'pending_admin_decision',
      });
      return;
    }
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

/**
 * Polls Mux directly for the current state of a draft's upload + asset.
 * Used as a safety net when webhooks don't arrive (Mux destination
 * misconfigured, network blip, slow processing). Idempotent — calling
 * it on an already-progressed draft is a no-op.
 *
 *   - If the upload has an assetId we don't yet know about → set
 *     muxAssetId, move status to 'transcribing'.
 *   - If the asset is 'ready' and we don't have a playbackId → set
 *     muxPlaybackId + storyboardVttUrl + duration; kick the LLM loop
 *     when the run is admin-initiated (pwa_submitted=false). PWA
 *     submissions stop here at pending_admin_decision so the admin
 *     can review the transcript before spending on AI.
 *   - If captions are available → fetch the VTT and persist; gate
 *     LLM kickoff on pwa_submitted as usual.
 */
export async function refreshDraftFromMux(
  app: FastifyInstance,
  runId: string,
): Promise<{
  status: string;
  changed: string[];
  notes: string[];
}> {
  const { db } = app.ctx;
  const mux = app.ctx.mux;
  if (!mux) {
    throw new Error('Mux client not configured');
  }
  const run = await db.query.procedureDraftRuns.findFirst({
    where: eq(schema.procedureDraftRuns.id, runId),
  });
  if (!run) throw new Error('draft run not found');

  const changed: string[] = [];
  const notes: string[] = [];
  let assetId = run.muxAssetId;

  // Step 1: if we don't have an assetId yet, ask Mux about the upload.
  if (!assetId && run.muxUploadId) {
    try {
      const upload = await mux.getUpload(run.muxUploadId);
      if (upload.assetId) {
        assetId = upload.assetId;
        await db
          .update(schema.procedureDraftRuns)
          .set({
            muxAssetId: assetId,
            status: run.status === 'uploading' ? 'transcribing' : run.status,
            updatedAt: new Date(),
          })
          .where(eq(schema.procedureDraftRuns.id, run.id));
        changed.push('muxAssetId');
        if (run.status === 'uploading') changed.push('status=transcribing');
      } else {
        notes.push(`Mux upload status: ${upload.status}; no asset yet`);
      }
    } catch (err) {
      notes.push(
        `Mux upload lookup failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Step 2: if we have an assetId, poll its state.
  if (assetId) {
    try {
      const asset = await mux.getAsset(assetId);
      const playbackId = asset.playbackIds[0]?.id ?? null;
      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (playbackId && !run.muxPlaybackId) {
        updates.muxPlaybackId = playbackId;
        updates.storyboardVttUrl = `https://image.mux.com/${playbackId}/storyboard.vtt`;
        changed.push('muxPlaybackId');
      }
      if (asset.duration && !run.sourceVideoDurationMs) {
        updates.sourceVideoDurationMs = Math.round(asset.duration * 1000);
        changed.push('duration');
      }
      if (asset.aspectRatio && !run.sourceVideoAspectRatio) {
        updates.sourceVideoAspectRatio = asset.aspectRatio;
        const orientation = classifyOrientation(asset.aspectRatio);
        if (orientation) updates.sourceVideoOrientation = orientation;
        changed.push('aspectRatio');
      }
      // Advance status when asset is ready and we're still in
      // uploading/transcribing — the webhook may have missed.
      if (
        asset.status === 'ready' &&
        (run.status === 'uploading' || run.status === 'transcribing')
      ) {
        // Don't immediately go to pending_admin_decision for PWA
        // submissions — we still need the transcript. Leave status at
        // 'transcribing' so the track.ready webhook (or a Whisper
        // fallback) advances it later.
        if (!run.status.startsWith('uploading')) {
          // No-op — already past upload phase.
        } else {
          updates.status = 'transcribing';
          changed.push('status=transcribing');
        }
      }
      if (asset.status === 'errored') {
        updates.status = 'failed';
        updates.error = `Mux asset errored (poll)`;
        changed.push('status=failed');
      }
      if (Object.keys(updates).length > 1) {
        await db
          .update(schema.procedureDraftRuns)
          .set(updates)
          .where(eq(schema.procedureDraftRuns.id, run.id));
      }
      notes.push(`Mux asset status: ${asset.status}`);

      // If the asset is ready and we still don't have a transcript,
      // try recovery via Mux auto-captions (free, async) — this is
      // the right path now that we know the .mp4 rendition fallback
      // doesn't work without mp4_support enabled on the asset.
      if (asset.status === 'ready' && !run.sourceTranscript) {
        const textTrack = asset.tracks.find(
          (t) => t.type === 'text' && t.textSource === 'generated_vod',
        );
        const audioTrack = asset.tracks.find((t) => t.type === 'audio');

        if (textTrack && textTrack.status === 'ready' && asset.playbackIds[0]) {
          // Mux already generated captions but the webhook never
          // landed. Fetch the VTT directly and persist it.
          try {
            const vtt = await fetchMuxCaptionVtt(asset.playbackIds[0].id, textTrack.id);
            const { plain, withTimestamps } = parseVtt(vtt);
            await db
              .update(schema.procedureDraftRuns)
              .set({
                sourceTranscript: plain,
                sourceCaptionsVtt: vtt,
                transcriptSource: 'mux_captions',
                updatedAt: new Date(),
              })
              .where(eq(schema.procedureDraftRuns.id, run.id));
            agentBus.publish(runChannel(run.id, 'propose'), 'transcript_ready', {
              source: 'mux_captions',
              lengthChars: plain.length,
            });
            // PWA submissions stop at pending_admin_decision; admin-
            // initiated drafts auto-kick the LLM.
            if (run.pwaSubmitted) {
              await db
                .update(schema.procedureDraftRuns)
                .set({ status: 'pending_admin_decision', updatedAt: new Date() })
                .where(eq(schema.procedureDraftRuns.id, run.id));
            } else {
              void runDrafterLoop(app, run.id, {
                transcriptWithTimestamps: withTimestamps || plain,
              });
            }
            changed.push('transcript');
            notes.push('fetched existing Mux captions');
          } catch (err) {
            notes.push(
              `Mux caption fetch failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        } else if (audioTrack) {
          // No captions track yet — request one from Mux. The webhook
          // fires when ready (usually 1-2 min). If the webhook misses,
          // the user can tap Refresh again and we'll catch the ready
          // track in the branch above.
          const result = await mux.enableAutoCaptions(asset.id, audioTrack.id, 'en');
          if (result.ok) {
            // Reset the run out of any prior failed/uploading state so
            // the UI moves to "Transcribing" instead of continuing to
            // show the stale failure message. Clears `error` too.
            const recoveryUpdate: Record<string, unknown> = { updatedAt: new Date() };
            if (run.status === 'failed' || run.status === 'uploading') {
              recoveryUpdate.status = 'transcribing';
              recoveryUpdate.error = null;
              changed.push('status=transcribing');
              changed.push('error_cleared');
            } else if (run.error) {
              recoveryUpdate.error = null;
              changed.push('error_cleared');
            }
            if (Object.keys(recoveryUpdate).length > 1) {
              await db
                .update(schema.procedureDraftRuns)
                .set(recoveryUpdate)
                .where(eq(schema.procedureDraftRuns.id, run.id));
            }
            notes.push(
              'requested Mux auto-captions; transcript should arrive in 1-2 min',
            );
            changed.push('captions_requested');
          } else {
            notes.push(`Could not request captions: ${result.error}`);
          }
        } else {
          notes.push('asset has no audio track — cannot generate captions');
        }
      }
    } catch (err) {
      notes.push(
        `Mux asset lookup failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Always touch updatedAt so the background sweeper (see
  // sweepStuckDrafts) paces itself correctly. The sweeper uses
  // `updatedAt < now() - 20s` as its "haven't polled recently" filter;
  // if a poll above made no changes we still need to record that we
  // looked, otherwise the sweeper would re-fire on the same draft
  // every tick and hammer Mux.
  await db
    .update(schema.procedureDraftRuns)
    .set({ updatedAt: new Date() })
    .where(eq(schema.procedureDraftRuns.id, runId));

  // Re-read the final state for the response.
  const final = await db.query.procedureDraftRuns.findFirst({
    where: eq(schema.procedureDraftRuns.id, runId),
    columns: { status: true },
  });
  return { status: final?.status ?? run.status, changed, notes };
}

// Sweeper config — exported so tests / ops can introspect.
//
// MIN_POLL_INTERVAL_MS: don't repoll a draft we just touched. Stops the
// sweeper from hammering Mux on a draft that's actively progressing.
// 20s gives the webhook a clean window to land first (typical webhook
// latency is <5s); past that, the polling fallback kicks in.
export const DRAFT_SWEEPER_MIN_POLL_INTERVAL_MS = 20_000;
// WHISPER_FALLBACK_AGE_MS: how long a draft can sit in 'transcribing'
// before we give up on Mux captions and synthesize a transcript via
// Whisper. The in-process timer in onDraftMuxAssetReady covers the
// happy path; the sweeper is the durable backup that survives
// container restarts. 5 min mirrors that timer.
export const DRAFT_SWEEPER_WHISPER_FALLBACK_AGE_MS = 5 * 60_000;
// Per-tick cap so the sweeper can't run away if a backlog accumulates.
// At 20s tick, 25/tick = 75 drafts/minute — well above realistic load.
export const DRAFT_SWEEPER_MAX_PER_TICK = 25;

export interface DraftSweepResult {
  /** Number of stuck drafts the sweeper found this tick. */
  scanned: number;
  /** How many of those changed state as a result of the refresh. */
  changed: number;
  /** Drafts whose refresh threw. The error is logged on the app logger. */
  errors: number;
  /** Drafts old enough that the Whisper fallback fired. */
  whisperFallbacks: number;
}

/**
 * Background sweeper for draft runs stuck waiting on Mux webhooks.
 *
 * Why this exists
 * ---------------
 * Mux delivers state transitions (asset.ready, track.ready) via webhooks.
 * When the webhook misses — Fly autoscaled to zero, transient network,
 * Mux retry exhausted, anything — drafts hang in 'uploading' /
 * 'transcribing' forever. Users notice and have to manually tap
 * "Refresh from Mux" on the admin reviewer; that's the bug this fixes.
 *
 * What it does
 * ------------
 * Every server.ts tick (20s), find drafts in webhook-dependent states
 * whose `updatedAt` is older than the min-poll-interval. For each:
 *   1. Call refreshDraftFromMux — polls Mux for upload/asset/track state
 *      and advances the run when something has progressed.
 *   2. If the draft has been in 'transcribing' for >5 min with no
 *      transcript, fire runWhisperFallback as a safety net (the
 *      in-process 5-min timer dies on container restart; this is the
 *      durable equivalent).
 *
 * Idempotency
 * -----------
 * Both refreshDraftFromMux and runWhisperFallback are idempotent — the
 * sweeper can run alongside in-process timers / live webhook handlers
 * without double-processing.
 */
export async function sweepStuckDrafts(
  app: FastifyInstance,
): Promise<DraftSweepResult> {
  const { db } = app.ctx;
  const now = Date.now();
  const pollCutoff = new Date(now - DRAFT_SWEEPER_MIN_POLL_INTERVAL_MS);

  // Only sweep webhook-dependent statuses. Other statuses are either
  // user-driven (pending_admin_decision, awaiting_review), already
  // running in-process (proposing, executing), or terminal (completed,
  // failed, cancelled). 'storyboarding' is transient and owned by the
  // LLM kickoff path — leave it alone.
  // Mutable array (not `as const`) — drizzle's inArray needs a writable
  // tuple to match the column's literal-union enum type.
  const stuckStatuses: Array<'uploading' | 'transcribing'> = [
    'uploading',
    'transcribing',
  ];

  const stuck = await db.query.procedureDraftRuns.findMany({
    where: and(
      inArray(schema.procedureDraftRuns.status, stuckStatuses),
      lt(schema.procedureDraftRuns.updatedAt, pollCutoff),
    ),
    columns: {
      id: true,
      status: true,
      createdAt: true,
      muxPlaybackId: true,
      sourceTranscript: true,
    },
    limit: DRAFT_SWEEPER_MAX_PER_TICK,
  });

  let changed = 0;
  let errors = 0;
  let whisperFallbacks = 0;

  // Serial loop — keeps Mux API pressure low and makes log output
  // easy to read. Sweep volume is bounded by MAX_PER_TICK anyway.
  for (const row of stuck) {
    try {
      const result = await refreshDraftFromMux(app, row.id);
      if (result.changed.length > 0) {
        changed++;
        app.log.info(
          { runId: row.id, changed: result.changed, notes: result.notes },
          'draft-sweeper: advanced stuck draft',
        );
      }

      // After the refresh, check whether this row qualifies for the
      // Whisper safety net. We use the row we read at sweep time
      // (createdAt is immutable, transcript/playbackId only got more
      // populated by refreshDraftFromMux above — so an absent transcript
      // is still absent).
      const transcribingTooLong =
        row.status === 'transcribing' &&
        !row.sourceTranscript &&
        row.muxPlaybackId != null &&
        now - new Date(row.createdAt).getTime() >
          DRAFT_SWEEPER_WHISPER_FALLBACK_AGE_MS;
      if (transcribingTooLong) {
        const whisper = await runWhisperFallback(app, row.id);
        if (whisper.ran) {
          whisperFallbacks++;
          app.log.info(
            { runId: row.id },
            'draft-sweeper: triggered Whisper fallback for stuck transcribing draft',
          );
        }
      }
    } catch (err) {
      errors++;
      app.log.warn(
        { err, runId: row.id },
        'draft-sweeper: refresh failed; will retry next tick',
      );
    }
  }

  return { scanned: stuck.length, changed, errors, whisperFallbacks };
}

/**
 * Public entry point for the LLM loop. Called from the auto-start path
 * (track.ready / Whisper fallback) and from the manual "Run AI" admin
 * route for PWA-submitted drafts. Idempotent: if the run is already past
 * the transcribe stage, it returns without re-running.
 */
export async function startDrafterLoop(
  app: FastifyInstance,
  runId: string,
): Promise<void> {
  const run = await app.ctx.db.query.procedureDraftRuns.findFirst({
    where: eq(schema.procedureDraftRuns.id, runId),
  });
  if (!run) throw new Error('run not found');
  if (
    run.status !== 'pending_admin_decision' &&
    run.status !== 'transcribing' &&
    run.status !== 'storyboarding'
  ) {
    throw new Error(`cannot start LLM in status '${run.status}'`);
  }
  // Move out of pending_admin_decision so concurrent reads don't see a
  // stale gate; the inner function will progress to 'proposing' itself.
  if (run.status === 'pending_admin_decision') {
    await app.ctx.db
      .update(schema.procedureDraftRuns)
      .set({ status: 'transcribing', updatedAt: new Date() })
      .where(eq(schema.procedureDraftRuns.id, runId));
  }
  await runDrafterLoop(app, runId);
}

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

  // Extract caption cue boundaries (in ms) from the VTT so the LLM's
  // clip range picks can be snapped to the nearest spoken-sentence edge
  // by the loop's post-process. Falls back to an empty array when the
  // run was transcribed via Whisper (no VTT persisted).
  const cueBoundariesMs = run.sourceCaptionsVtt
    ? extractCueBoundariesMs(run.sourceCaptionsVtt)
    : [];

  try {
    const result = await runLoop({
      transcriptWithTimestamps: transcriptWithTimestamps.slice(0, 60_000),
      durationMs: run.sourceVideoDurationMs ?? 0,
      storyboardImageUrl,
      proposedTitle: run.proposedTitle,
      procedureCategory: run.procedureCategory ?? null,
      captionCueBoundariesMs: cueBoundariesMs,
      onStepEmitted: (step) => {
        agentBus.publish(runChannel(runId, 'propose'), 'step_emitted', {
          clientId: step.clientId,
          title: step.title,
          timestampMs: step.keyframeTimestampMs,
          clipStartMs: step.clipStartMs,
          clipEndMs: step.clipEndMs,
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
      ownerOrganizationId: run.ownerOrganizationId,
    });
    return {
      storageKey: stored.storageKey,
      mime: 'image/jpeg' as const,
      sizeBytes: stored.size,
    };
  };

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
      filenameStem: `draft-${runId}-tts`,
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

  const result = await executeDrafter({
    ctx: {
      db,
      synthesizeTts,
      fetchKeyframe,
      sourcePlaybackId: playbackId,
      sourceAspectRatio: run.sourceVideoAspectRatio,
      sourceOrientation: run.sourceVideoOrientation,
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

/** Public Whisper fallback runner. Used by the manual refresh route to
 *  recover drafts whose transcription never started (e.g., captions
 *  weren't enabled on the Mux asset, or the asset.ready webhook missed
 *  and the in-process 5-minute timer never fired). Safe to call on
 *  drafts that already have a transcript — it short-circuits. */
export async function runWhisperFallback(
  app: FastifyInstance,
  runId: string,
): Promise<{ ran: boolean; reason?: string }> {
  const run = await app.ctx.db.query.procedureDraftRuns.findFirst({
    where: eq(schema.procedureDraftRuns.id, runId),
  });
  if (!run) return { ran: false, reason: 'run not found' };
  if (run.sourceTranscript) return { ran: false, reason: 'transcript already present' };
  if (!run.muxPlaybackId) {
    return { ran: false, reason: 'no Mux playbackId yet (asset still processing)' };
  }
  if (!app.ctx.env.OPENAI_API_KEY) {
    return { ran: false, reason: 'OPENAI_API_KEY not configured' };
  }
  await runWhisperFallbackIfStuck(app, runId);
  return { ran: true };
}

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
    // Same PWA gate as the captions path. We re-fetch the run state
    // because the timer is async and a /cancel could have landed.
    const post = await app.ctx.db.query.procedureDraftRuns.findFirst({
      where: eq(schema.procedureDraftRuns.id, runId),
    });
    if (post?.pwaSubmitted) {
      await app.ctx.db
        .update(schema.procedureDraftRuns)
        .set({ status: 'pending_admin_decision', updatedAt: new Date() })
        .where(eq(schema.procedureDraftRuns.id, runId));
      agentBus.publish(runChannel(runId, 'propose'), 'awaiting_review', {
        gate: 'pending_admin_decision',
      });
      return;
    }
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

/** Pull every cue boundary (start + end timestamps) out of a VTT, in ms,
 *  deduplicated and sorted ascending. Used by the drafter loop to snap
 *  the LLM's proposed clip edges to real spoken-sentence boundaries so
 *  clips don't start mid-word or end mid-syllable. */
function extractCueBoundariesMs(vtt: string): number[] {
  const lines = vtt.split(/\r?\n/);
  const out = new Set<number>();
  const cueLine = /^(\d{1,2}:\d{2}(?::\d{2})?\.\d+)\s+-->\s+(\d{1,2}:\d{2}(?::\d{2})?\.\d+)/;
  for (const raw of lines) {
    const m = raw.trim().match(cueLine);
    if (!m) continue;
    const start = vttToMs(m[1]!);
    const end = vttToMs(m[2]!);
    if (start != null) out.add(start);
    if (end != null) out.add(end);
  }
  return Array.from(out).sort((a, b) => a - b);
}

function vttToMs(ts: string): number | null {
  // Accept hh:mm:ss.mmm or mm:ss.mmm.
  const parts = ts.split(':');
  let h = 0;
  let m = 0;
  let s = 0;
  if (parts.length === 3) {
    h = Number(parts[0]);
    m = Number(parts[1]);
    s = Number(parts[2]);
  } else if (parts.length === 2) {
    m = Number(parts[0]);
    s = Number(parts[1]);
  } else {
    return null;
  }
  if (!Number.isFinite(h) || !Number.isFinite(m) || !Number.isFinite(s)) return null;
  return Math.round((h * 3600 + m * 60 + s) * 1000);
}
