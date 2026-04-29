// Pure helper that turns an OrganizationSummary into a typed step list for
// the SetupStatusCard. Decoupled from React/DOM so it's unit-testable in
// isolation.
//
// Step order (fixed, plan-driven):
//   1 organization        — done by virtue of being on the page
//   2 site                — needs siteCount > 0
//   3 asset_model         — OEM-tier only; needs assetModelCount > 0
//   4 parts_bom           — optional; needs parts AND bom entries; blocked by asset_model
//   5 content_published   — OEM-tier only; needs ≥ 1 published version; blocked by asset_model
//   6 asset_instance      — needs ≥ 1 instance; blocked by site AND asset_model
//   7 qr_code             — needs ≥ 1 active QR code; blocked by asset_instance
//
// "Required" varies by tenant type. End-customer / dealer skip the
// authoring steps.

import type { OrganizationSummary } from './api';

export type SetupStepId =
  | 'organization'
  | 'site'
  | 'asset_model'
  | 'parts_bom'
  | 'content_published'
  | 'asset_instance'
  | 'qr_code';

export type SetupStepStatus =
  | 'done'              // ✓
  | 'pending'           // ☐ — required, not done, not blocked
  | 'optional_pending'  // ◯ — optional, not done
  | 'blocked'           // 🔒 — required, not done, prerequisites missing
  | 'skipped';          // not applicable to this tenant.type — hidden from UI

export interface SetupStep {
  id: SetupStepId;
  label: string;
  status: SetupStepStatus;
  /** True when the step counts toward "complete" for this tenant. */
  required: boolean;
  /** Single short line under the label, e.g. "1 site • Memphis DC". */
  detail: string | null;
  /** Why this step is blocked, if status === 'blocked'. */
  blockedReason?: string;
  /**
   * URL to go to when admin clicks "Continue setup". May be null if the step
   * is satisfied inline on the tenant detail page (i.e. site, organization).
   * The caller resolves null = scroll-to-section.
   */
  continueHref: string | null;
  /** Anchor / fragment id on the tenant detail page that this step lives on. */
  anchor: string | null;
}

export interface SetupStatus {
  steps: SetupStep[];
  /** done count over required count (visible steps only). */
  completion: { done: number; total: number; percent: number };
  /** First step that's still pending or blocked — what the "Continue" CTA points at. */
  nextStep: SetupStep | null;
}

const REQUIRED_BY_TYPE: Record<
  OrganizationSummary['organization']['type'],
  Set<SetupStepId>
> = {
  oem: new Set([
    'organization',
    'site',
    'asset_model',
    // parts_bom intentionally omitted — optional
    'content_published',
    'asset_instance',
    'qr_code',
  ]),
  dealer: new Set([
    'organization',
    'site',
    'content_published',
    'asset_instance',
    'qr_code',
  ]),
  integrator: new Set([
    'organization',
    'site',
    'content_published',
    'asset_instance',
    'qr_code',
  ]),
  end_customer: new Set(['organization', 'site', 'asset_instance', 'qr_code']),
};

const VISIBLE_BY_TYPE: Record<
  OrganizationSummary['organization']['type'],
  Set<SetupStepId>
> = {
  oem: new Set([
    'organization',
    'site',
    'asset_model',
    'parts_bom',
    'content_published',
    'asset_instance',
    'qr_code',
  ]),
  dealer: new Set([
    'organization',
    'site',
    'asset_model', // dealers can overlay; show but mark optional
    'content_published',
    'asset_instance',
    'qr_code',
  ]),
  integrator: new Set([
    'organization',
    'site',
    'asset_model',
    'content_published',
    'asset_instance',
    'qr_code',
  ]),
  end_customer: new Set(['organization', 'site', 'asset_instance', 'qr_code']),
};

export function computeSetupStatus(summary: OrganizationSummary): SetupStatus {
  const type = summary.organization.type;
  const requiredFor = REQUIRED_BY_TYPE[type];
  const visibleFor = VISIBLE_BY_TYPE[type];
  const orgId = summary.organization.id;

  const isDone = (id: SetupStepId): boolean => {
    switch (id) {
      case 'organization':
        return true;
      case 'site':
        return summary.siteCount > 0;
      case 'asset_model':
        return summary.assetModelCount > 0;
      case 'parts_bom':
        return summary.partCount > 0 && summary.bomEntryCount > 0;
      case 'content_published':
        return summary.contentPackVersionPublishedCount > 0;
      case 'asset_instance':
        return summary.assetInstanceCount > 0;
      case 'qr_code':
        return summary.qrCodeCount > 0;
    }
  };

  const detailFor = (id: SetupStepId): string | null => {
    switch (id) {
      case 'organization':
        return `${formatType(type)} created`;
      case 'site': {
        if (summary.siteCount === 0) return null;
        const names = summary.siteSample.slice(0, 2).map((s) => s.name).join(', ');
        const extra = summary.siteCount > 2 ? `, +${summary.siteCount - 2} more` : '';
        return `${summary.siteCount} site${summary.siteCount === 1 ? '' : 's'} • ${names}${extra}`;
      }
      case 'asset_model': {
        if (summary.assetModelCount === 0) return null;
        const names = summary.assetModelSample
          .slice(0, 2)
          .map((m) => m.modelCode)
          .join(', ');
        const extra =
          summary.assetModelCount > 2 ? `, +${summary.assetModelCount - 2} more` : '';
        return `${summary.assetModelCount} model${
          summary.assetModelCount === 1 ? '' : 's'
        } • ${names}${extra}`;
      }
      case 'parts_bom':
        if (summary.partCount === 0) return null;
        return `${summary.partCount} part${summary.partCount === 1 ? '' : 's'}, ${
          summary.bomEntryCount
        } BOM entr${summary.bomEntryCount === 1 ? 'y' : 'ies'}`;
      case 'content_published': {
        if (summary.contentPackVersionPublishedCount > 0) {
          return `${summary.contentPackVersionPublishedCount} published, ${summary.contentPackVersionDraftCount} draft`;
        }
        if (summary.contentPackVersionDraftCount > 0) {
          return `${summary.contentPackVersionDraftCount} draft (publish to complete)`;
        }
        if (summary.contentPackCount > 0) {
          return `${summary.contentPackCount} pack, no versions yet`;
        }
        return null;
      }
      case 'asset_instance':
        if (summary.assetInstanceCount === 0) return null;
        return `${summary.assetInstanceCount} instance${
          summary.assetInstanceCount === 1 ? '' : 's'
        } deployed`;
      case 'qr_code':
        if (summary.qrCodeCount === 0) return null;
        return `${summary.qrCodeCount} QR code${summary.qrCodeCount === 1 ? '' : 's'} active`;
    }
  };

  const labelFor = (id: SetupStepId): string => {
    switch (id) {
      case 'organization':
        return 'Organization created';
      case 'site':
        return 'Add a site';
      case 'asset_model':
        return 'Add an asset model';
      case 'parts_bom':
        return 'Catalog parts and BOM';
      case 'content_published':
        return 'Publish a content pack';
      case 'asset_instance':
        return 'Deploy an asset instance';
      case 'qr_code':
        return 'Mint QR codes';
    }
  };

  const blockedReason = (id: SetupStepId): string | undefined => {
    switch (id) {
      case 'parts_bom':
        if (!isDone('asset_model')) return 'requires asset model';
        return undefined;
      case 'content_published':
        if (!isDone('asset_model')) return 'requires asset model';
        return undefined;
      case 'asset_instance': {
        const missing: string[] = [];
        if (!isDone('site')) missing.push('site');
        if (!isDone('asset_model') && type !== 'end_customer') missing.push('asset model');
        return missing.length ? `requires ${missing.join(' + ')}` : undefined;
      }
      case 'qr_code':
        if (!isDone('asset_instance')) return 'requires asset instance';
        return undefined;
      default:
        return undefined;
    }
  };

  const continueHrefFor = (id: SetupStepId): string | null => {
    switch (id) {
      case 'organization':
      case 'site':
        return null; // both live on the tenant detail page itself (scroll-to-section)
      case 'asset_model':
        return `/asset-models?continue=${orgId}`;
      case 'parts_bom':
        return `/parts?continue=${orgId}`;
      case 'content_published':
        return `/content-packs?continue=${orgId}`;
      case 'asset_instance': {
        // Easiest entry: the first model's detail page, where Add Instance lives.
        const firstModel = summary.assetModelSample[0];
        if (firstModel) {
          return `/asset-models/${firstModel.id}?continue=${orgId}`;
        }
        return `/asset-models?continue=${orgId}`;
      }
      case 'qr_code':
        return `/qr-codes?continue=${orgId}`;
    }
  };

  const anchorFor = (id: SetupStepId): string | null => {
    switch (id) {
      case 'organization':
        return 'tenant-summary';
      case 'site':
        return 'sites';
      default:
        return null;
    }
  };

  const allIds: SetupStepId[] = [
    'organization',
    'site',
    'asset_model',
    'parts_bom',
    'content_published',
    'asset_instance',
    'qr_code',
  ];

  const steps: SetupStep[] = allIds.map((id) => {
    const visible = visibleFor.has(id);
    const required = requiredFor.has(id);
    if (!visible) {
      return {
        id,
        label: labelFor(id),
        status: 'skipped',
        required: false,
        detail: null,
        continueHref: null,
        anchor: anchorFor(id),
      };
    }
    if (isDone(id)) {
      return {
        id,
        label: labelFor(id),
        status: 'done',
        required,
        detail: detailFor(id),
        continueHref: null,
        anchor: anchorFor(id),
      };
    }
    const reason = blockedReason(id);
    if (reason) {
      return {
        id,
        label: labelFor(id),
        status: 'blocked',
        required,
        detail: detailFor(id),
        blockedReason: reason,
        continueHref: null,
        anchor: anchorFor(id),
      };
    }
    return {
      id,
      label: labelFor(id),
      status: required ? 'pending' : 'optional_pending',
      required,
      detail: detailFor(id),
      continueHref: continueHrefFor(id),
      anchor: anchorFor(id),
    };
  });

  const visibleSteps = steps.filter((s) => s.status !== 'skipped');
  const requiredSteps = visibleSteps.filter((s) => s.required);
  const doneRequired = requiredSteps.filter((s) => s.status === 'done').length;
  const total = requiredSteps.length;
  const percent = total === 0 ? 100 : Math.round((doneRequired / total) * 100);

  // First non-skipped, non-done step (pending or blocked or optional_pending).
  const nextStep =
    visibleSteps.find((s) => s.status === 'pending') ??
    visibleSteps.find((s) => s.status === 'optional_pending') ??
    visibleSteps.find((s) => s.status === 'blocked') ??
    null;

  return {
    steps: visibleSteps,
    completion: { done: doneRequired, total, percent },
    nextStep,
  };
}

function formatType(type: OrganizationSummary['organization']['type']): string {
  switch (type) {
    case 'oem':
      return 'OEM organization';
    case 'dealer':
      return 'Dealer';
    case 'integrator':
      return 'Integrator';
    case 'end_customer':
      return 'End-customer';
  }
}

/**
 * Maps a step id to the next step id for "Save & continue setup" redirects.
 * After saving an asset model, the next thing to do is content_published (for
 * OEMs) or asset_instance (skipping authoring for dealers/integrators).
 *
 * Returns null when the saved step has no clear successor — caller falls
 * back to redirecting to the tenant detail without a `?step` highlight.
 */
export function nextStepAfterSave(
  saved: SetupStepId,
  type: OrganizationSummary['organization']['type'],
): SetupStepId | null {
  const visible = VISIBLE_BY_TYPE[type];
  const order: SetupStepId[] = [
    'organization',
    'site',
    'asset_model',
    'parts_bom',
    'content_published',
    'asset_instance',
    'qr_code',
  ];
  const idx = order.indexOf(saved);
  for (let i = idx + 1; i < order.length; i++) {
    if (visible.has(order[i]!)) return order[i]!;
  }
  return null;
}
