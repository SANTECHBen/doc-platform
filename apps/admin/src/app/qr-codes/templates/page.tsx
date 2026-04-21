'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ChevronLeft, Layers, Plus, Star, Trash2 } from 'lucide-react';
import { PageHeader, PageShell } from '@/components/page-shell';
import { EmptyState } from '@/components/empty-state';
import { useToast } from '@/components/toast';
import {
  listQrLabelTemplates,
  deleteQrLabelTemplate,
  createQrLabelTemplate,
  listAssetInstances,
  type AdminQrLabelTemplate,
} from '@/lib/api';

export default function TemplatesListPage() {
  const [templates, setTemplates] = useState<AdminQrLabelTemplate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const toast = useToast();

  useEffect(() => {
    listQrLabelTemplates()
      .then(setTemplates)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  async function onCreate() {
    setCreating(true);
    setError(null);
    try {
      // Use the first available asset instance's organization to seed a
      // template. This is the same convention as the content-pack flow —
      // authoring starts in the org whose data the admin is editing.
      const instances = await listAssetInstances();
      if (instances.length === 0) {
        throw new Error(
          'Create an asset instance first — a template has to belong to an org.',
        );
      }
      const tpl = await createQrLabelTemplate({
        organizationId: instances[0]!.organization.id,
        name: 'New template',
      });
      window.location.href = `/qr-codes/templates/${tpl.id}`;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setCreating(false);
    }
  }

  async function onDelete(id: string, name: string) {
    if (!confirm(`Delete template "${name}"?`)) return;
    try {
      await deleteQrLabelTemplate(id);
      setTemplates((prev) => (prev ?? []).filter((t) => t.id !== id));
      toast.success(`Deleted "${name}"`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <PageShell crumbs={[{ label: 'QR codes', href: '/qr-codes' }, { label: 'Templates' }]}>
      <PageHeader
        title="Label templates"
        description="Reusable sticker designs. Pick a layout, set an accent color, toggle which fields appear. The print page uses the default template unless one is picked at print time."
        actions={
          <div className="flex items-center gap-2">
            <Link
              href="/qr-codes"
              className="inline-flex items-center gap-1.5 rounded border border-line px-3 py-1.5 text-sm text-ink-secondary hover:bg-surface-inset"
            >
              <ChevronLeft size={14} strokeWidth={2} />
              Back
            </Link>
            <button
              onClick={onCreate}
              disabled={creating}
              className="inline-flex items-center gap-1.5 rounded btn-primary px-3 py-1.5 disabled:opacity-50"
            >
              <Plus size={14} strokeWidth={2} />
              {creating ? 'Creating…' : 'New template'}
            </button>
          </div>
        }
      />

      {error && (
        <div className="mb-4 rounded-md border border-signal-fault/40 bg-signal-fault/10 p-3 text-sm text-signal-fault">
          {error}
        </div>
      )}

      {!templates ? (
        <p className="p-6 text-center text-sm text-ink-tertiary">Loading…</p>
      ) : templates.length === 0 ? (
        <EmptyState
          icon={Layers}
          title="No templates yet"
          description="Create one to customize the printed QR sticker — layout, accent color, which fields appear, custom header text, and more."
          action={
            <button onClick={onCreate} className="btn-primary">
              Create your first template
            </button>
          }
        />
      ) : (
        <section className="rounded-md border border-line-subtle bg-surface-raised">
          <table className="data-table">
            <thead className="bg-surface-inset text-left text-xs uppercase tracking-wide text-ink-tertiary">
              <tr>
                <th className="px-4 py-2">Name</th>
                <th className="px-4 py-2">Layout</th>
                <th className="px-4 py-2">Organization</th>
                <th className="px-4 py-2">Updated</th>
                <th className="w-10 px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {templates.map((t) => (
                <tr key={t.id} className="border-t border-line-subtle">
                  <td className="px-4 py-3">
                    <Link
                      href={`/qr-codes/templates/${t.id}`}
                      className="inline-flex items-center gap-2 font-medium text-ink-primary hover:text-brand"
                    >
                      {t.isDefault && (
                        <Star
                          size={12}
                          strokeWidth={2}
                          fill="currentColor"
                          className="text-brand"
                        />
                      )}
                      {t.name}
                    </Link>
                  </td>
                  <td className="px-4 py-3 capitalize text-ink-secondary">{t.layout}</td>
                  <td className="px-4 py-3 text-ink-secondary">
                    {t.organizationName ?? '—'}
                  </td>
                  <td className="px-4 py-3 text-xs text-ink-tertiary">
                    {new Date(t.updatedAt).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => onDelete(t.id, t.name)}
                      className="inline-flex h-7 w-7 items-center justify-center rounded text-ink-tertiary hover:bg-signal-fault/10 hover:text-signal-fault"
                      title="Delete template"
                      aria-label="Delete template"
                    >
                      <Trash2 size={13} strokeWidth={2} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </PageShell>
  );
}
