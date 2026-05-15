'use client';

// First-run wizard. Triggered with ?wizard=1 (set by the org picker
// right after createOrganization succeeds). Walks the admin through the
// minimum-viable bootstrap for the new org without making them dig
// through the sidebar. Each step is skippable; progress is computed
// from the live OrganizationSummary so re-opening the wizard later
// picks up where things actually stand.
//
// Design intent: this is a *guided* alternative to the persistent
// SetupStatusCard. The card is always there; the wizard is a denser,
// modal-style flow for the moment of "I just made this org and have
// no idea what to do next."

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  Boxes,
  Bot,
  Building2,
  Check,
  CheckCircle2,
  ChevronRight,
  FileStack,
  MapPin,
  QrCode,
  Sparkles,
  Tag,
  X,
  type LucideIcon,
} from 'lucide-react';
import { FullPageOverlay } from '@/components/form';
import type { AdminOrganization, OrganizationSummary } from '@/lib/api';

interface WizardStep {
  id:
    | 'organization'
    | 'site'
    | 'agent_or_models'
    | 'asset_model'
    | 'content_pack'
    | 'asset_instance'
    | 'qr_code';
  title: string;
  body: string;
  icon: LucideIcon;
  done: boolean;
  cta: { label: string; href: string } | null;
  skipReason?: string;
}

interface Props {
  orgId: string;
  org: AdminOrganization;
  sites: Array<{ id: string }>;
  summary: OrganizationSummary;
  onRefresh: () => Promise<void>;
}

export function FirstRunWizard({
  orgId,
  org,
  sites,
  summary,
}: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [currentIdx, setCurrentIdx] = useState(0);

  const steps: WizardStep[] = useMemo(
    () => buildSteps(orgId, org, sites, summary),
    [orgId, org, sites, summary],
  );

  // When the user satisfies a step in another tab and comes back, jump
  // them to the first not-yet-done step rather than leaving them stuck.
  useEffect(() => {
    const firstUndone = steps.findIndex((s) => !s.done);
    if (firstUndone === -1) return;
    setCurrentIdx((idx) => (idx >= firstUndone ? idx : firstUndone));
  }, [steps]);

  function close() {
    const params = new URLSearchParams(searchParams?.toString() ?? '');
    params.delete('wizard');
    const qs = params.toString();
    router.replace(`/orgs/${orgId}${qs ? `?${qs}` : ''}`);
  }

  const total = steps.length;
  const done = steps.filter((s) => s.done).length;
  const allDone = done === total;
  const current = steps[currentIdx];

  return (
    <FullPageOverlay
      open
      onClose={close}
      title={`Set up ${org.name}`}
      subtitle={
        allDone
          ? `All ${total} steps complete — close to enter the workspace.`
          : `Step ${currentIdx + 1} of ${total} · ${done}/${total} done`
      }
    >
      <div className="mx-auto flex h-full max-w-5xl gap-8 px-6 py-8 lg:px-10">
        {/* Left rail: step nav */}
        <ol className="flex w-72 shrink-0 flex-col gap-1.5">
          {steps.map((s, i) => {
            const Icon = s.icon;
            const active = i === currentIdx;
            return (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => setCurrentIdx(i)}
                  className="flex w-full items-center gap-3 rounded-md border px-3 py-2.5 text-left text-sm transition"
                  style={{
                    borderColor: active
                      ? 'rgb(var(--brand) / 0.45)'
                      : 'rgb(var(--line))',
                    background: active
                      ? 'rgb(var(--brand) / 0.06)'
                      : 'transparent',
                  }}
                >
                  <span
                    className={`grid h-7 w-7 shrink-0 place-items-center rounded-full ${
                      s.done
                        ? 'bg-signal-ok/15 text-signal-ok'
                        : active
                        ? 'bg-brand/15 text-brand'
                        : 'bg-surface-inset text-ink-tertiary'
                    }`}
                  >
                    {s.done ? (
                      <Check size={14} strokeWidth={2.5} />
                    ) : (
                      <Icon size={14} strokeWidth={2} />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-ink-primary">
                      {s.title}
                    </span>
                    {s.skipReason && !s.done && (
                      <span className="block truncate text-[11px] text-ink-tertiary">
                        Optional · {s.skipReason}
                      </span>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>

        {/* Right pane: current step body */}
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="mb-4 flex items-start justify-between gap-4">
            <div>
              <p className="caption mb-1">
                Step {currentIdx + 1} of {total}
              </p>
              <h2 className="text-2xl font-semibold text-ink-primary">
                {current?.title ?? 'Done'}
              </h2>
            </div>
            <button
              type="button"
              onClick={close}
              className="rounded p-1.5 text-ink-tertiary hover:bg-surface-inset hover:text-ink-primary"
              aria-label="Close wizard"
            >
              <X size={16} strokeWidth={2} />
            </button>
          </header>

          {allDone ? (
            <FinishedPanel orgId={orgId} onClose={close} />
          ) : current ? (
            <div className="flex flex-1 flex-col">
              <p className="mb-6 max-w-2xl text-base leading-relaxed text-ink-secondary">
                {current.body}
              </p>

              {current.done ? (
                <div className="mb-6 flex items-center gap-2 rounded-md border border-signal-ok/30 bg-signal-ok/10 p-3 text-sm text-signal-ok">
                  <CheckCircle2 size={16} strokeWidth={2} />
                  <span>This step is already complete.</span>
                </div>
              ) : null}

              <div className="flex flex-wrap items-center gap-3">
                {current.cta && !current.done && (
                  <Link
                    href={current.cta.href}
                    className="btn btn-primary"
                  >
                    {current.cta.label}
                    <ArrowRight size={14} strokeWidth={2} />
                  </Link>
                )}
                {current.done && (
                  <button
                    type="button"
                    onClick={() => setCurrentIdx((i) => Math.min(total - 1, i + 1))}
                    className="btn btn-primary"
                    disabled={currentIdx === total - 1}
                  >
                    Next step
                    <ChevronRight size={14} strokeWidth={2} />
                  </button>
                )}
                {!current.done && (
                  <button
                    type="button"
                    onClick={() => setCurrentIdx((i) => Math.min(total - 1, i + 1))}
                    className="btn btn-ghost"
                    disabled={currentIdx === total - 1}
                  >
                    Skip for now
                  </button>
                )}
              </div>

              {/* Helper sub-text */}
              <p className="mt-8 text-xs text-ink-tertiary">
                Tip: you can leave this wizard at any time — the same checklist
                stays available on the workspace overview page.
              </p>
            </div>
          ) : null}
        </div>
      </div>
    </FullPageOverlay>
  );
}

function FinishedPanel({ orgId, onClose }: { orgId: string; onClose: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-start justify-center gap-5 max-w-xl">
      <div className="grid h-12 w-12 place-items-center rounded-full bg-signal-ok/15 text-signal-ok">
        <Sparkles size={20} strokeWidth={2} />
      </div>
      <div>
        <h3 className="text-2xl font-semibold text-ink-primary">All set.</h3>
        <p className="mt-2 text-base text-ink-secondary">
          The minimum-viable setup is done. Field techs can now scan the QR
          codes you minted to open this customer's equipment in the PWA.
        </p>
      </div>
      <div className="flex gap-3">
        <button onClick={onClose} className="btn btn-primary">
          Enter workspace
        </button>
        <Link href={`/orgs/${orgId}/qr-codes`} className="btn btn-secondary">
          View QR codes
        </Link>
      </div>
    </div>
  );
}

function buildSteps(
  orgId: string,
  org: AdminOrganization,
  sites: Array<{ id: string }>,
  summary: OrganizationSummary,
): WizardStep[] {
  const base = `/orgs/${orgId}`;
  const isAuthoring =
    org.type === 'oem' || org.type === 'dealer' || org.type === 'integrator';
  const isDeployment = org.type === 'end_customer';

  const all: WizardStep[] = [
    {
      id: 'organization',
      title: 'Organization created',
      body: `${org.name} is in the system as ${formatType(org.type)}. We'll bootstrap it from here so the field side has something to look at.`,
      icon: Building2,
      done: true,
      cta: null,
    },
    {
      id: 'site',
      title: 'Add the first site',
      body:
        org.type === 'oem'
          ? 'Sites are physical locations that host equipment. OEMs usually skip this — equipment lives at customer sites under separate organizations. Add a site only if you have pre-deployment units (factory floor, demo unit, showroom).'
          : org.type === 'integrator'
          ? "Sites are physical locations that host equipment. As an integrator you might have a staging or commissioning facility — add it. Otherwise sites usually live on the end-customer organizations you install for."
          : 'Sites are physical locations where equipment lives. Add at least one — every serial-numbered piece of equipment must belong to a site.',
      icon: MapPin,
      done: sites.length > 0,
      cta: { label: 'Add a site', href: `${base}#sites-section` },
      skipReason: isAuthoring ? 'Sites usually live on customer orgs' : undefined,
    },
    {
      id: 'agent_or_models',
      title: 'Bulk-import with the agent (optional)',
      body:
        'Skip the rest of the wizard by handing the AI agent the customer\'s existing equipment list (a folder of PDFs, spreadsheets, photos). It proposes a tree of asset models, parts, content packs, and instances; you review and publish. Best for big customers with lots of legacy paper. Otherwise skip and create things by hand.',
      icon: Bot,
      done: false,
      cta: { label: 'Open agent', href: `${base}/agent` },
      skipReason: 'Faster than entering everything by hand',
    },
    {
      id: 'asset_model',
      title: 'Register an asset model',
      body:
        'An asset model is a SKU — one row per piece of equipment that gets manufactured. Field techs scan an instance of a model; the model anchors all of its parts, manuals, and procedures. You need at least one before you can do much else.',
      icon: Boxes,
      done: summary.assetModelCount > 0,
      cta: { label: 'Add asset model', href: `${base}/asset-models` },
      skipReason: !isAuthoring
        ? 'You typically reference models from an upstream OEM'
        : undefined,
    },
    {
      id: 'content_pack',
      title: 'Publish a content pack',
      body:
        'Content packs are bundles of documents, training, and procedures attached to an asset model. Until at least one version is published, scanned QR codes show empty asset hubs. Authoring tenants (OEMs, integrators, dealers) typically own this step.',
      icon: FileStack,
      done: summary.contentPackVersionPublishedCount > 0,
      cta: { label: 'Manage content packs', href: `${base}/content-packs` },
      skipReason: !isAuthoring
        ? 'Content typically comes from upstream OEM'
        : undefined,
    },
    {
      id: 'asset_instance',
      title: 'Deploy the first asset instance',
      body:
        'An asset instance is a real, serial-numbered unit at a real site. This is what QR codes will physically point at. Without instances, there\'s nothing for techs to scan.',
      icon: Tag,
      done: summary.assetInstanceCount > 0,
      cta: { label: 'Add asset instance', href: `${base}/asset-models` },
      skipReason: isAuthoring ? 'Instances usually live on customer orgs' : undefined,
    },
    {
      id: 'qr_code',
      title: 'Mint a QR code',
      body:
        "QR codes are short opaque links. A tech scans a sticker → the PWA opens the right asset hub instantly. Mint at least one and print it; this is the moment the system becomes useful in the real world.",
      icon: QrCode,
      done: summary.qrCodeCount > 0,
      cta: { label: 'Mint QR code', href: `${base}/qr-codes` },
      skipReason: isAuthoring ? 'QR codes live on customer-facing instances' : undefined,
    },
  ];

  // Filter out steps that don't apply to this tenant type. Authoring
  // tenants generally don't host instances/QR codes (those live at
  // their downstream customers); deployment tenants don't author
  // models / content (they consume from upstream OEMs).
  return all.filter((s) => {
    if (s.id === 'site' && org.type === 'oem') return false;
    if ((s.id === 'asset_model' || s.id === 'content_pack') && isDeployment)
      return false;
    if ((s.id === 'asset_instance' || s.id === 'qr_code') && isAuthoring)
      return false;
    return true;
  });
}

function formatType(type: AdminOrganization['type']): string {
  switch (type) {
    case 'oem':
      return 'an OEM';
    case 'dealer':
      return 'a dealer';
    case 'integrator':
      return 'an integrator';
    case 'end_customer':
      return 'an end-customer';
  }
}
