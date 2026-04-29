import { describe, expect, it } from 'vitest';
import { computeSetupStatus, nextStepAfterSave } from './setup-status';
import type { OrganizationSummary } from './api';

function summary(overrides: Partial<OrganizationSummary> = {}): OrganizationSummary {
  return {
    organization: {
      id: 'org-1',
      name: 'Acme',
      type: 'oem',
      oemCode: 'ACME',
      createdAt: '2026-01-01T00:00:00Z',
      ...(overrides.organization ?? {}),
    },
    siteCount: 0,
    siteSample: [],
    assetModelCount: 0,
    assetModelSample: [],
    partCount: 0,
    bomEntryCount: 0,
    contentPackCount: 0,
    contentPackVersionPublishedCount: 0,
    contentPackVersionDraftCount: 0,
    documentCount: 0,
    trainingModuleCount: 0,
    assetInstanceCount: 0,
    qrCodeCount: 0,
    ...overrides,
  };
}

describe('computeSetupStatus', () => {
  it('OEM empty state: only authoring steps visible; site/instance/qr hidden', () => {
    const s = computeSetupStatus(summary());
    const ids = s.steps.map((x) => x.id);
    // Site, asset_instance, and qr_code are not relevant for an OEM (pure
    // authoring tenant). Visible = org, asset_model, parts_bom, content.
    expect(ids).toEqual(['organization', 'asset_model', 'parts_bom', 'content_published']);
    const byId = new Map(s.steps.map((x) => [x.id, x]));
    expect(byId.get('organization')!.status).toBe('done');
    expect(byId.get('asset_model')!.status).toBe('pending');
    expect(byId.get('parts_bom')!.status).toBe('blocked');
    expect(byId.get('parts_bom')!.required).toBe(false);
    expect(byId.get('content_published')!.status).toBe('blocked');
    // 1 of 3 required (org/asset_model/content_published) done.
    expect(s.completion).toEqual({ done: 1, total: 3, percent: 33 });
    expect(s.nextStep?.id).toBe('asset_model');
  });

  it('OEM with model: parts_bom unblocked as optional, content_published pending', () => {
    const s = computeSetupStatus(
      summary({
        assetModelCount: 1,
        assetModelSample: [{ id: 'm1', modelCode: 'C-SQ-40', displayName: 'C-SQ-40' }],
      }),
    );
    const byId = new Map(s.steps.map((x) => [x.id, x]));
    expect(byId.get('asset_model')!.status).toBe('done');
    expect(byId.get('parts_bom')!.status).toBe('optional_pending');
    expect(byId.get('content_published')!.status).toBe('pending');
    expect(s.completion).toEqual({ done: 2, total: 3, percent: 67 });
    expect(s.nextStep?.id).toBe('content_published');
  });

  it('OEM fully set up: 100% (parts/BOM optional)', () => {
    const s = computeSetupStatus(
      summary({
        assetModelCount: 1,
        assetModelSample: [{ id: 'm1', modelCode: 'C-SQ-40', displayName: 'C-SQ-40' }],
        contentPackVersionPublishedCount: 1,
        contentPackVersionDraftCount: 0,
        documentCount: 24,
      }),
    );
    expect(s.completion.percent).toBe(100);
    // Required steps all done; parts_bom remains optional_pending — that's
    // fine, it doesn't drag the percentage.
    const required = s.steps.filter((step) => step.required);
    expect(required.every((step) => step.status === 'done')).toBe(true);
    expect(s.nextStep?.id).toBe('parts_bom'); // optional next-up
  });

  it('OEM with content_pack draft only: content_published is pending, not done', () => {
    const s = computeSetupStatus(
      summary({
        assetModelCount: 1,
        assetModelSample: [{ id: 'm1', modelCode: 'X', displayName: 'X' }],
        contentPackCount: 1,
        contentPackVersionPublishedCount: 0,
        contentPackVersionDraftCount: 1,
        documentCount: 5,
      }),
    );
    const cp = s.steps.find((x) => x.id === 'content_published')!;
    expect(cp.status).toBe('pending');
    expect(cp.detail).toContain('draft');
  });

  it('end_customer hides authoring steps; only deployment steps visible', () => {
    const s = computeSetupStatus(
      summary({
        organization: {
          id: 'org-2',
          name: 'FedEx',
          type: 'end_customer',
          oemCode: null,
          createdAt: '2026-01-01T00:00:00Z',
        },
      }),
    );
    const ids = s.steps.map((x) => x.id);
    expect(ids).toEqual(['organization', 'site', 'asset_instance', 'qr_code']);
    // Asset instance only requires a site for end_customers (the model is
    // owned by a separate OEM org and resolved at form time).
    const inst = s.steps.find((x) => x.id === 'asset_instance')!;
    expect(inst.status).toBe('blocked');
    expect(inst.blockedReason).toContain('site');
    expect(inst.blockedReason).not.toContain('model');
  });

  it('integrator hides site/instance/qr; content_published is required, asset_model optional', () => {
    const s = computeSetupStatus(
      summary({
        organization: {
          id: 'org-3',
          name: 'DMW&H',
          type: 'integrator',
          oemCode: null,
          createdAt: '2026-01-01T00:00:00Z',
        },
      }),
    );
    const ids = s.steps.map((x) => x.id);
    expect(ids).toEqual(['organization', 'asset_model', 'content_published']);
    const am = s.steps.find((x) => x.id === 'asset_model')!;
    expect(am.required).toBe(false);
    const cp = s.steps.find((x) => x.id === 'content_published')!;
    expect(cp.required).toBe(true);
    // 1 of 2 required (org + content_published) done.
    expect(s.completion).toEqual({ done: 1, total: 2, percent: 50 });
  });

  it('dealer behaves like integrator', () => {
    const s = computeSetupStatus(
      summary({
        organization: {
          id: 'org-4',
          name: 'Acme Sales',
          type: 'dealer',
          oemCode: null,
          createdAt: '2026-01-01T00:00:00Z',
        },
      }),
    );
    const ids = s.steps.map((x) => x.id);
    expect(ids).toEqual(['organization', 'asset_model', 'content_published']);
  });

  it('continue href for end_customer asset_instance points at the first model when one exists', () => {
    const s = computeSetupStatus(
      summary({
        organization: {
          id: 'org-5',
          name: 'FedEx',
          type: 'end_customer',
          oemCode: null,
          createdAt: '2026-01-01T00:00:00Z',
        },
        siteCount: 1,
        siteSample: [{ id: 's1', name: 'Memphis DC' }],
        // end_customers don't own models in their summary, but the picker
        // surfaces all models system-wide. The test still validates the
        // href shape when the summary happens to include sample models
        // (e.g. when admins query a hybrid scenario).
        assetModelCount: 1,
        assetModelSample: [{ id: 'model-uuid-123', modelCode: 'X', displayName: 'X' }],
      }),
    );
    const inst = s.steps.find((x) => x.id === 'asset_instance')!;
    expect(inst.continueHref).toBe('/asset-models/model-uuid-123?continue=org-5');
  });

  it('detail string formats counts and includes sample names', () => {
    const s = computeSetupStatus(
      summary({
        organization: {
          id: 'org-6',
          name: 'FedEx',
          type: 'end_customer',
          oemCode: null,
          createdAt: '2026-01-01T00:00:00Z',
        },
        siteCount: 3,
        siteSample: [
          { id: 'a', name: 'Memphis DC' },
          { id: 'b', name: 'Atlanta DC' },
          { id: 'c', name: 'Dallas DC' },
        ],
      }),
    );
    const site = s.steps.find((x) => x.id === 'site')!;
    expect(site.detail).toBe('3 sites • Memphis DC, Atlanta DC, +1 more');
  });
});

describe('nextStepAfterSave', () => {
  it('asset_model -> parts_bom for OEM (optional but visible/next)', () => {
    expect(nextStepAfterSave('asset_model', 'oem')).toBe('parts_bom');
  });

  it('parts_bom -> content_published for OEM', () => {
    expect(nextStepAfterSave('parts_bom', 'oem')).toBe('content_published');
  });

  it('content_published -> null for OEM (last visible step)', () => {
    expect(nextStepAfterSave('content_published', 'oem')).toBeNull();
  });

  it('end_customer skips asset_model, parts_bom, content_published', () => {
    expect(nextStepAfterSave('site', 'end_customer')).toBe('asset_instance');
  });

  it('end_customer asset_instance -> qr_code', () => {
    expect(nextStepAfterSave('asset_instance', 'end_customer')).toBe('qr_code');
  });

  it('returns null after the last step', () => {
    expect(nextStepAfterSave('qr_code', 'end_customer')).toBeNull();
  });

  it('integrator asset_model -> content_published', () => {
    expect(nextStepAfterSave('asset_model', 'integrator')).toBe('content_published');
  });
});
