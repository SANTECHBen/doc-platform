// Mux helper — wraps the SDK and exposes only the bits we use.
//
// We mint Direct Uploads server-side (so the secret never reaches the
// browser), the browser PUTs the file directly to Mux's S3, and we listen
// for webhook events to populate the playback id back into agent_run_files.
//
// Webhook verification uses the SDK's built-in HMAC check.
//
// Playback policy: defaults to 'signed' in production (env.ts). Signed
// playback IDs require a JWT that we mint server-side per request via
// signPlaybackToken(). The token expires quickly (default 60 min) and is
// scoped to a single playback id — even if it leaks it stops working
// after the TTL.

import jwt from 'jsonwebtoken';
import Mux, { type ClientOptions } from '@mux/mux-node';
import type { UnwrapWebhookEvent } from '@mux/mux-node/resources/webhooks/webhooks.js';

export interface MuxConfig {
  tokenId: string;
  tokenSecret: string;
  webhookSecret: string;
  /** 'public' (legacy) or 'signed' (default). Signed playback requires
   *  signingKeyId + signingKeyPrivate; mint tokens via signPlaybackToken. */
  playbackPolicy: 'public' | 'signed';
  /** RS256 key id from Mux Dashboard. Required when playbackPolicy='signed'. */
  signingKeyId?: string | null;
  /** RS256 private key, PEM-encoded. Required when playbackPolicy='signed'. */
  signingKeyPrivate?: string | null;
  /**
   * CORS origin for direct uploads. Should be the admin app's public origin.
   */
  corsOrigin: string;
}

export interface MuxAssetTrack {
  id: string;
  type: 'audio' | 'video' | 'text';
  languageCode: string | null;
  /** For 'text' tracks Mux populates this once generation completes. */
  status: string | null;
  textSource: string | null;
}

export interface MuxClient {
  /** Current playback policy. Callers use this to decide whether to mint
   *  a signed token (`signed`) or render the playback id directly
   *  (`public`). */
  readonly playbackPolicy: 'public' | 'signed';
  /** Mint a short-lived signed playback token for a single playback id.
   *  Returns null when the deployment is configured with playbackPolicy
   *  = 'public' (no signing required) or when signing keys are missing
   *  (returns null to let the caller surface a clear error rather than
   *  serving an unprotected URL by accident).
   *
   *  When `clip` is supplied, the start/end times are embedded as JWT
   *  claims so Mux's edge enforces them as playback bounds — users
   *  can't widen the range by editing the URL. Use this for signed-
   *  playback per-step clip URLs (Mux's "instant clipping" feature).
   *  For public playback the bounds go in the URL as query params via
   *  `muxClipStreamUrl` below; this clip parameter is ignored. */
  signPlaybackToken: (input: {
    playbackId: string;
    /** Audience: 'v' = video stream, 't' = thumbnail, 'g' = gif, 's' = storyboard. */
    audience?: 'v' | 't' | 'g' | 's';
    /** Lifetime in seconds. Defaults to 3600 (1 hour). Capped at 6 hours. */
    ttlSeconds?: number;
    /** Clip bounds (in seconds) to enforce server-side. Mux's instant
     *  clipping returns just the requested range; the JWT prevents
     *  range tampering. Omit for the full asset. */
    clip?: { startSec: number; endSec: number };
  }) => string | null;
  createDirectUpload: (input: {
    /** Optional pass-through info, surfaced in webhook events. */
    passthrough?: string;
  }) => Promise<{ uploadId: string; uploadUrl: string }>;
  getAsset: (assetId: string) => Promise<{
    id: string;
    status: string;
    playbackIds: Array<{ id: string; policy: string }>;
    duration: number | null;
    aspectRatio: string | null;
    tracks: MuxAssetTrack[];
  }>;
  /**
   * Get the asset for a given upload id. Useful for the polling fallback in
   * dev (when webhooks can't reach localhost).
   */
  getUpload: (uploadId: string) => Promise<{
    id: string;
    status: string;
    assetId: string | null;
  }>;
  /**
   * Retroactively request auto-generated captions for an asset's audio
   * track. Idempotent — Mux returns 400 if a generated_vod track already
   * exists, which callers should treat as success.
   */
  enableAutoCaptions: (
    assetId: string,
    audioTrackId: string,
    languageCode?: string,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  unwrapWebhook: (
    body: string,
    headers: Record<string, string | string[] | undefined>,
    secret?: string | null,
  ) => Promise<UnwrapWebhookEvent>;
}

export function createMuxClient(cfg: MuxConfig): MuxClient {
  const opts: ClientOptions = {
    tokenId: cfg.tokenId,
    tokenSecret: cfg.tokenSecret,
    webhookSecret: cfg.webhookSecret,
  };
  const mux = new Mux(opts);

  // Decode the signing key once at init. Mux returns RSA keys base64-
  // encoded; some operators paste the raw PEM. Support both.
  let signingKeyPem: string | null = null;
  if (cfg.playbackPolicy === 'signed' && cfg.signingKeyPrivate) {
    const raw = cfg.signingKeyPrivate.trim();
    if (raw.startsWith('-----BEGIN')) {
      signingKeyPem = raw;
    } else {
      try {
        signingKeyPem = Buffer.from(raw, 'base64').toString('utf8');
      } catch {
        signingKeyPem = null;
      }
    }
  }

  return {
    playbackPolicy: cfg.playbackPolicy,
    signPlaybackToken({ playbackId, audience = 'v', ttlSeconds = 3600, clip }) {
      if (cfg.playbackPolicy !== 'signed') return null;
      if (!cfg.signingKeyId || !signingKeyPem) return null;
      const ttl = Math.max(60, Math.min(ttlSeconds, 6 * 3600));
      // Mux's instant-clipping JWT claims. When present, Mux's edge
      // returns a manifest covering only [asset_start_time..asset_end_time]
      // and refuses query-param overrides — so the user can't widen the
      // range by editing the URL. Bound values are clamped to >= 0 here
      // for defense-in-depth; Mux also validates server-side.
      const clipClaims =
        clip && Number.isFinite(clip.startSec) && Number.isFinite(clip.endSec)
          ? {
              asset_start_time: Math.max(0, clip.startSec),
              asset_end_time: Math.max(clip.startSec + 0.001, clip.endSec),
            }
          : {};
      return jwt.sign(
        {
          sub: playbackId,
          aud: audience,
          exp: Math.floor(Date.now() / 1000) + ttl,
          kid: cfg.signingKeyId,
          ...clipClaims,
        },
        signingKeyPem,
        { algorithm: 'RS256', keyid: cfg.signingKeyId },
      );
    },
    async createDirectUpload({ passthrough }) {
      // We need two settings the SDK's TypeScript surface doesn't
      // expose: `inputs[].generated_subtitles` (auto-captions for the
      // drafter's transcription pipeline) and `segment_size` (controls
      // HLS segment length, which Mux's instant-clipping URL bounds
      // snap to). Mux accepts both at runtime; we cast the whole
      // settings object once at the call site.
      const newAssetSettings: Record<string, unknown> = {
        playback_policies: [cfg.playbackPolicy],
        passthrough,
        // Auto-generated English captions — without this,
        // video.asset.track.ready never fires and the drafter has
        // nothing to feed Claude for step segmentation.
        inputs: [
          {
            generated_subtitles: [
              { language_code: 'en', name: 'English (auto)' },
            ],
          },
        ],
        // 2-second HLS segments instead of the default ~6s. Tightens
        // the snap-to-segment behavior of instant-clipping URLs
        // (`?asset_start_time=X&asset_end_time=Y`) so per-step clips
        // drift at most ~2s from the AI-picked moment. The extra
        // segment files cost is negligible for our short walkthroughs.
        segment_size: 2,
      };
      const upload = await mux.video.uploads.create({
        cors_origin: cfg.corsOrigin,
        new_asset_settings:
          newAssetSettings as unknown as Parameters<
            typeof mux.video.uploads.create
          >[0]['new_asset_settings'],
      });
      if (!upload.url) {
        throw new Error(`Mux returned an upload without a url (id=${upload.id})`);
      }
      return {
        uploadId: upload.id,
        uploadUrl: upload.url,
      };
    },

    async getAsset(assetId) {
      const a = await mux.video.assets.retrieve(assetId);
      return {
        id: a.id,
        status: a.status,
        playbackIds:
          a.playback_ids?.map((p) => ({ id: p.id, policy: p.policy ?? 'public' })) ?? [],
        duration: a.duration ?? null,
        aspectRatio: a.aspect_ratio ?? null,
        tracks: (a.tracks ?? []).map((t) => ({
          id: t.id ?? '',
          type: (t.type ?? 'audio') as MuxAssetTrack['type'],
          languageCode: t.language_code ?? null,
          status: t.status ?? null,
          textSource: (t as { text_source?: string }).text_source ?? null,
        })),
      };
    },

    async enableAutoCaptions(assetId, audioTrackId, languageCode = 'en') {
      try {
        await mux.video.assets.generateSubtitles(assetId, audioTrackId, {
          generated_subtitles: [
            {
              // Mux's SDK types this as a closed union; 'en' is the
              // default. Cast through unknown so callers can pass other
              // valid Mux codes if needed.
              language_code: languageCode as 'en',
              name: 'English (auto)',
            },
          ],
        });
        return { ok: true };
      } catch (err) {
        // Mux returns 400 when a generated_vod track already exists. Treat
        // that as success for idempotency — the caller can poll/await the
        // existing track.
        const message = err instanceof Error ? err.message : String(err);
        if (/already.*generated/i.test(message) || /400/.test(message)) {
          return { ok: true };
        }
        return { ok: false, error: message };
      }
    },

    async getUpload(uploadId) {
      const u = await mux.video.uploads.retrieve(uploadId);
      return {
        id: u.id,
        status: u.status,
        assetId: u.asset_id ?? null,
      };
    },

    unwrapWebhook: (body, headers, secret) =>
      mux.webhooks.unwrap(body, headers as Parameters<typeof mux.webhooks.unwrap>[1], secret),
  };
}

// ---------------------------------------------------------------------------
// Per-step clip URL — Mux instant clipping
// ---------------------------------------------------------------------------
//
// The PWA's AI-walkthrough player used to receive `https://stream.mux.com/<id>.m3u8`
// for every step of a procedure (one shared playback id), then clamp
// playback to a per-step [startMs..endMs] window via JS — seek to start,
// watch timeupdate, wrap on endMs. That worked but produced a cascade of
// iOS-Safari quirks (shared HLS decoder across video elements pointed at
// the same URL → wrong-step frames; seek artifacts → "frame jumping" on
// swipe; loop boundary stutters; etc.).
//
// Mux's instant-clipping feature solves this at the URL level: append
// `?asset_start_time=...&asset_end_time=...` (or bake the same values
// into the playback JWT) and Mux's edge returns a manifest representing
// only the requested range. To the browser it looks like a small native
// video — `loop`, `currentTime`, and decoder management all behave the
// way they would for any standalone clip.
//
// Trade-offs vs. asset-based clipping (which encodes a real new asset):
//   * Free vs. per-clip encoding/storage cost
//   * Synchronous (URL works immediately) vs. async (wait for asset.ready)
//   * Segment-aligned (boundaries can drift up to ~segment_size seconds)
//     vs. frame-accurate. We mitigate by setting `segment_size: 2` on
//     new uploads above; legacy ~6s-segment assets still play correctly
//     but may include a few extra seconds of context on each end.
//
// Refs: https://www.mux.com/docs/guides/intro-to-clips
//       https://www.mux.com/docs/guides/create-clips-from-your-videos
export interface MuxClipStreamUrlOptions {
  playbackId: string;
  startMs: number;
  endMs: number;
  /** Pre-minted JWT from `signPlaybackToken({ playbackId, clip })`. When
   *  present, the JWT's `asset_start_time` / `asset_end_time` claims
   *  enforce the clip bounds and the URL omits the equivalent query
   *  params (Mux rejects URL-param overrides when those claims are
   *  present in the token). Pass `null` or omit for public playback,
   *  where the bounds go on the URL directly. */
  signedToken?: string | null;
}

/** Build the HLS URL the PWA player consumes for an AI-walkthrough step.
 *  Constructed in two places on the read path (admin & field routes);
 *  centralized here so the URL shape and signing wiring stay in sync. */
export function muxClipStreamUrl(opts: MuxClipStreamUrlOptions): string {
  const base = `https://stream.mux.com/${opts.playbackId}.m3u8`;
  if (opts.signedToken) {
    // The clip bounds are baked into the JWT claims (see signPlaybackToken's
    // `clip` parameter). Mux's edge enforces them server-side, so we don't
    // — and can't — repeat them as URL params.
    return `${base}?token=${opts.signedToken}`;
  }
  // Public playback: bounds as URL params. Float precision is millisecond-
  // ish (3 decimal places); Mux truncates beyond that anyway.
  const startSec = Math.max(0, opts.startMs / 1000).toFixed(3);
  const endSec = Math.max(opts.startMs / 1000 + 0.1, opts.endMs / 1000).toFixed(3);
  return `${base}?asset_start_time=${startSec}&asset_end_time=${endSec}`;
}

/** One-shot convenience: sign the playback token if signed playback is
 *  configured, then build the URL. Use this from route handlers that
 *  emit per-step clip URLs in API responses — the caller doesn't need
 *  to know whether the deployment uses signed or public playback. */
export function muxClipUrlFor(
  mux: MuxClient,
  args: { playbackId: string; startMs: number; endMs: number },
): string {
  const signedToken = mux.signPlaybackToken({
    playbackId: args.playbackId,
    clip: { startSec: args.startMs / 1000, endSec: args.endMs / 1000 },
  });
  return muxClipStreamUrl({
    playbackId: args.playbackId,
    startMs: args.startMs,
    endMs: args.endMs,
    signedToken,
  });
}
