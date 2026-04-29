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
  it('OEM with empty state: org done, site pending, others blocked', () => {
    const s = computeSetupStatus(summary());
    const byId = new Map(s.steps.map((x) => [x.id, x]));
    expect(byId.get('organization')!.status).toBe('done');
    expect(byId.get('site')!.status).toBe('pending');
    expect(byId.get('asset_model')!.status).toBe('pending');
    // parts_bom blocked because asset_model not done
    expect(byId.get('parts_bom')!.status).toBe('blocked');
    expect(byId.get('parts_bom')!.required).toBe(false);
    expect(byId.get('content_published')!.status).toBe('blocked');
    expect(byId.get('asset_instance')!.status).toBe('blocked');
    expect(byId.get('qr_code')!.status).toBe('blocked');
    expect(s.completion).toEqual({ done: 1, total: 6, percent: 17 });
    expect(s.nextStep?.id).toBe('site');
  });

  it('OEM with site + model: parts/BOM unblocked as optional, content/instance pending', () => {
    const s = computeSetupStatus(
      summary({
        siteCount: 1,
        siteSample: [{ id: 's1', name: 'Memphis DC' }],
        assetModelCount: 1,
        assetModelSample: [{ id: 'm1', modelCode: 'C-SQ-40', displayName: 'C-SQ-40' }],
      }),
    );
    const byId = new Map(s.steps.map((x) => [x.id, x]));
    expect(byId.get('organization')!.status).toBe('done');
    expect(byId.get('site')!.status).toBe('done');
    expect(byId.get('asset_model')!.status).toBe('done');
    expect(byId.get('parts_bom')!.status).toBe('optional_pending');
    expect(byId.get('content_published')!.status).toBe('pending');
    expect(byId.get('asset_instance')!.status).toBe('pending');
    expect(byId.get('qr_code')!.status).toBe('blocked');
    expect(s.completion).toEqual({ done: 3, total: 6, percent: 50 });
    // Next non-done required step is content_published.
    expect(s.nextStep?.id).toBe('content_published');
  });

  it('OEM fully set up: 100% complete', () => {
    const s = computeSetupStatus(
      summary({
        siteCount: 2,
        siteSample: [
          { id: 's1', name: 'Memphis DC' },
          { id: 's2', name: 'Atlanta DC' },
        ],
        assetModelCount: 1,
        assetModelSample: [{ id: 'm1', modelCode: 'C-SQ-40', displayName: 'C-SQ-40' }],
        partCount: 12,
        bomEntryCount: 12,
        contentPackVersionPublishedCount: 1,
        contentPackVersionDraftCount: 0,
        documentCount: 24,
        assetInstanceCount: 5,
        qrCodeCount: 5,
      }),
    );
    expect(s.completion.percent).toBe(100);
    expect(s.steps.every((step) => step.status === 'done')).toBe(true);
    expect(s.nextStep).toBeNull();
  });

  it('OEM with content_pack draft only: content_published is pending, not done', () => {
    const s = computeSetupStatus(
      summary({
        siteCount: 1,
        siteSample: [{ id: 's1', name: 'Memphis DC' }],
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

  it('end_customer hides asset_model, content, parts_bom from visible steps', () => {
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
    // No models needed for asset_instance step on end_customer.
    const inst = s.steps.find((x) => x.id === 'asset_instance')!;
    expect(inst.status).toBe('blocked');
    expect(inst.blockedReason).toContain('site');
    expect(inst.blockedReason).not.toContain('model');
  });

  it('dealer requires content_published but flags asset_model as optional-visible', () => {
    const s = computeSetupStatus(
      summary({
        organization: {
          id: 'org-3',
          name: 'Bastian',
          type: 'dealer',
          oemCode: null,
          createdAt: '2026-01-01T00:00:00Z',
        },
      }),
    );
    const am = s.steps.find((x) => x.id === 'asset_model')!;
    expect(am.required).toBe(false);
    expect(am.status).toBe('optional_pending');
    const cp = s.steps.find((x) => x.id === 'content_published')!;
    expect(cp.required).toBe(true);
  });

  it('continue href for asset_instance points at the first model when one exists', () => {
    const s = computeSetupStatus(
      summary({
        siteCount: 1,
        siteSample: [{ id: 's1', name: 'Memphis DC' }],
        assetModelCount: 1,
        assetModelSample: [
          { id: 'model-uuid-123', modelCode: 'X', displayName: 'X' },
        ],
      }),
    );
    const inst = s.steps.find((x) => x.id === 'asset_instance')!;
    expect(inst.continueHref).toBe('/asset-models/model-uuid-123?continue=org-1');
  });

  it('detail string formats counts and includes sample names', () => {
    const s = computeSetupStatus(
      summary({
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

  it('content_published -> asset_instance for OEM', () => {
    expect(nextStepAfterSave('content_published', 'oem')).toBe('asset_instance');
  });

  it('end_customer skips asset_model, parts_bom, content_published', () => {
    expect(nextStepAfterSave('site', 'end_customer')).toBe('asset_instance');
  });

  it('returns null after the last step', () => {
    expect(nextStepAfterSave('qr_code', 'oem')).toBeNull();
  });
});
