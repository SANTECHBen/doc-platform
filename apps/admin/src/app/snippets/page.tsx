'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import {
  Camera,
  FileText,
  Globe2,
  Plus,
  Puzzle,
  Ruler,
  Search,
  ShieldAlert,
} from 'lucide-react';
import { EmptyState } from '@/components/empty-state';
import { TableSkeleton } from '@/components/skeleton';
import { useToast } from '@/components/toast';
import { PageHeader, PageShell } from '@/components/page-shell';
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
  createAdminSnippet,
  getMe,
  listAdminSnippets,
  listOrganizations,
  type AdminOrganization,
  type AdminSnippet,
  type Me,
  type ProcedureStepKind,
} from '@/lib/api';

const KIND_ICON: Record<ProcedureStepKind, typeof FileText> = {
  instruction: FileText,
  safety_check: ShieldAlert,
  photo_required: Camera,
  measurement_required: Ruler,
};

const KIND_LABEL: Record<ProcedureStepKind, string> = {
  instruction: 'Instruction',
  safety_check: 'Safety check',
  photo_required: 'Photo required',
  measurement_required: 'Measurement',
};

export default function SnippetsPage() {
  const router = useRouter();
  const [rows, setRows] = useState<AdminSnippet[] | null>(null);
  const [orgs, setOrgs] = useState<AdminOrganization[]>([]);
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);

  async function refresh() {
    try {
      const [snips, organizations, identity] = await Promise.all([
        listAdminSnippets({ q: q.trim() || undefined, limit: 200 }),
        listOrganizations(),
        getMe(),
      ]);
      setRows(snips);
      setOrgs(organizations);
      setMe(identity);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    void refresh();
    // refresh on q change with debounce
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const t = setTimeout(() => {
      void refresh();
    }, 200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const platformRows = useMemo(
    () => (rows ?? []).filter((r) => r.isPlatform),
    [rows],
  );
  const orgRows = useMemo(
    () => (rows ?? []).filter((r) => !r.isPlatform),
    [rows],
  );
  const orgById = useMemo(
    () => new Map(orgs.map((o) => [o.id, o])),
    [orgs],
  );

  const isPlatformAdmin = me?.authenticated && me.platformAdmin === true;

  return (
    <PageShell crumbs={[{ label: 'Snippets' }]}>
      <PageHeader
        title="Snippets"
        description="Reusable step content (Lockout-Tagout, Safety Briefing, etc.). Inserted from any procedure step. Edits propagate instantly to every step that uses the snippet."
        actions={
          <PrimaryButton onClick={() => setDrawerOpen(true)}>
            <Plus size={14} strokeWidth={2} /> New snippet
          </PrimaryButton>
        }
      />
      <ErrorBanner error={error} />
      <div className="mb-4 flex items-center gap-2 rounded-md border border-line bg-surface px-3 py-2">
        <Search size={14} className="text-ink-tertiary" />
        <input
          type="text"
          placeholder="Search snippets by title…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="w-full bg-transparent text-sm text-ink-primary outline-none placeholder:text-ink-tertiary"
        />
      </div>
      {rows === null ? (
        <TableSkeleton cols={4} rows={5} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Puzzle}
          title="No snippets yet"
          description="Create your first reusable snippet — Lockout-Tagout, Safety Briefing, common torque chart, etc. — and reference it from any procedure step."
          action={
            <PrimaryButton onClick={() => setDrawerOpen(true)}>
              <Plus size={14} strokeWidth={2} /> New snippet
            </PrimaryButton>
          }
        />
      ) : (
        <div className="flex flex-col gap-6">
          {platformRows.length > 0 && (
            <SnippetGroup
              title="Platform — global"
              icon={<Globe2 size={14} className="text-accent" />}
              snippets={platformRows}
              orgById={orgById}
            />
          )}
          {orgRows.length > 0 && (
            <SnippetGroup
              title="Your organization"
              icon={null}
              snippets={orgRows}
              orgById={orgById}
            />
          )}
        </div>
      )}

      <Drawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title="New snippet"
      >
        <CreateSnippetForm
          orgs={orgs}
          isPlatformAdmin={!!isPlatformAdmin}
          onCancel={() => setDrawerOpen(false)}
          onCreated={(s) => {
            setDrawerOpen(false);
            router.push(`/snippets/${s.id}`);
          }}
        />
      </Drawer>
    </PageShell>
  );
}

function SnippetGroup({
  title,
  icon,
  snippets,
  orgById,
}: {
  title: string;
  icon: React.ReactNode;
  snippets: AdminSnippet[];
  orgById: Map<string, AdminOrganization>;
}) {
  return (
    <section>
      <div className="mb-2 flex items-center gap-1.5">
        {icon}
        <h2 className="text-[10px] font-semibold uppercase tracking-wider text-ink-tertiary">
          {title}
        </h2>
      </div>
      <ul className="overflow-hidden rounded-md border border-line bg-surface-raised">
        {snippets.map((s) => {
          const Icon = KIND_ICON[s.kind];
          const owner = s.ownerOrganizationId
            ? orgById.get(s.ownerOrganizationId)
            : null;
          return (
            <li
              key={s.id}
              className="border-b border-line-subtle last:border-b-0"
            >
              <Link
                href={`/snippets/${s.id}`}
                className="flex items-start gap-3 px-4 py-3 transition hover:bg-surface-elevated"
              >
                <Icon className="mt-0.5 size-4 shrink-0 text-ink-tertiary" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-ink-primary">
                    {s.title}
                  </p>
                  <p className="mt-0.5 text-[11px] text-ink-tertiary">
                    {KIND_LABEL[s.kind]}
                    {owner ? ` · ${owner.name}` : ''}
                    {s.tags.length > 0
                      ? ` · ${s.tags.slice(0, 3).join(', ')}`
                      : ''}
                  </p>
                </div>
                <span className="text-[10px] text-ink-tertiary">
                  Updated {new Date(s.updatedAt).toLocaleDateString()}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function CreateSnippetForm({
  orgs,
  isPlatformAdmin,
  onCancel,
  onCreated,
}: {
  orgs: AdminOrganization[];
  isPlatformAdmin: boolean;
  onCancel: () => void;
  onCreated: (s: { id: string }) => void;
}) {
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<ProcedureStepKind>('instruction');
  const [tier, setTier] = useState<'org' | 'platform'>('org');
  const [ownerId, setOwnerId] = useState<string>(orgs[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Default to platform tier for platform admins (matches the most common
  // SANTECH-staff workflow). Customer admins always create org snippets.
  useEffect(() => {
    if (isPlatformAdmin) setTier('platform');
  }, [isPlatformAdmin]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const created = await createAdminSnippet({
        title: title.trim(),
        kind,
        isPlatform: tier === 'platform',
        ownerOrganizationId: tier === 'org' ? ownerId : null,
      });
      toast.success('Snippet created', `"${created.title}" is ready to author.`);
      onCreated(created);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <ErrorBanner error={err} />
      <Field label="Title" hint="Short, distinctive name. Authors pick from this list.">
        <TextInput
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
          maxLength={200}
          placeholder='e.g. "Lockout-Tagout — full procedure"'
        />
      </Field>
      <Field label="Kind" hint="Matches the procedure step kind this snippet will represent when inserted.">
        <Select value={kind} onChange={(e) => setKind(e.target.value as ProcedureStepKind)}>
          <option value="instruction">Instruction</option>
          <option value="safety_check">Safety check</option>
          <option value="photo_required">Photo required</option>
          <option value="measurement_required">Measurement</option>
        </Select>
      </Field>
      {isPlatformAdmin && (
        <Field label="Tier" hint="Platform snippets are visible to every org. Edits propagate across all customers.">
          <Select value={tier} onChange={(e) => setTier(e.target.value as 'org' | 'platform')}>
            <option value="platform">Platform (global)</option>
            <option value="org">Organization-scoped</option>
          </Select>
        </Field>
      )}
      {tier === 'org' && (
        <Field label="Owner organization">
          <Select value={ownerId} onChange={(e) => setOwnerId(e.target.value)} required>
            <option value="" disabled>
              Select an organization
            </option>
            {orgs.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <div className="flex items-center justify-end gap-2 pt-2">
        <SecondaryButton type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </SecondaryButton>
        <PrimaryButton type="submit" disabled={busy || !title.trim()}>
          {busy ? 'Creating…' : 'Create snippet'}
        </PrimaryButton>
      </div>
    </form>
  );
}
