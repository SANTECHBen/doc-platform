// Pure executor — applies a ProposalTree against an injected AdminClient
// interface. The implementation that talks to Postgres and writes audit
// events lives in packages/api/src/lib/agent-executor.ts.
//
// Why split this way:
//   - Unit tests can mock AdminClient and verify the entire mutation
//     sequence on a fixture proposal.
//   - The executor stays in @platform/ai (no Fastify, no DB driver) so it
//     can be reused by background workers, replay tools, etc.
//
// Idempotency model: callers track each step in a ledger keyed by
// `client_token`. Before issuing a mutation we check the ledger and skip
// already-succeeded or already-deduped steps. The executor surfaces every
// state transition through `onStep`; the caller persists it.

import {
  buildClientToken,
  topoSortNodes,
  type ProposalNode,
  type ProposalNodeKind,
  type ProposalTree,
} from './schema.js';

// ---------------------------------------------------------------------------
// AdminClient — the only thing the executor talks to
// ---------------------------------------------------------------------------

export interface AdminClient {
  // Resolve a manifest path to a {storageKey, sha256, contentType, size,
  // streamPlaybackId} bundle. Used for documents/parts/orgs whose payloads
  // reference a sourcePath. Returns null if the file isn't in the run yet
  // (e.g. Mux video still processing).
  resolveSource: (relativePath: string) => Promise<{
    storageKey: string | null;
    streamPlaybackId: string | null;
    contentType: string | null;
    sizeBytes: number | null;
    originalFilename: string | null;
  } | null>;

  // ---- Natural-key lookups (return existing entity ids for dedup) -------

  findOrganization: (params: {
    name: string;
    parentId: string | null;
    oemCode: string | null;
  }) => Promise<{ id: string } | null>;
  findSite: (params: { organizationId: string; name: string }) => Promise<{ id: string } | null>;
  findAssetModel: (params: {
    ownerOrganizationId: string;
    modelCode: string;
  }) => Promise<{ id: string } | null>;
  findPart: (params: {
    ownerOrganizationId: string;
    oemPartNumber: string;
  }) => Promise<{ id: string } | null>;
  findContentPack: (params: {
    ownerOrganizationId: string;
    slug: string;
  }) => Promise<{ id: string } | null>;
  findAssetInstance: (params: {
    assetModelId: string;
    serialNumber: string;
  }) => Promise<{ id: string } | null>;
  findBomEntry: (params: {
    assetModelId: string;
    partId: string;
  }) => Promise<{ id: string } | null>;
  findQrCodeForInstance: (params: {
    assetInstanceId: string;
  }) => Promise<{ id: string } | null>;

  // ---- Creates ----------------------------------------------------------

  createOrganization: (input: {
    type: 'oem' | 'dealer' | 'integrator' | 'end_customer';
    name: string;
    slug: string;
    oemCode: string | null;
    parentOrganizationId: string | null;
    brandPrimary: string | null;
    brandOnPrimary: string | null;
    logoStorageKey: string | null;
    displayNameOverride: string | null;
  }) => Promise<{ id: string }>;
  createSite: (input: {
    organizationId: string;
    name: string;
    code: string | null;
    city: string | null;
    region: string | null;
    country: string | null;
    postalCode: string | null;
    timezone: string | null;
  }) => Promise<{ id: string }>;
  createAssetModel: (input: {
    ownerOrganizationId: string;
    modelCode: string;
    displayName: string;
    category: string;
    description: string | null;
    heroStorageKey: string | null;
  }) => Promise<{ id: string }>;
  createPart: (input: {
    ownerOrganizationId: string;
    oemPartNumber: string;
    displayName: string;
    description: string | null;
    crossReferences: string[];
    imageStorageKey: string | null;
  }) => Promise<{ id: string }>;
  createBomEntry: (input: {
    assetModelId: string;
    partId: string;
    positionRef: string | null;
    quantity: number;
    notes: string | null;
  }) => Promise<{ id: string }>;
  createContentPack: (input: {
    assetModelId: string;
    ownerOrganizationId: string;
    layerType: 'base' | 'dealer_overlay' | 'site_overlay';
    name: string;
    slug: string;
    basePackId: string | null;
  }) => Promise<{ id: string; draftVersionId: string }>;
  createContentPackVersion: (input: {
    contentPackId: string;
    versionLabel: string | null;
    changelog: string | null;
  }) => Promise<{ id: string }>;
  createDocument: (input: {
    contentPackVersionId: string;
    kind: 'markdown' | 'structured_procedure' | 'pdf' | 'slides' | 'file' | 'schematic' | 'video' | 'external_video';
    title: string;
    language: string;
    safetyCritical: boolean;
    tags: string[];
    bodyMarkdown: string | null;
    storageKey: string | null;
    contentType: string | null;
    sizeBytes: number | null;
    originalFilename: string | null;
    externalUrl: string | null;
    streamPlaybackId: string | null;
    thumbnailStorageKey: string | null;
  }) => Promise<{ id: string }>;
  createTrainingModule: (input: {
    contentPackVersionId: string;
    title: string;
    description: string | null;
    estimatedMinutes: number | null;
    competencyTag: string | null;
    passThreshold: number | null;
  }) => Promise<{ id: string }>;
  createLesson: (input: {
    trainingModuleId: string;
    title: string;
    bodyMarkdown: string | null;
    documentIds: string[];
  }) => Promise<{ id: string }>;
  createAssetInstance: (input: {
    assetModelId: string;
    siteId: string;
    serialNumber: string;
    installedAt: string | null;
    pinnedContentPackVersionId: string | null;
  }) => Promise<{ id: string }>;
  mintQrCode: (input: {
    assetInstanceId: string;
    label: string | null;
    preferredTemplateId: string | null;
  }) => Promise<{ id: string }>;
  publishContentPackVersion: (input: { versionId: string }) => Promise<{ id: string }>;
}

// ---------------------------------------------------------------------------
// Step ledger
// ---------------------------------------------------------------------------

export type StepStatus =
  | 'pending'
  | 'in_progress'
  | 'succeeded'
  | 'skipped_existing'
  | 'failed';

export interface StepRecord {
  clientToken: string;
  kind: ProposalNodeKind;
  clientId: string;
  status: StepStatus;
  targetId: string | null;
  notes: string | null;
  error: string | null;
}

export type LedgerLookup = (clientToken: string) => StepRecord | null;

export type StepCallback = (step: StepRecord) => Promise<void> | void;

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export interface ExecuteParams {
  proposalId: string;
  tree: ProposalTree;
  client: AdminClient;
  /** Pre-existing ledger rows (for resume). Returns null = step not started. */
  ledger: LedgerLookup;
  /** Called whenever a step transitions state. The caller persists. */
  onStep: StepCallback;
  signal?: AbortSignal;
}

export interface ExecuteResult {
  stepsAttempted: number;
  stepsSucceeded: number;
  stepsSkipped: number;
  stepsFailed: number;
  /** Map of clientId → real id. Used by downstream nodes to resolve refs. */
  resolved: Map<string, string>;
}

export async function executeProposal(params: ExecuteParams): Promise<ExecuteResult> {
  const { proposalId, tree, client, ledger, onStep, signal } = params;
  const order = topoSortNodes(tree.nodes);
  const resolved = new Map<string, string>();

  const stats = {
    stepsAttempted: 0,
    stepsSucceeded: 0,
    stepsSkipped: 0,
    stepsFailed: 0,
  };

  for (const idx of order) {
    if (signal?.aborted) break;
    const node = tree.nodes[idx]!;
    const clientToken = buildClientToken(proposalId, node.kind, node.clientId);

    const prior = ledger(clientToken);
    if (prior?.status === 'succeeded' || prior?.status === 'skipped_existing') {
      if (prior.targetId) resolved.set(node.clientId, prior.targetId);
      stats.stepsSkipped += 1;
      continue;
    }

    stats.stepsAttempted += 1;
    await onStep({
      clientToken,
      kind: node.kind,
      clientId: node.clientId,
      status: 'in_progress',
      targetId: null,
      notes: null,
      error: null,
    });

    try {
      const outcome = await applyNode({ node, client, resolved });
      if (outcome.skipped) {
        stats.stepsSkipped += 1;
      } else {
        stats.stepsSucceeded += 1;
      }
      resolved.set(node.clientId, outcome.id);
      await onStep({
        clientToken,
        kind: node.kind,
        clientId: node.clientId,
        status: outcome.skipped ? 'skipped_existing' : 'succeeded',
        targetId: outcome.id,
        notes: outcome.notes ?? null,
        error: null,
      });
    } catch (err) {
      stats.stepsFailed += 1;
      const message = err instanceof Error ? err.message : String(err);
      await onStep({
        clientToken,
        kind: node.kind,
        clientId: node.clientId,
        status: 'failed',
        targetId: null,
        notes: null,
        error: message,
      });
    }
  }

  return { ...stats, resolved };
}

// ---------------------------------------------------------------------------
// Per-kind apply
// ---------------------------------------------------------------------------

interface ApplyArgs {
  node: ProposalNode;
  client: AdminClient;
  resolved: Map<string, string>;
}

interface ApplyOutcome {
  id: string;
  skipped: boolean;
  notes?: string;
}

function refOrThrow(map: Map<string, string>, clientId: string, field: string): string {
  const id = map.get(clientId);
  if (!id) throw new Error(`Unresolved reference ${field}=${clientId}`);
  return id;
}

async function applyNode({ node, client, resolved }: ApplyArgs): Promise<ApplyOutcome> {
  switch (node.kind) {
    case 'organization': {
      const parentId = node.payload.parentClientId
        ? refOrThrow(resolved, node.payload.parentClientId, 'parentClientId')
        : null;
      const existing = await client.findOrganization({
        name: node.payload.name,
        parentId,
        oemCode: node.payload.oemCode ?? null,
      });
      if (existing) {
        return { id: existing.id, skipped: true, notes: 'existing org matched by natural key' };
      }
      const logoStorageKey = await resolveSourceKey(
        client,
        node.payload.logoSourcePath,
      );
      const created = await client.createOrganization({
        type: node.payload.type,
        name: node.payload.name,
        slug: node.payload.slug,
        oemCode: node.payload.oemCode ?? null,
        parentOrganizationId: parentId,
        brandPrimary: node.payload.brandPrimary ?? null,
        brandOnPrimary: node.payload.brandOnPrimary ?? null,
        logoStorageKey,
        displayNameOverride: node.payload.displayNameOverride ?? null,
      });
      return { id: created.id, skipped: false };
    }

    case 'site': {
      const orgId = refOrThrow(resolved, node.payload.organizationClientId, 'organizationClientId');
      const existing = await client.findSite({
        organizationId: orgId,
        name: node.payload.name,
      });
      if (existing) return { id: existing.id, skipped: true };
      const created = await client.createSite({
        organizationId: orgId,
        name: node.payload.name,
        code: node.payload.code ?? null,
        city: node.payload.city ?? null,
        region: node.payload.region ?? null,
        country: node.payload.country ?? null,
        postalCode: node.payload.postalCode ?? null,
        timezone: node.payload.timezone ?? null,
      });
      return { id: created.id, skipped: false };
    }

    case 'asset_model': {
      const orgId = refOrThrow(
        resolved,
        node.payload.ownerOrganizationClientId,
        'ownerOrganizationClientId',
      );
      const existing = await client.findAssetModel({
        ownerOrganizationId: orgId,
        modelCode: node.payload.modelCode,
      });
      if (existing) return { id: existing.id, skipped: true };
      const heroStorageKey = await resolveSourceKey(client, node.payload.heroSourcePath);
      const created = await client.createAssetModel({
        ownerOrganizationId: orgId,
        modelCode: node.payload.modelCode,
        displayName: node.payload.displayName,
        category: node.payload.category,
        description: node.payload.description ?? null,
        heroStorageKey,
      });
      return { id: created.id, skipped: false };
    }

    case 'part': {
      const orgId = refOrThrow(
        resolved,
        node.payload.ownerOrganizationClientId,
        'ownerOrganizationClientId',
      );
      const existing = await client.findPart({
        ownerOrganizationId: orgId,
        oemPartNumber: node.payload.oemPartNumber,
      });
      if (existing) return { id: existing.id, skipped: true };
      const imageStorageKey = await resolveSourceKey(client, node.payload.imageSourcePath);
      const created = await client.createPart({
        ownerOrganizationId: orgId,
        oemPartNumber: node.payload.oemPartNumber,
        displayName: node.payload.displayName,
        description: node.payload.description ?? null,
        crossReferences: node.payload.crossReferences,
        imageStorageKey,
      });
      return { id: created.id, skipped: false };
    }

    case 'bom_entry': {
      const modelId = refOrThrow(resolved, node.payload.assetModelClientId, 'assetModelClientId');
      const partId = refOrThrow(resolved, node.payload.partClientId, 'partClientId');
      const existing = await client.findBomEntry({ assetModelId: modelId, partId });
      if (existing) return { id: existing.id, skipped: true };
      const created = await client.createBomEntry({
        assetModelId: modelId,
        partId,
        positionRef: node.payload.positionRef ?? null,
        quantity: node.payload.quantity,
        notes: node.payload.notes ?? null,
      });
      return { id: created.id, skipped: false };
    }

    case 'content_pack': {
      const modelId = refOrThrow(resolved, node.payload.assetModelClientId, 'assetModelClientId');
      // Owner org is derived from the asset model; the AdminClient is in
      // charge of looking it up. We fetch via findContentPack on slug.
      // For ownerOrgId, the createContentPack route will derive it from the
      // model when not provided — but our interface requires the value. The
      // implementation infers from the model.
      const existing = await client.findContentPack({
        ownerOrganizationId: '', // sentinel; impl uses slug uniqueness
        slug: node.payload.slug,
      });
      if (existing) return { id: existing.id, skipped: true };
      const basePackId = node.payload.basePackClientId
        ? refOrThrow(resolved, node.payload.basePackClientId, 'basePackClientId')
        : null;
      const created = await client.createContentPack({
        assetModelId: modelId,
        ownerOrganizationId: '', // impl derives from model
        layerType: node.payload.layerType,
        name: node.payload.name,
        slug: node.payload.slug,
        basePackId,
      });
      // Stash the draft version id under a synthetic clientId so subsequent
      // content_pack_version nodes that reference this pack get the pre-baked
      // version. We use the convention `${clientId}__draft` in the runner.
      resolved.set(`${node.clientId}__draft`, created.draftVersionId);
      return { id: created.id, skipped: false };
    }

    case 'content_pack_version': {
      const packId = refOrThrow(resolved, node.payload.contentPackClientId, 'contentPackClientId');
      // The pack creation already includes a draft version. If the proposal
      // is the v1 draft, reuse it. Otherwise, create a new version row.
      const cached = resolved.get(`${node.payload.contentPackClientId}__draft`);
      if (cached) {
        // First-version-of-pack case — reuse the auto-created draft so the
        // documents land on the right version.
        resolved.delete(`${node.payload.contentPackClientId}__draft`);
        return { id: cached, skipped: true, notes: 'reused auto-created draft version' };
      }
      const created = await client.createContentPackVersion({
        contentPackId: packId,
        versionLabel: node.payload.versionLabel ?? null,
        changelog: node.payload.changelog ?? null,
      });
      return { id: created.id, skipped: false };
    }

    case 'document': {
      const versionId = refOrThrow(
        resolved,
        node.payload.contentPackVersionClientId,
        'contentPackVersionClientId',
      );
      const source = node.payload.sourcePath
        ? await client.resolveSource(node.payload.sourcePath)
        : null;
      // Video: prefer streamPlaybackId from Mux, fall back to storageKey.
      const isVideoKind = node.payload.kind === 'video';
      const streamPlaybackId =
        node.payload.streamPlaybackId ?? source?.streamPlaybackId ?? null;
      if (isVideoKind && !streamPlaybackId && !source?.storageKey) {
        throw new Error(
          `Video document "${node.payload.title}" has no playback id yet — Mux upload still processing.`,
        );
      }
      const created = await client.createDocument({
        contentPackVersionId: versionId,
        kind: node.payload.kind,
        title: node.payload.title,
        language: node.payload.language,
        safetyCritical: node.payload.safetyCritical,
        tags: node.payload.tags,
        bodyMarkdown: node.payload.bodyMarkdown ?? null,
        storageKey: source?.storageKey ?? null,
        contentType: source?.contentType ?? null,
        sizeBytes: source?.sizeBytes ?? null,
        originalFilename: source?.originalFilename ?? null,
        externalUrl: node.payload.externalUrl ?? null,
        streamPlaybackId,
        thumbnailStorageKey: node.payload.thumbnailSourcePath
          ? (await client.resolveSource(node.payload.thumbnailSourcePath))?.storageKey ?? null
          : null,
      });
      return { id: created.id, skipped: false };
    }

    case 'training_module': {
      const versionId = refOrThrow(
        resolved,
        node.payload.contentPackVersionClientId,
        'contentPackVersionClientId',
      );
      const created = await client.createTrainingModule({
        contentPackVersionId: versionId,
        title: node.payload.title,
        description: node.payload.description ?? null,
        estimatedMinutes: node.payload.estimatedMinutes ?? null,
        competencyTag: node.payload.competencyTag ?? null,
        passThreshold: node.payload.passThreshold ?? null,
      });
      return { id: created.id, skipped: false };
    }

    case 'lesson': {
      const moduleId = refOrThrow(
        resolved,
        node.payload.trainingModuleClientId,
        'trainingModuleClientId',
      );
      const documentIds = node.payload.documentClientIds
        .map((cid) => resolved.get(cid))
        .filter((id): id is string => Boolean(id));
      const created = await client.createLesson({
        trainingModuleId: moduleId,
        title: node.payload.title,
        bodyMarkdown: node.payload.bodyMarkdown ?? null,
        documentIds,
      });
      return { id: created.id, skipped: false };
    }

    case 'asset_instance': {
      const modelId = refOrThrow(resolved, node.payload.assetModelClientId, 'assetModelClientId');
      const siteId = refOrThrow(resolved, node.payload.siteClientId, 'siteClientId');
      const existing = await client.findAssetInstance({
        assetModelId: modelId,
        serialNumber: node.payload.serialNumber,
      });
      if (existing) return { id: existing.id, skipped: true };
      const pinnedVersionId = node.payload.pinnedContentPackVersionClientId
        ? refOrThrow(
            resolved,
            node.payload.pinnedContentPackVersionClientId,
            'pinnedContentPackVersionClientId',
          )
        : null;
      const created = await client.createAssetInstance({
        assetModelId: modelId,
        siteId,
        serialNumber: node.payload.serialNumber,
        installedAt: node.payload.installedAt ?? null,
        pinnedContentPackVersionId: pinnedVersionId,
      });
      return { id: created.id, skipped: false };
    }

    case 'qr_code': {
      const instanceId = refOrThrow(
        resolved,
        node.payload.assetInstanceClientId,
        'assetInstanceClientId',
      );
      const existing = await client.findQrCodeForInstance({ assetInstanceId: instanceId });
      if (existing) return { id: existing.id, skipped: true };
      const created = await client.mintQrCode({
        assetInstanceId: instanceId,
        label: node.payload.label ?? null,
        preferredTemplateId: node.payload.preferredTemplateId ?? null,
      });
      return { id: created.id, skipped: false };
    }

    case 'publish_version': {
      const versionId = refOrThrow(
        resolved,
        node.payload.contentPackVersionClientId,
        'contentPackVersionClientId',
      );
      if (!node.payload.publish) {
        return { id: versionId, skipped: true, notes: 'publish toggled off' };
      }
      const out = await client.publishContentPackVersion({ versionId });
      return { id: out.id, skipped: false };
    }
  }
}

async function resolveSourceKey(
  client: AdminClient,
  path: string | null | undefined,
): Promise<string | null> {
  if (!path) return null;
  const src = await client.resolveSource(path);
  return src?.storageKey ?? null;
}
