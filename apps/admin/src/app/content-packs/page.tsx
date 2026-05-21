'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import {
  ChevronRight,
  FileStack,
  Layers,
  Package,
  Plus,
  Search,
} from 'lucide-react';
import { EmptyState } from '@/components/empty-state';
import { NextStepHint } from '@/components/next-step-hint';
import { TilesSkeleton } from '@/components/skeleton';
import { useToast } from '@/components/toast';
import { PageHeader, PageShell, Pill } from '@/components/page-shell';
import {
  Drawer,
  ErrorBanner,
  Field,
  PrimaryButton,
  SecondaryButton,
  Select,
  TextInput,
} from '@/components/form';
import {
  createContentPack,
  listAdminAssetModels,
  listContentPacks,
  listOrganizations,
  type AdminAssetModel,
  type AdminContentPack,
  type AdminOrganization,
} from '@/lib/api';
import { nextStepAfterSave } from '@/lib/setup-status';

const LAYER_TONE = {
  base: 'info',
  dealer_overlay: 'warning',
  site_overlay: 'default',
} as const;

const LAYER_LABEL = {
  base: 'Base',
  dealer_overlay: 'Dealer overlay',
  site_overlay: 'Site overlay',
} as const;

const STATUS_TONE = {
  draft: 'default',
  in_review: 'warning',
  published: 'success',
  archived: 'default',
} as const;

type LayerFilter = 'all' | 'base' | 'dealer_overlay' | 'site_overlay';

export default function ContentPacksPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const continueOrgId = searchParams?.get('continue') ?? null;
  const [rows, setRows] = useState<AdminContentPack[] | null>(null);
  const [models, setModels] = useState<AdminAssetModel[]>([]);
  const [continueOrg, setContinueOrg] = useState<AdminOrganization | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [layer, setLayer] = useState<LayerFilter>('all');

  async function refresh() {
    try {
      const [packs, mm, orgs] = await Promise.all([
        listContentPacks(),
        listAdminAssetModels(),
        continueOrgId ? listOrganizations() : Promise.resolve([] as AdminOrganization[]),
      ]);
      setRows(packs);
      setModels(mm);
      if (continueOrgId) {
        setContinueOrg(orgs.find((o) => o.id === continueOrgId) ?? null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [continueOrgId]);

  useEffect(() => {
    if (continueOrgId && models.length > 0) setOpen(true);
  }, [continueOrgId, models.length]);

  // Filter the model picker to this tenant's models when in continue mode.
  const modelsForPicker = continueOrgId
    ? models.filter((m) => m.owner.id === continueOrgId)
    : models;

  // Per-layer counts for the filter chips. Computed off the full row set so
  // the count of each chip is independent of the active filter (a common
  // expectation for facet filters).
  const layerCounts = useMemo(() => {
    const counts = { all: 0, base: 0, dealer_overlay: 0, site_overlay: 0 };
    for (const r of rows ?? []) {
      counts.all++;
      counts[r.layerType]++;
    }
    return counts;
  }, [rows]);

  // Visible rows after applying search + layer chip. Search hits name,
  // slug, asset model, and owner so the user can locate a pack by any of
  // the fields shown on the card.
  const visibleRows = useMemo(() => {
    if (rows === null) return null;
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (layer !== 'all' && r.layerType !== layer) return false;
      if (!q) return true;
      return (
        r.name.toLowerCase().includes(q) ||
        r.slug.toLowerCase().includes(q) ||
        r.assetModel.displayName.toLowerCase().includes(q) ||
        r.owner.toLowerCase().includes(q)
      );
    });
  }, [rows, query, layer]);

  return (
    <PageShell crumbs={[{ label: 'Content packs' }]}>
      <PageHeader
        title="Content packs"
        description="Versioned bundles of documents, training modules, and parts. OEM-authored base packs can be overlaid by dealers for site-specific variations."
        actions={
          <PrimaryButton onClick={() => setOpen(true)} disabled={models.length === 0}>
            <Plus size={14} strokeWidth={2} /> New content pack
          </PrimaryButton>
        }
      />
      <ErrorBanner error={error} />
      <NextStepHint page="content-packs" />
      {rows === null ? (
        <TilesSkeleton count={6} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={FileStack}
          title="No content packs yet"
          description="A content pack is the versioned bundle of documents, training, and parts for one asset model. Pick a model to start authoring."
          action={
            models.length > 0 ? (
              <PrimaryButton onClick={() => setOpen(true)}>
                <Plus size={14} strokeWidth={2} /> Create a pack
              </PrimaryButton>
            ) : undefined
          }
        />
      ) : (
        <div className="flex flex-col gap-5">
          {/* Toolbar — search input on the left, layer-facet chips on
              the right. Sticks to the top of the listing so the filter
              state is always visible while scrolling. */}
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <label className="relative block w-full max-w-md">
              <Search
                size={14}
                strokeWidth={2}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-tertiary"
              />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search packs, models, or owners"
                className="h-9 w-full rounded-md border border-line bg-surface-raised pl-9 pr-3 text-sm text-ink-primary placeholder:text-ink-tertiary focus:border-brand focus:outline-none"
              />
            </label>
            <div className="flex flex-wrap gap-1.5">
              {(['all', 'base', 'dealer_overlay', 'site_overlay'] as LayerFilter[]).map(
                (key) => {
                  const active = layer === key;
                  const label = key === 'all' ? 'All' : LAYER_LABEL[key];
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setLayer(key)}
                      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                        active
                          ? 'border-brand bg-brand/10 text-brand'
                          : 'border-line bg-surface-raised text-ink-secondary hover:border-line-strong hover:text-ink-primary'
                      }`}
                    >
                      <span>{label}</span>
                      <span
                        className={`tabular-nums ${
                          active ? 'text-brand' : 'text-ink-tertiary'
                        }`}
                      >
                        {layerCounts[key]}
                      </span>
                    </button>
                  );
                },
              )}
            </div>
          </div>

          {visibleRows && visibleRows.length === 0 ? (
            <div className="rounded-md border border-dashed border-line-subtle bg-surface-raised px-6 py-12 text-center">
              <p className="text-sm text-ink-secondary">
                No packs match the current filters.
              </p>
              <button
                type="button"
                onClick={() => {
                  setQuery('');
                  setLayer('all');
                }}
                className="mt-2 text-xs font-medium text-brand hover:underline"
              >
                Clear filters
              </button>
            </div>
          ) : (
            <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {(visibleRows ?? []).map((p) => (
                <PackCard key={p.id} pack={p} />
              ))}
            </ul>
          )}
        </div>
      )}

      <Drawer
        title={continueOrg ? `New content pack for ${continueOrg.name}` : 'New content pack'}
        open={open}
        onClose={() => setOpen(false)}
      >
        <NewPackForm
          models={modelsForPicker}
          continueOrg={continueOrg}
          onCreated={async (continueSetup, packId) => {
            setOpen(false);
            await refresh();
            if (continueSetup && continueOrg) {
              // Take the user to the new pack's detail page so they can add
              // documents and publish. Carry the continue param so subsequent
              // navigation (TODO: pack publish action) can route back.
              if (packId) {
                router.push(`/content-packs/${packId}?continue=${continueOrg.id}`);
              } else {
                const next =
                  nextStepAfterSave('content_published', continueOrg.type) ?? 'asset_instance';
                router.push(`/tenants/${continueOrg.id}?step=${next}`);
              }
            }
          }}
        />
      </Drawer>
    </PageShell>
  );
}

// One card per pack in the listing grid. Whole card is the click target
// (links to the pack detail page); inner chrome is purely visual.
function PackCard({ pack }: { pack: AdminContentPack }) {
  const v = pack.latestVersion;
  const statusTone =
    v && (STATUS_TONE[v.status as keyof typeof STATUS_TONE] ?? 'default');
  const isFieldCaptures = pack.kind === 'field_captures';
  return (
    <li className="group relative flex flex-col gap-3 rounded-lg border border-line-subtle bg-surface-raised p-4 transition-colors hover:border-brand/40 hover:shadow-[0_8px_24px_-16px_rgb(var(--brand)/0.4)] focus-within:border-brand/40">
      <Link
        href={`/content-packs/${pack.id}`}
        aria-label={`Open ${pack.name}`}
        className="absolute inset-0 z-0"
      />
      <div className="pointer-events-none relative z-10 flex flex-col gap-3">
        {/* Top row: layer + kind/status pills, plus a chevron hint */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <Pill tone={LAYER_TONE[pack.layerType]}>
              {LAYER_LABEL[pack.layerType]}
            </Pill>
            {isFieldCaptures && <Pill tone="warning">Field captures</Pill>}
          </div>
          <ChevronRight
            size={16}
            strokeWidth={2}
            className="text-ink-tertiary transition-transform group-hover:translate-x-0.5 group-hover:text-brand"
          />
        </div>

        {/* Title + slug */}
        <div className="flex flex-col gap-0.5">
          <h3 className="text-[15px] font-semibold leading-snug text-ink-primary group-hover:text-brand">
            {pack.name}
          </h3>
          <p className="font-mono text-[11px] text-ink-tertiary">{pack.slug}</p>
        </div>

        {/* Meta rows — model + owner */}
        <dl className="flex flex-col gap-1.5 text-xs">
          <div className="flex items-center gap-1.5 text-ink-secondary">
            <Package size={12} strokeWidth={2} className="shrink-0 text-ink-tertiary" />
            <dt className="sr-only">Asset model</dt>
            <dd className="truncate">{pack.assetModel.displayName}</dd>
          </div>
          <div className="flex items-center gap-1.5 text-ink-secondary">
            <Layers size={12} strokeWidth={2} className="shrink-0 text-ink-tertiary" />
            <dt className="sr-only">Owner</dt>
            <dd className="truncate">{pack.owner}</dd>
          </div>
        </dl>

        {/* Footer: latest version + total version count */}
        <div className="flex items-center justify-between gap-2 border-t border-line-subtle pt-3">
          {v ? (
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs text-ink-secondary">
                v{v.label ?? v.number}
              </span>
              <Pill tone={statusTone || 'default'}>{v.status}</Pill>
            </div>
          ) : (
            <span className="text-xs text-ink-tertiary">No versions yet</span>
          )}
          <span className="text-[11px] text-ink-tertiary tabular-nums">
            {pack.versionCount} {pack.versionCount === 1 ? 'version' : 'versions'}
          </span>
        </div>
      </div>
    </li>
  );
}

function NewPackForm({
  models,
  continueOrg,
  onCreated,
}: {
  models: AdminAssetModel[];
  continueOrg: AdminOrganization | null;
  onCreated: (continueSetup: boolean, packId?: string) => Promise<void>;
}) {
  const [assetModelId, setAssetModelId] = useState(models[0]?.id ?? '');
  const [layerType, setLayerType] =
    useState<'base' | 'dealer_overlay' | 'site_overlay'>('base');
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [nameEdited, setNameEdited] = useState(false);
  const [slugEdited, setSlugEdited] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [continueAfter, setContinueAfter] = useState(false);
  const toast = useToast();

  const selectedModel = models.find((m) => m.id === assetModelId);

  // Auto-fill name from asset model + layer until the user edits either field.
  // The slug follows from the name unless the user has edited it directly.
  useEffect(() => {
    if (nameEdited || !selectedModel) return;
    const suffix =
      layerType === 'base'
        ? ''
        : layerType === 'dealer_overlay'
        ? ' — Dealer overlay'
        : ' — Site overlay';
    const nextName = `${selectedModel.displayName}${suffix}`;
    setName(nextName);
    if (!slugEdited) setSlug(autoSlug(nextName));
  }, [assetModelId, layerType, selectedModel, nameEdited, slugEdited]);

  function autoSlug(s: string): string {
    return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }

  function onNameChange(next: string) {
    setName(next);
    setNameEdited(true);
    if (!slugEdited) setSlug(autoSlug(next));
  }

  function onSlugChange(next: string) {
    setSlug(next);
    setSlugEdited(true);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const result = await createContentPack({
        assetModelId,
        name: name.trim(),
        slug: slug.trim(),
        layerType,
      });
      toast.success(`${name.trim()} created`, 'Draft v1.0.0 is ready for authoring.');
      await onCreated(continueAfter, result.pack.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <ErrorBanner error={error} />
      <Field label="Asset model" required>
        <Select
          value={assetModelId}
          onChange={(e) => setAssetModelId(e.target.value)}
          required
        >
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.displayName} · {m.modelCode} ({m.owner.name})
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Pack name" required>
        <TextInput
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder="Flow Turn 90° Merge — Base"
          required
        />
      </Field>
      <Field label="Slug" required>
        <TextInput
          value={slug}
          onChange={(e) => onSlugChange(e.target.value)}
          placeholder="flow-turn-merge-90-base"
          pattern="[a-z0-9\-]+"
          required
        />
      </Field>
      <Field label="Layer" required>
        <Select
          value={layerType}
          onChange={(e) => setLayerType(e.target.value as typeof layerType)}
        >
          <option value="base">Base (OEM)</option>
          <option value="dealer_overlay">Dealer overlay</option>
          <option value="site_overlay">Site overlay</option>
        </Select>
      </Field>
      <p className="rounded border border-line-subtle bg-surface-inset p-3 text-xs text-ink-secondary">
        A draft v1.0.0 will be created alongside the pack. Add documents to the draft,
        then publish when ready.
      </p>
      <div className="mt-2 flex flex-wrap justify-end gap-2">
        {continueOrg && (
          <SecondaryButton
            type="submit"
            disabled={submitting}
            onClick={() => setContinueAfter(true)}
          >
            {submitting && continueAfter ? 'Saving…' : 'Save & continue setup'}
          </SecondaryButton>
        )}
        <PrimaryButton
          type="submit"
          disabled={submitting}
          onClick={() => setContinueAfter(false)}
        >
          {submitting && !continueAfter
            ? 'Creating…'
            : continueOrg
            ? 'Save'
            : 'Create content pack'}
        </PrimaryButton>
      </div>
    </form>
  );
}
