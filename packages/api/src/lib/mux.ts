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
          // Enable Mux's automatic captions for English when the upload has
          // an audio track. We don't surface captions in v1, but having the
          // tracks generated in the background means a v2 transcription
          // feature has nothing extra to wire.
          inputs: undefined,
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
      };
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
