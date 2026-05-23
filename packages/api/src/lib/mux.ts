// Mux helper — wraps the SDK and exposes only the bits we use.
//
// We mint Direct Uploads server-side (so the secret never reaches the
// browser), the browser PUTs the file directly to Mux's S3, and we listen
// for webhook events to populate the playback id back into agent_run_files.
//
// Webhook verification uses the SDK's built-in HMAC check.

import Mux, { type ClientOptions } from '@mux/mux-node';
import type { UnwrapWebhookEvent } from '@mux/mux-node/resources/webhooks/webhooks.js';

export interface MuxConfig {
  tokenId: string;
  tokenSecret: string;
  webhookSecret: string;
  /** 'public' for v1; switch to 'signed' once playback policy is hardened. */
  playbackPolicy: 'public' | 'signed';
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

  return {
    async createDirectUpload({ passthrough }) {
      const upload = await mux.video.uploads.create({
        cors_origin: cfg.corsOrigin,
        new_asset_settings: {
          playback_policies: [cfg.playbackPolicy],
          passthrough,
          // Enable Mux's automatic English captions. Without this,
          // video.asset.track.ready never fires because there's no
          // transcription track being generated. The drafter pipeline
          // depends on these captions to produce a transcript for
          // Claude to segment.
          //
          // The video.* webhook payload type doesn't expose the
          // generated_subtitles field in the SDK's TS surface, but
          // Mux accepts it at runtime — cast to keep TypeScript happy.
          inputs: [
            {
              generated_subtitles: [
                { language_code: 'en', name: 'English (auto)' },
              ],
            },
          ] as unknown as undefined,
        },
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
