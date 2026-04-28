// Shared context object passed to every agent tool factory.
//
// The agent doesn't talk directly to Postgres, S3, or Mux. Each tool gets a
// narrow, injectable context — that lets us:
//   - mock everything for unit tests (no live DB or LLM),
//   - run the same loop server-side from the Fastify route,
//   - keep `packages/ai` decoupled from infrastructure.
//
// Concrete wiring (DB queries, S3 streams, Mux client) lives in the route
// handler that constructs this context.

import type { Database } from '@platform/db';
import type { ProposalNode } from '../schema.js';

export interface ExistingOrgRef {
  id: string;
  name: string;
  type: string;
  oemCode: string | null;
  parentId: string | null;
}

export interface ExistingAssetModelRef {
  id: string;
  ownerOrgId: string;
  modelCode: string;
  displayName: string;
}

export interface ExistingPartRef {
  id: string;
  ownerOrgId: string;
  oemPartNumber: string;
  displayName: string;
}

export interface ExistingContentPackRef {
  id: string;
  assetModelId: string;
  ownerOrgId: string;
  slug: string;
  layerType: string;
}

export interface MuxDirectUploadResult {
  uploadId: string;
  uploadUrl: string;
}

export interface AgentEvent {
  type:
    | 'tool_call'
    | 'tool_result'
    | 'node_emitted'
    | 'finalize'
    | 'warning'
    | 'error';
  data: Record<string, unknown>;
}

export interface AgentToolContext {
  db: Database;

  /**
   * Read raw bytes for a file referenced by manifest path. Resolves to null
   * if the file hasn't been uploaded yet (e.g. video still uploading to Mux,
   * or convention-only run with no upload step).
   */
  readFile: (relativePath: string) => Promise<Buffer | null>;

  /**
   * Read a file's metadata + content type without buffering the bytes.
   */
  statFile: (relativePath: string) => Promise<{
    sizeBytes: number;
    contentType: string | null;
  } | null>;

  /**
   * Search existing organizations. At least one of `name` or `oemCode` is
   * usually supplied. Empty result = nothing existing — the agent can
   * propose a new one.
   */
  searchOrganizations: (params: {
    name?: string;
    oemCode?: string;
    type?: string;
  }) => Promise<ExistingOrgRef[]>;

  searchAssetModels: (params: {
    ownerOrgId?: string;
    modelCode?: string;
    displayName?: string;
  }) => Promise<ExistingAssetModelRef[]>;

  searchParts: (params: {
    ownerOrgId?: string;
    partNumber?: string;
    name?: string;
  }) => Promise<ExistingPartRef[]>;

  searchContentPacks: (params: {
    assetModelId?: string;
    slug?: string;
  }) => Promise<ExistingContentPackRef[]>;

  /**
   * Mint a Mux Direct Upload URL for a video file in this run. Returns the
   * upload URL the browser will PUT to. Server-side this is also called
   * eagerly during file upload routing.
   */
  createMuxDirectUpload: (params: {
    runFileId: string;
    relativePath: string;
    contentType: string | null;
  }) => Promise<MuxDirectUploadResult>;

  /**
   * Sink for `emitProposalNode` tool calls. Persists the node to
   * agent_proposals.content (deduping by clientId — last write wins for the
   * same id within a run) and broadcasts a `node_emitted` event over SSE.
   */
  emitNode: (node: ProposalNode) => Promise<void>;

  /**
   * Sink for `finalizeProposal`. Marks the agent run as awaiting_review and
   * stores the summary + warnings on the proposal row.
   */
  finalize: (input: {
    summary: string;
    warnings: string[];
  }) => Promise<void>;

  /**
   * Live event broadcaster for SSE. Tool implementations call this with
   * `tool_call` / `tool_result` events; the SSE handler relays them to the
   * browser.
   */
  emitEvent: (event: AgentEvent) => void;

  /**
   * Optional vision call — used by the `classifyImage` tool. Takes a
   * downscaled image buffer and a hint, returns a structured classification.
   * Pluggable so tests can mock without spinning up the gateway.
   */
  classifyImage: (input: {
    image: Buffer;
    contentType: string;
    hint?: string;
  }) => Promise<{
    classification:
      | 'logo'
      | 'hero'
      | 'schematic'
      | 'part_photo'
      | 'screenshot'
      | 'other';
    description: string;
    dominantColors: string[];
  }>;

  /**
   * AbortSignal that aborts the agent loop (e.g. on wall-clock cap or
   * client disconnect). Tools should pass this through to fetch / DB
   * queries where supported.
   */
  signal?: AbortSignal;
}
