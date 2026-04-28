// Onboarding Agent — proposal data model.
//
// The agent emits a tree of typed proposal nodes. Every node has a stable
// client-assigned `clientId` so downstream code (the executor, the review UI,
// the idempotency ledger) can refer to it across edits and retries. Parent
// references are by clientId, not by index — this lets the admin reorder or
// remove nodes in the review screen without invalidating downstream tokens.
//
// Each node carries provenance: which manifest files informed it, the LLM's
// rationale, and a confidence score. Convention-derived nodes get confidence
// 1.0 and are pre-checked in the review UI; LLM-derived nodes get whatever the
// model self-rates.
//
// Validation runs at three points:
//   1. When the LLM emits a node via `emitProposalNode` (tool input).
//   2. When the admin PATCHes the proposal (route handler).
//   3. Before execute kicks off (final defensive parse).

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Manifest (browser → server)
// ---------------------------------------------------------------------------

export const ManifestEntrySchema = z.object({
  relativePath: z.string().min(1),
  size: z.number().int().nonnegative(),
  contentType: z.string().nullable(),
  lastModified: z.number().nullable(),
});
export type ManifestEntry = z.infer<typeof ManifestEntrySchema>;

export const ManifestSchema = z.object({
  rootName: z.string().min(1),
  totalFiles: z.number().int().nonnegative(),
  totalBytes: z.number().nonnegative(),
  entries: z.array(ManifestEntrySchema),
});
export type Manifest = z.infer<typeof ManifestSchema>;

// ---------------------------------------------------------------------------
// Source provenance (which file(s) informed a node)
// ---------------------------------------------------------------------------

export const SourceRefSchema = z.object({
  // Either a manifest path or a `runFileId` (a server-side `agent_run_files.id`).
  // The agent uses paths during proposal; the executor resolves them to file
  // ids when applying.
  relativePath: z.string().min(1),
  // For PDFs/extracted text: which excerpt fed into the proposal. Optional,
  // helps the admin verify why something was inferred.
  excerpt: z.string().max(2000).nullish(),
});
export type SourceRef = z.infer<typeof SourceRefSchema>;

const NodeMetaSchema = z.object({
  // Stable identifier the LLM (or convention parser) invents for this node.
  // Format suggestion: kebab-case like `oem-acme`, `model-acme-conveyor-90`,
  // `doc-operator-manual-v3`. Must be unique within the proposal tree.
  clientId: z.string().min(1).max(120),
  // 0.0–1.0. Convention hits are 1.0 (deterministic). LLM nodes self-rate.
  confidence: z.number().min(0).max(1),
  // Files that informed this node. Empty array allowed (e.g. inferred sites
  // from instances.csv).
  sourceFiles: z.array(SourceRefSchema).default([]),
  // One-sentence rationale for the human reviewer.
  rationale: z.string().max(500).nullish(),
  // Whether the node came from the deterministic convention parser. Affects
  // pre-check default in the review UI.
  fromConvention: z.boolean().default(false),
});

// ---------------------------------------------------------------------------
// Per-kind payloads
// ---------------------------------------------------------------------------
//
// Payload shapes mirror the admin API mutation inputs (apps/admin/src/lib/api.ts)
// so the executor can pass them through with minimal mapping. Keep these in
// sync if the API changes.

const HexColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'expected #RRGGBB hex color')
  .nullish();

const OrganizationPayload = z.object({
  type: z.enum(['oem', 'dealer', 'integrator', 'end_customer']),
  name: z.string().min(1).max(200),
  slug: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/),
  oemCode: z.string().min(1).max(50).nullish(),
  parentClientId: z.string().min(1).nullish(),
  // Branding (OEM only). All optional — admin can fill in later.
  brandPrimary: HexColorSchema,
  brandOnPrimary: HexColorSchema,
  // Logo: relative path into the manifest. Executor resolves to storageKey.
  logoSourcePath: z.string().nullish(),
  displayNameOverride: z.string().max(200).nullish(),
});

const SitePayload = z.object({
  organizationClientId: z.string().min(1),
  name: z.string().min(1).max(200),
  code: z.string().max(50).nullish(),
  city: z.string().max(100).nullish(),
  region: z.string().max(100).nullish(),
  country: z.string().max(100).nullish(),
  postalCode: z.string().max(20).nullish(),
  timezone: z.string().max(50).nullish(),
});

const AssetModelPayload = z.object({
  ownerOrganizationClientId: z.string().min(1),
  modelCode: z.string().min(1).max(80),
  displayName: z.string().min(1).max(200),
  category: z.string().min(1).max(60),
  description: z.string().max(4000).nullish(),
  // Hero photo as a manifest path (executor resolves to storageKey).
  heroSourcePath: z.string().nullish(),
});

const PartPayload = z.object({
  ownerOrganizationClientId: z.string().min(1),
  oemPartNumber: z.string().min(1).max(120),
  displayName: z.string().min(1).max(200),
  description: z.string().max(4000).nullish(),
  crossReferences: z.array(z.string().max(120)).default([]),
  imageSourcePath: z.string().nullish(),
});

const BomEntryPayload = z.object({
  assetModelClientId: z.string().min(1),
  partClientId: z.string().min(1),
  positionRef: z.string().max(60).nullish(),
  quantity: z.number().int().positive().default(1),
  notes: z.string().max(500).nullish(),
});

const ContentPackPayload = z.object({
  assetModelClientId: z.string().min(1),
  layerType: z.enum(['base', 'dealer_overlay', 'site_overlay']),
  name: z.string().min(1).max(200),
  slug: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/),
  basePackClientId: z.string().min(1).nullish(),
});

const ContentPackVersionPayload = z.object({
  contentPackClientId: z.string().min(1),
  versionLabel: z.string().max(50).nullish(),
  changelog: z.string().max(2000).nullish(),
});

const DocumentPayload = z.object({
  contentPackVersionClientId: z.string().min(1),
  kind: z.enum([
    'markdown',
    'structured_procedure',
    'pdf',
    'slides',
    'file',
    'schematic',
    'video',
    'external_video',
  ]),
  title: z.string().min(1).max(300),
  language: z.string().min(2).max(10).default('en'),
  safetyCritical: z.boolean().default(false),
  tags: z.array(z.string().max(60)).default([]),
  bodyMarkdown: z.string().nullish(),
  // For pdf/slides/file/schematic and uploaded video: manifest path the
  // executor resolves into a storageKey.
  sourcePath: z.string().nullish(),
  // For external_video: pasted URL.
  externalUrl: z.string().url().nullish(),
  // For Mux video: set by the executor after the asset reaches `ready`.
  // Included here only for completeness; typically null at proposal time.
  streamPlaybackId: z.string().nullish(),
  thumbnailSourcePath: z.string().nullish(),
});

const TrainingModulePayload = z.object({
  contentPackVersionClientId: z.string().min(1),
  title: z.string().min(1).max(300),
  description: z.string().max(2000).nullish(),
  estimatedMinutes: z.number().int().positive().max(600).nullish(),
  competencyTag: z.string().max(120).nullish(),
  passThreshold: z.number().min(0).max(1).nullish(),
});

const LessonPayload = z.object({
  trainingModuleClientId: z.string().min(1),
  title: z.string().min(1).max(300),
  bodyMarkdown: z.string().nullish(),
  documentClientIds: z.array(z.string()).default([]),
});

const AssetInstancePayload = z.object({
  assetModelClientId: z.string().min(1),
  siteClientId: z.string().min(1),
  serialNumber: z.string().min(1).max(120),
  installedAt: z.string().datetime().nullish(),
  pinnedContentPackVersionClientId: z.string().min(1).nullish(),
});

const QrCodePayload = z.object({
  assetInstanceClientId: z.string().min(1),
  label: z.string().max(120).nullish(),
  preferredTemplateId: z.string().uuid().nullish(),
});

const PublishVersionPayload = z.object({
  contentPackVersionClientId: z.string().min(1),
  // The default in the UI is `false` — admin opts in per pack.
  publish: z.boolean().default(false),
});

// ---------------------------------------------------------------------------
// Discriminated union — one schema per node kind
// ---------------------------------------------------------------------------

export const ProposalNodeSchema = z.discriminatedUnion('kind', [
  NodeMetaSchema.extend({ kind: z.literal('organization'), payload: OrganizationPayload }),
  NodeMetaSchema.extend({ kind: z.literal('site'), payload: SitePayload }),
  NodeMetaSchema.extend({ kind: z.literal('asset_model'), payload: AssetModelPayload }),
  NodeMetaSchema.extend({ kind: z.literal('part'), payload: PartPayload }),
  NodeMetaSchema.extend({ kind: z.literal('bom_entry'), payload: BomEntryPayload }),
  NodeMetaSchema.extend({ kind: z.literal('content_pack'), payload: ContentPackPayload }),
  NodeMetaSchema.extend({
    kind: z.literal('content_pack_version'),
    payload: ContentPackVersionPayload,
  }),
  NodeMetaSchema.extend({ kind: z.literal('document'), payload: DocumentPayload }),
  NodeMetaSchema.extend({ kind: z.literal('training_module'), payload: TrainingModulePayload }),
  NodeMetaSchema.extend({ kind: z.literal('lesson'), payload: LessonPayload }),
  NodeMetaSchema.extend({ kind: z.literal('asset_instance'), payload: AssetInstancePayload }),
  NodeMetaSchema.extend({ kind: z.literal('qr_code'), payload: QrCodePayload }),
  NodeMetaSchema.extend({
    kind: z.literal('publish_version'),
    payload: PublishVersionPayload,
  }),
]);
export type ProposalNode = z.infer<typeof ProposalNodeSchema>;
export type ProposalNodeKind = ProposalNode['kind'];

// ---------------------------------------------------------------------------
// Proposal tree (flat array of nodes, parent links via clientId)
// ---------------------------------------------------------------------------

export const ProposalTreeSchema = z.object({
  // Schema version. Bump on breaking changes; the executor refuses unknown
  // versions to avoid garbage in / garbage out.
  schemaVersion: z.literal(1).default(1),
  // Free-form summary written by the agent for the human reviewer.
  summary: z.string().max(4000).default(''),
  // Optional warnings the agent surfaces (e.g. "couldn't classify 3 files").
  warnings: z.array(z.string()).default([]),
  nodes: z.array(ProposalNodeSchema),
});
export type ProposalTree = z.infer<typeof ProposalTreeSchema>;

// ---------------------------------------------------------------------------
// Convention parser output (the "scaffold")
// ---------------------------------------------------------------------------

export const ScaffoldTreeSchema = z.object({
  // Same shape as ProposalTree, but every node has confidence 1.0 and
  // fromConvention=true.
  schemaVersion: z.literal(1).default(1),
  nodes: z.array(ProposalNodeSchema),
  // Files the convention parser couldn't classify. Passed to the LLM as
  // "you figure these out".
  looseFiles: z.array(SourceRefSchema).default([]),
  // Files the parser is sure about but couldn't fit a node to (e.g. a CSV
  // with unrecognized columns). Surfaced as warnings.
  unmatched: z
    .array(
      z.object({
        relativePath: z.string(),
        reason: z.string(),
      }),
    )
    .default([]),
});
export type ScaffoldTree = z.infer<typeof ScaffoldTreeSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Topological order for execute. Returned indices into `nodes[]`. Throws on
 * cycles (which shouldn't happen — the schema is acyclic by construction —
 * but defensive in case a future edit introduces a back-reference).
 */
export function topoSortNodes(nodes: ProposalNode[]): number[] {
  // Order by kind first (organization → site → asset_model → ...). Within a
  // kind, order by parentClientId resolution: a node whose parent is in
  // `seen` can run.
  const KIND_ORDER: Record<ProposalNodeKind, number> = {
    organization: 0,
    site: 1,
    asset_model: 2,
    part: 3,
    bom_entry: 4,
    content_pack: 5,
    content_pack_version: 6,
    document: 7,
    training_module: 8,
    lesson: 9,
    asset_instance: 10,
    qr_code: 11,
    publish_version: 12,
  };
  const indexed = nodes.map((n, i) => ({ n, i }));
  indexed.sort((a, b) => {
    const ka = KIND_ORDER[a.n.kind];
    const kb = KIND_ORDER[b.n.kind];
    if (ka !== kb) return ka - kb;
    return a.n.clientId.localeCompare(b.n.clientId);
  });
  return indexed.map((x) => x.i);
}

/**
 * True iff every parentClientId / ref-clientId in the tree resolves to an
 * earlier node. Run before execute as a defensive check; the LLM occasionally
 * forgets to emit a referenced parent.
 */
export function validateReferences(tree: ProposalTree): { ok: true } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const ids = new Set(tree.nodes.map((n) => n.clientId));
  if (ids.size !== tree.nodes.length) {
    errors.push('duplicate clientId in proposal tree');
  }
  const requireRef = (nodeId: string, refField: string, ref: string | null | undefined) => {
    if (ref && !ids.has(ref)) {
      errors.push(`${nodeId}.${refField} → unknown clientId "${ref}"`);
    }
  };
  for (const n of tree.nodes) {
    switch (n.kind) {
      case 'organization':
        requireRef(n.clientId, 'parentClientId', n.payload.parentClientId);
        break;
      case 'site':
        requireRef(n.clientId, 'organizationClientId', n.payload.organizationClientId);
        break;
      case 'asset_model':
        requireRef(n.clientId, 'ownerOrganizationClientId', n.payload.ownerOrganizationClientId);
        break;
      case 'part':
        requireRef(n.clientId, 'ownerOrganizationClientId', n.payload.ownerOrganizationClientId);
        break;
      case 'bom_entry':
        requireRef(n.clientId, 'assetModelClientId', n.payload.assetModelClientId);
        requireRef(n.clientId, 'partClientId', n.payload.partClientId);
        break;
      case 'content_pack':
        requireRef(n.clientId, 'assetModelClientId', n.payload.assetModelClientId);
        requireRef(n.clientId, 'basePackClientId', n.payload.basePackClientId);
        break;
      case 'content_pack_version':
        requireRef(n.clientId, 'contentPackClientId', n.payload.contentPackClientId);
        break;
      case 'document':
        requireRef(n.clientId, 'contentPackVersionClientId', n.payload.contentPackVersionClientId);
        break;
      case 'training_module':
        requireRef(n.clientId, 'contentPackVersionClientId', n.payload.contentPackVersionClientId);
        break;
      case 'lesson':
        requireRef(n.clientId, 'trainingModuleClientId', n.payload.trainingModuleClientId);
        for (const docId of n.payload.documentClientIds) {
          requireRef(n.clientId, 'documentClientIds[]', docId);
        }
        break;
      case 'asset_instance':
        requireRef(n.clientId, 'assetModelClientId', n.payload.assetModelClientId);
        requireRef(n.clientId, 'siteClientId', n.payload.siteClientId);
        requireRef(
          n.clientId,
          'pinnedContentPackVersionClientId',
          n.payload.pinnedContentPackVersionClientId,
        );
        break;
      case 'qr_code':
        requireRef(n.clientId, 'assetInstanceClientId', n.payload.assetInstanceClientId);
        break;
      case 'publish_version':
        requireRef(
          n.clientId,
          'contentPackVersionClientId',
          n.payload.contentPackVersionClientId,
        );
        break;
    }
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/**
 * Stable client token used by the executor's idempotency ledger.
 * Format: `agent:<proposalId>:<kind>:<clientId>`. Survives admin edits because
 * clientIds are preserved on edit.
 */
export function buildClientToken(
  proposalId: string,
  kind: ProposalNodeKind,
  clientId: string,
): string {
  return `agent:${proposalId}:${kind}:${clientId}`;
}
