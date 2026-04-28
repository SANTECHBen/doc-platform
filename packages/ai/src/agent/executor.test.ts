// Executor unit tests. Mocked AdminClient — no DB or LLM.

import { describe, expect, it } from 'vitest';
import { executeProposal, type AdminClient, type StepRecord } from './executor.js';
import { ProposalTreeSchema, type ProposalTree } from './schema.js';

interface MockState {
  organizations: Map<string, { id: string; name: string; oemCode: string | null; parentId: string | null }>;
  sites: Map<string, { id: string; orgId: string; name: string }>;
  assetModels: Map<string, { id: string; ownerOrgId: string; modelCode: string }>;
  parts: Map<string, { id: string; ownerOrgId: string; partNumber: string }>;
  bom: Map<string, { id: string; modelId: string; partId: string }>;
  packs: Map<string, { id: string; modelId: string; slug: string }>;
  versions: Map<string, { id: string; packId: string; status: 'draft' | 'published' }>;
  documents: Map<string, { id: string; versionId: string; title: string }>;
  modules: Map<string, { id: string; versionId: string; title: string }>;
  lessons: Map<string, { id: string; moduleId: string; title: string }>;
  instances: Map<string, { id: string; modelId: string; siteId: string; serial: string }>;
  qrCodes: Map<string, { id: string; instanceId: string }>;
  // Trace of every method call, in order.
  trace: Array<{ method: string; args: unknown }>;
  // Throw on these (method-name) invocations.
  throwOn?: Set<string>;
  // Counters by method name (used to fail only the Nth call, etc.).
  callCount: Record<string, number>;
}

function fresh(): MockState {
  return {
    organizations: new Map(),
    sites: new Map(),
    assetModels: new Map(),
    parts: new Map(),
    bom: new Map(),
    packs: new Map(),
    versions: new Map(),
    documents: new Map(),
    modules: new Map(),
    lessons: new Map(),
    instances: new Map(),
    qrCodes: new Map(),
    trace: [],
    callCount: {},
  };
}

let nextId = 0;
const id = (prefix: string) => `${prefix}-${++nextId}`;

function buildMockClient(state: MockState): AdminClient {
  const record = (method: string, args: unknown) => {
    state.trace.push({ method, args });
    state.callCount[method] = (state.callCount[method] ?? 0) + 1;
    if (state.throwOn?.has(method)) {
      throw new Error(`mock: ${method} threw`);
    }
  };

  return {
    async resolveSource(p) {
      record('resolveSource', p);
      return { storageKey: `key/${p}`, streamPlaybackId: null, contentType: null, sizeBytes: null, originalFilename: p };
    },
    async findOrganization({ name, oemCode }) {
      record('findOrganization', { name, oemCode });
      const found = [...state.organizations.values()].find(
        (o) =>
          (oemCode && o.oemCode === oemCode) ||
          o.name.toLowerCase() === name.toLowerCase(),
      );
      return found ? { id: found.id } : null;
    },
    async findSite({ organizationId, name }) {
      record('findSite', { organizationId, name });
      const found = [...state.sites.values()].find(
        (s) => s.orgId === organizationId && s.name === name,
      );
      return found ? { id: found.id } : null;
    },
    async findAssetModel({ ownerOrganizationId, modelCode }) {
      record('findAssetModel', { ownerOrganizationId, modelCode });
      const found = [...state.assetModels.values()].find(
        (m) => m.ownerOrgId === ownerOrganizationId && m.modelCode === modelCode,
      );
      return found ? { id: found.id } : null;
    },
    async findPart({ ownerOrganizationId, oemPartNumber }) {
      record('findPart', { ownerOrganizationId, oemPartNumber });
      const found = [...state.parts.values()].find(
        (p) => p.ownerOrgId === ownerOrganizationId && p.partNumber === oemPartNumber,
      );
      return found ? { id: found.id } : null;
    },
    async findContentPack({ slug }) {
      record('findContentPack', { slug });
      const found = [...state.packs.values()].find((p) => p.slug === slug);
      return found ? { id: found.id } : null;
    },
    async findAssetInstance({ assetModelId, serialNumber }) {
      record('findAssetInstance', { assetModelId, serialNumber });
      const found = [...state.instances.values()].find(
        (i) => i.modelId === assetModelId && i.serial === serialNumber,
      );
      return found ? { id: found.id } : null;
    },
    async findBomEntry({ assetModelId, partId }) {
      record('findBomEntry', { assetModelId, partId });
      const found = [...state.bom.values()].find(
        (b) => b.modelId === assetModelId && b.partId === partId,
      );
      return found ? { id: found.id } : null;
    },
    async findQrCodeForInstance({ assetInstanceId }) {
      record('findQrCodeForInstance', { assetInstanceId });
      const found = [...state.qrCodes.values()].find((q) => q.instanceId === assetInstanceId);
      return found ? { id: found.id } : null;
    },
    async createOrganization(input) {
      record('createOrganization', input);
      const orgId = id('org');
      state.organizations.set(orgId, {
        id: orgId,
        name: input.name,
        oemCode: input.oemCode,
        parentId: input.parentOrganizationId,
      });
      return { id: orgId };
    },
    async createSite(input) {
      record('createSite', input);
      const sId = id('site');
      state.sites.set(sId, { id: sId, orgId: input.organizationId, name: input.name });
      return { id: sId };
    },
    async createAssetModel(input) {
      record('createAssetModel', input);
      const mId = id('model');
      state.assetModels.set(mId, {
        id: mId,
        ownerOrgId: input.ownerOrganizationId,
        modelCode: input.modelCode,
      });
      return { id: mId };
    },
    async createPart(input) {
      record('createPart', input);
      const pId = id('part');
      state.parts.set(pId, {
        id: pId,
        ownerOrgId: input.ownerOrganizationId,
        partNumber: input.oemPartNumber,
      });
      return { id: pId };
    },
    async createBomEntry(input) {
      record('createBomEntry', input);
      const bId = id('bom');
      state.bom.set(bId, { id: bId, modelId: input.assetModelId, partId: input.partId });
      return { id: bId };
    },
    async createContentPack(input) {
      record('createContentPack', input);
      const pId = id('pack');
      const vId = id('ver');
      state.packs.set(pId, { id: pId, modelId: input.assetModelId, slug: input.slug });
      state.versions.set(vId, { id: vId, packId: pId, status: 'draft' });
      return { id: pId, draftVersionId: vId };
    },
    async createContentPackVersion(input) {
      record('createContentPackVersion', input);
      const vId = id('ver');
      state.versions.set(vId, { id: vId, packId: input.contentPackId, status: 'draft' });
      return { id: vId };
    },
    async createDocument(input) {
      record('createDocument', input);
      const dId = id('doc');
      state.documents.set(dId, { id: dId, versionId: input.contentPackVersionId, title: input.title });
      return { id: dId };
    },
    async createTrainingModule(input) {
      record('createTrainingModule', input);
      const tId = id('train');
      state.modules.set(tId, { id: tId, versionId: input.contentPackVersionId, title: input.title });
      return { id: tId };
    },
    async createLesson(input) {
      record('createLesson', input);
      const lId = id('lesson');
      state.lessons.set(lId, { id: lId, moduleId: input.trainingModuleId, title: input.title });
      return { id: lId };
    },
    async createAssetInstance(input) {
      record('createAssetInstance', input);
      const iId = id('inst');
      state.instances.set(iId, {
        id: iId,
        modelId: input.assetModelId,
        siteId: input.siteId,
        serial: input.serialNumber,
      });
      return { id: iId };
    },
    async mintQrCode(input) {
      record('mintQrCode', input);
      const qId = id('qr');
      state.qrCodes.set(qId, { id: qId, instanceId: input.assetInstanceId });
      return { id: qId };
    },
    async publishContentPackVersion({ versionId }) {
      record('publishContentPackVersion', { versionId });
      const v = state.versions.get(versionId);
      if (v) v.status = 'published';
      return { id: versionId };
    },
  };
}

function smallTree(): ProposalTree {
  // OEM org → site → model → part → bom → pack → version → doc → instance → qr
  return ProposalTreeSchema.parse({
    schemaVersion: 1,
    summary: '',
    warnings: [],
    nodes: [
      {
        kind: 'organization',
        clientId: 'oem-acme',
        confidence: 1,
        sourceFiles: [],
        rationale: null,
        fromConvention: true,
        payload: {
          type: 'oem',
          name: 'Acme',
          slug: 'acme',
          oemCode: 'ACME',
          parentClientId: null,
          brandPrimary: null,
          brandOnPrimary: null,
          logoSourcePath: null,
          displayNameOverride: null,
        },
      },
      {
        kind: 'site',
        clientId: 'site-memphis',
        confidence: 1,
        sourceFiles: [],
        rationale: null,
        fromConvention: true,
        payload: {
          organizationClientId: 'oem-acme',
          name: 'Memphis DC',
          code: null,
          city: null,
          region: null,
          country: null,
          postalCode: null,
          timezone: null,
        },
      },
      {
        kind: 'asset_model',
        clientId: 'model-acme-ft90',
        confidence: 1,
        sourceFiles: [],
        rationale: null,
        fromConvention: true,
        payload: {
          ownerOrganizationClientId: 'oem-acme',
          modelCode: 'FT-MERGE-90',
          displayName: 'FT Merge 90',
          category: 'conveyor',
          description: null,
          heroSourcePath: null,
        },
      },
      {
        kind: 'part',
        clientId: 'part-dm-4712',
        confidence: 1,
        sourceFiles: [],
        rationale: null,
        fromConvention: true,
        payload: {
          ownerOrganizationClientId: 'oem-acme',
          oemPartNumber: 'DM-4712',
          displayName: 'Drive Motor',
          description: null,
          crossReferences: [],
          imageSourcePath: null,
        },
      },
      {
        kind: 'bom_entry',
        clientId: 'bom-ft90-dm4712',
        confidence: 1,
        sourceFiles: [],
        rationale: null,
        fromConvention: true,
        payload: {
          assetModelClientId: 'model-acme-ft90',
          partClientId: 'part-dm-4712',
          positionRef: 'M1',
          quantity: 1,
          notes: null,
        },
      },
      {
        kind: 'content_pack',
        clientId: 'pack-acme-ft90-base',
        confidence: 1,
        sourceFiles: [],
        rationale: null,
        fromConvention: true,
        payload: {
          assetModelClientId: 'model-acme-ft90',
          layerType: 'base',
          name: 'Acme FT90 — Base',
          slug: 'acme-ft90-base',
          basePackClientId: null,
        },
      },
      {
        kind: 'content_pack_version',
        clientId: 'pack-acme-ft90-base-v1',
        confidence: 1,
        sourceFiles: [],
        rationale: null,
        fromConvention: true,
        payload: {
          contentPackClientId: 'pack-acme-ft90-base',
          versionLabel: '1.0',
          changelog: null,
        },
      },
      {
        kind: 'document',
        clientId: 'doc-operator-manual',
        confidence: 1,
        sourceFiles: [],
        rationale: null,
        fromConvention: true,
        payload: {
          contentPackVersionClientId: 'pack-acme-ft90-base-v1',
          kind: 'pdf',
          title: 'Operator Manual',
          language: 'en',
          safetyCritical: false,
          tags: [],
          bodyMarkdown: null,
          sourcePath: 'Acme/FT-MERGE-90/docs/operator-manual.pdf',
          externalUrl: null,
          streamPlaybackId: null,
          thumbnailSourcePath: null,
        },
      },
      {
        kind: 'asset_instance',
        clientId: 'instance-ft001',
        confidence: 1,
        sourceFiles: [],
        rationale: null,
        fromConvention: true,
        payload: {
          assetModelClientId: 'model-acme-ft90',
          siteClientId: 'site-memphis',
          serialNumber: 'FT-001',
          installedAt: null,
          pinnedContentPackVersionClientId: null,
        },
      },
      {
        kind: 'qr_code',
        clientId: 'qr-ft001',
        confidence: 1,
        sourceFiles: [],
        rationale: null,
        fromConvention: true,
        payload: {
          assetInstanceClientId: 'instance-ft001',
          label: null,
          preferredTemplateId: null,
        },
      },
      {
        kind: 'publish_version',
        clientId: 'publish-pack-acme-ft90-base-v1',
        confidence: 1,
        sourceFiles: [],
        rationale: null,
        fromConvention: true,
        payload: {
          contentPackVersionClientId: 'pack-acme-ft90-base-v1',
          publish: true,
        },
      },
    ],
  });
}

describe('executeProposal', () => {
  it('creates every node end-to-end and returns resolved ids', async () => {
    const state = fresh();
    const client = buildMockClient(state);
    const tree = smallTree();
    const steps: StepRecord[] = [];

    const result = await executeProposal({
      proposalId: 'proposal-1',
      tree,
      client,
      ledger: () => null,
      onStep: async (s) => {
        steps.push(s);
      },
    });

    expect(result.stepsFailed).toBe(0);
    expect(state.organizations.size).toBe(1);
    expect(state.sites.size).toBe(1);
    expect(state.assetModels.size).toBe(1);
    expect(state.parts.size).toBe(1);
    expect(state.bom.size).toBe(1);
    expect(state.packs.size).toBe(1);
    expect(state.versions.size).toBe(1);
    expect(state.documents.size).toBe(1);
    expect(state.instances.size).toBe(1);
    expect(state.qrCodes.size).toBe(1);
    const v = [...state.versions.values()][0]!;
    expect(v.status).toBe('published');

    // Resolved map covers all client ids that produced an id.
    expect(result.resolved.has('oem-acme')).toBe(true);
    expect(result.resolved.has('instance-ft001')).toBe(true);

    // Every step transitions in_progress → succeeded/skipped (we observe one
    // entry per terminal state plus one in_progress per node).
    const terminal = steps.filter(
      (s) => s.status === 'succeeded' || s.status === 'skipped_existing',
    );
    expect(terminal.length).toBe(tree.nodes.length);
  });

  it('reuses the auto-created draft version instead of double-creating', async () => {
    const state = fresh();
    const client = buildMockClient(state);
    const tree = smallTree();
    await executeProposal({
      proposalId: 'p1',
      tree,
      client,
      ledger: () => null,
      onStep: async () => {},
    });
    // createContentPack already produces a draft version; the
    // content_pack_version node should NOT result in a second
    // createContentPackVersion call.
    expect(state.callCount.createContentPack).toBe(1);
    expect(state.callCount.createContentPackVersion ?? 0).toBe(0);
    expect(state.versions.size).toBe(1);
  });

  it('skips nodes that already have a succeeded ledger entry (resume)', async () => {
    const state = fresh();
    const client = buildMockClient(state);
    const tree = smallTree();

    // Pre-fill ledger with success records for the org + site + model so
    // those skip on resume — we still need to provide their target_ids so
    // downstream nodes can resolve.
    const ledger = new Map<string, StepRecord>([
      [
        'agent:p1:organization:oem-acme',
        {
          clientToken: 'agent:p1:organization:oem-acme',
          kind: 'organization',
          clientId: 'oem-acme',
          status: 'succeeded',
          targetId: 'preexisting-org-id',
          notes: null,
          error: null,
        },
      ],
    ]);
    // Pre-seed the org so dedup works for downstream ops; we don't actually
    // use it in mocks because the resolved-map logic uses targetId from the
    // ledger.
    state.organizations.set('preexisting-org-id', {
      id: 'preexisting-org-id',
      name: 'Acme',
      oemCode: 'ACME',
      parentId: null,
    });

    await executeProposal({
      proposalId: 'p1',
      tree,
      client,
      ledger: (token) => ledger.get(token) ?? null,
      onStep: async () => {},
    });
    expect(state.callCount.createOrganization ?? 0).toBe(0);
  });

  it('dedupes against existing entities by natural key', async () => {
    const state = fresh();
    const client = buildMockClient(state);
    const tree = smallTree();
    // Pre-seed an existing OEM that the executor should match by oemCode.
    state.organizations.set('preexisting-org-id', {
      id: 'preexisting-org-id',
      name: 'Acme',
      oemCode: 'ACME',
      parentId: null,
    });

    await executeProposal({
      proposalId: 'p1',
      tree,
      client,
      ledger: () => null,
      onStep: async () => {},
    });
    // No new org row.
    expect(state.organizations.size).toBe(1);
    expect(state.callCount.createOrganization ?? 0).toBe(0);
    // Downstream still creates the model, etc.
    expect(state.assetModels.size).toBe(1);
  });

  it('records failures and continues the rest of the plan', async () => {
    const state = fresh();
    const client = buildMockClient(state);
    state.throwOn = new Set(['createPart']);
    const tree = smallTree();

    const result = await executeProposal({
      proposalId: 'p1',
      tree,
      client,
      ledger: () => null,
      onStep: async () => {},
    });
    expect(result.stepsFailed).toBeGreaterThan(0);
    // Org/site/model/pack still created.
    expect(state.organizations.size).toBe(1);
    expect(state.assetModels.size).toBe(1);
    // Part throws → BOM entry can't resolve part ref → that one fails too.
    expect(state.parts.size).toBe(0);
  });

  it('only publishes when publish_version.publish === true', async () => {
    const state = fresh();
    const client = buildMockClient(state);
    const tree = smallTree();
    // Flip publish off.
    const off = ProposalTreeSchema.parse({
      ...tree,
      nodes: tree.nodes.map((n) => {
        if (n.kind !== 'publish_version') return n;
        return {
          ...n,
          payload: { ...n.payload, publish: false },
        };
      }),
    });
    await executeProposal({
      proposalId: 'p1',
      tree: off,
      client,
      ledger: () => null,
      onStep: async () => {},
    });
    expect(state.callCount.publishContentPackVersion ?? 0).toBe(0);
    const v = [...state.versions.values()][0]!;
    expect(v.status).toBe('draft');
  });
});
