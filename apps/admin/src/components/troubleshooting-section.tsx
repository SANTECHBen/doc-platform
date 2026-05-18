'use client';

// Author OEM-style Troubleshooting Guides for an asset model. One guide =
// one named triage table (e.g., "ARB Flow Splitter — Mechanical").
// Each row is a (Symptom / Cause / Remedy) tuple with an optional
// procedure link the tech can launch from the PWA.
//
// Mirrors PMPlansSection in shape but with three text columns and no
// frequency. Distinct from PM Plans (recurring scheduled checks) — this
// is reactive triage.

import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Plus,
  Trash2,
} from 'lucide-react';
import {
  Drawer,
  ErrorBanner,
  Field,
  PrimaryButton,
  SecondaryButton,
  Select,
  TextInput,
  Textarea,
} from './form';
import { useToast } from './toast';
import {
  createTroubleshootingGuide,
  createTroubleshootingItem,
  deleteTroubleshootingGuide,
  deleteTroubleshootingItem,
  listTroubleshootingGuides,
  listPmProcedureDocs,
  updateTroubleshootingGuide,
  updateTroubleshootingItem,
  type AdminPmProcedureDoc,
  type AdminTroubleshootingGuide,
  type AdminTroubleshootingItem,
} from '@/lib/api';

export function TroubleshootingSection({ assetModelId }: { assetModelId: string }) {
  const [guides, setGuides] = useState<AdminTroubleshootingGuide[] | null>(null);
  const [docs, setDocs] = useState<AdminPmProcedureDoc[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const toast = useToast();

  async function refresh() {
    try {
      const [g, d] = await Promise.all([
        listTroubleshootingGuides(assetModelId),
        // Reuses the PM procedure-doc list — same scope (structured_procedure
        // docs attached to this asset model's packs). No reason for
        // troubleshooting to have its own picker source.
        listPmProcedureDocs(assetModelId),
      ]);
      setGuides(g);
      setDocs(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assetModelId]);

  return (
    <section id="troubleshooting-section" className="scroll-mt-24">
      <div className="mb-2 flex items-center justify-between">
        <div>
          <h2 className="text-xs font-medium uppercase tracking-wide text-ink-tertiary">
            Troubleshooting guides{guides ? ` (${guides.length})` : ''}
          </h2>
          <p className="text-xs text-ink-tertiary">
            OEM-style triage tables. Each guide owns rows of (Symptom / Cause /
            Remedy). Optional procedure link per row.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          className="btn btn-primary btn-sm"
        >
          <Plus size={14} strokeWidth={2} /> New guide
        </button>
      </div>

      <ErrorBanner error={error} />

      {guides === null ? (
        <p className="rounded-md border border-line-subtle bg-surface-raised p-4 text-center text-sm text-ink-tertiary">
          Loading…
        </p>
      ) : guides.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-md border border-dashed border-line bg-surface-raised p-6 text-center">
          <AlertTriangle size={28} strokeWidth={1.5} className="text-ink-tertiary" />
          <p className="text-sm text-ink-secondary">No troubleshooting guides yet for this model.</p>
          <SecondaryButton onClick={() => setCreateOpen(true)}>
            <Plus size={14} strokeWidth={2} /> Add the first guide
          </SecondaryButton>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {guides.map((g) => (
            <GuideCard
              key={g.id}
              guide={g}
              docs={docs}
              onChanged={refresh}
              onToast={(t, b) => (t === 'ok' ? toast.success(b) : toast.error(b))}
            />
          ))}
        </div>
      )}

      <Drawer
        title="New troubleshooting guide"
        open={createOpen}
        onClose={() => setCreateOpen(false)}
      >
        {createOpen && (
          <CreateGuideForm
            assetModelId={assetModelId}
            onCreated={async () => {
              setCreateOpen(false);
              await refresh();
            }}
          />
        )}
      </Drawer>
    </section>
  );
}

function CreateGuideForm({
  assetModelId,
  onCreated,
}: {
  assetModelId: string;
  onCreated: () => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await createTroubleshootingGuide(assetModelId, {
        name: name.trim(),
        description: description.trim() || null,
      });
      await onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <ErrorBanner error={error} />
      <Field label="Guide name" required>
        <TextInput
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g., ARB Flow Splitter — Mechanical"
          required
        />
      </Field>
      <Field label="Description" hint="Optional. Shown above the rows in the PWA.">
        <Textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
        />
      </Field>
      <div className="flex justify-end">
        <PrimaryButton type="submit" disabled={busy || !name.trim()}>
          {busy ? 'Creating…' : 'Create guide'}
        </PrimaryButton>
      </div>
    </form>
  );
}

function GuideCard({
  guide,
  docs,
  onChanged,
  onToast,
}: {
  guide: AdminTroubleshootingGuide;
  docs: AdminPmProcedureDoc[];
  onChanged: () => Promise<void>;
  onToast: (tone: 'ok' | 'err', body: string) => void;
}) {
  const [editingName, setEditingName] = useState(false);
  const [name, setName] = useState(guide.name);
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => setName(guide.name), [guide.name]);

  async function saveName() {
    const v = name.trim();
    if (!v || v === guide.name) {
      setEditingName(false);
      setName(guide.name);
      return;
    }
    try {
      await updateTroubleshootingGuide(guide.id, { name: v });
      onToast('ok', 'Guide renamed');
      setEditingName(false);
      await onChanged();
    } catch (e) {
      onToast('err', e instanceof Error ? e.message : String(e));
    }
  }

  async function onDelete() {
    if (
      !confirm(
        `Delete guide "${guide.name}"? Its ${guide.items.length} row${guide.items.length === 1 ? '' : 's'} will be removed too.`,
      )
    ) {
      return;
    }
    try {
      await deleteTroubleshootingGuide(guide.id);
      onToast('ok', 'Guide deleted');
      await onChanged();
    } catch (e) {
      onToast('err', e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <section className="rounded-md border border-line bg-surface-raised">
      <header className="flex items-center gap-2 border-b border-line-subtle px-4 py-2.5">
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className="rounded p-1 text-ink-tertiary hover:bg-surface-elevated"
          aria-label={collapsed ? 'Expand' : 'Collapse'}
        >
          {collapsed ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
        </button>
        {editingName ? (
          <form
            className="flex-1"
            onSubmit={(e) => {
              e.preventDefault();
              void saveName();
            }}
          >
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => void saveName()}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setEditingName(false);
                  setName(guide.name);
                }
              }}
              className="w-full rounded border border-line bg-surface px-2 py-1 text-base font-semibold"
            />
          </form>
        ) : (
          <button
            type="button"
            onClick={() => setEditingName(true)}
            className="flex-1 truncate text-left text-base font-semibold text-ink-primary hover:text-brand"
          >
            {guide.name}
          </button>
        )}
        <span className="text-xs text-ink-tertiary">
          {guide.items.length} row{guide.items.length === 1 ? '' : 's'}
        </span>
        <button
          type="button"
          onClick={onDelete}
          className="rounded p-1 text-ink-tertiary hover:bg-signal-fault/10 hover:text-signal-fault"
          title="Delete guide"
        >
          <Trash2 size={14} />
        </button>
      </header>

      {!collapsed && (
        <div className="overflow-hidden">
          {guide.items.length === 0 ? (
            <p className="px-4 py-3 text-sm text-ink-tertiary">
              No rows yet. Use the form below to add the first one.
            </p>
          ) : (
            <table className="data-table w-full text-sm">
              <thead className="bg-surface-inset text-left text-[10px] uppercase tracking-wider text-ink-tertiary">
                <tr>
                  <th className="w-56 px-3 py-2">Symptom</th>
                  <th className="px-3 py-2">Cause</th>
                  <th className="px-3 py-2">Remedy</th>
                  <th className="w-44 px-3 py-2">Procedure</th>
                  <th className="w-8 px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {guide.items.map((it) => (
                  <ItemRow
                    key={it.id}
                    item={it}
                    docs={docs}
                    onChanged={onChanged}
                    onToast={onToast}
                  />
                ))}
              </tbody>
            </table>
          )}
          <NewItemForm
            guideId={guide.id}
            docs={docs}
            onAdded={onChanged}
            onToast={onToast}
          />
        </div>
      )}
    </section>
  );
}

function ItemRow({
  item,
  docs,
  onChanged,
  onToast,
}: {
  item: AdminTroubleshootingItem;
  docs: AdminPmProcedureDoc[];
  onChanged: () => Promise<void>;
  onToast: (tone: 'ok' | 'err', body: string) => void;
}) {
  const [symptom, setSymptom] = useState(item.symptom);
  const [cause, setCause] = useState(item.cause ?? '');
  const [remedy, setRemedy] = useState(item.remedy ?? '');
  useEffect(() => setSymptom(item.symptom), [item.symptom]);
  useEffect(() => setCause(item.cause ?? ''), [item.cause]);
  useEffect(() => setRemedy(item.remedy ?? ''), [item.remedy]);

  async function flush(patch: Parameters<typeof updateTroubleshootingItem>[1]) {
    try {
      await updateTroubleshootingItem(item.id, patch);
      await onChanged();
    } catch (e) {
      onToast('err', e instanceof Error ? e.message : String(e));
    }
  }

  async function onDelete() {
    if (!confirm(`Delete row "${item.symptom}"?`)) return;
    try {
      await deleteTroubleshootingItem(item.id);
      await onChanged();
    } catch (e) {
      onToast('err', e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <tr className="border-t border-line-subtle align-top">
      <td className="px-3 py-2">
        <textarea
          value={symptom}
          onChange={(e) => setSymptom(e.target.value)}
          onBlur={() => {
            const v = symptom.trim();
            if (v && v !== item.symptom) void flush({ symptom: v });
          }}
          rows={2}
          className="w-full rounded border border-transparent bg-transparent px-1 py-0.5 font-medium hover:border-line focus:border-accent focus:bg-surface"
        />
      </td>
      <td className="px-3 py-2">
        <textarea
          value={cause}
          onChange={(e) => setCause(e.target.value)}
          onBlur={() => {
            const v = cause.trim() || null;
            if (v !== (item.cause ?? null)) void flush({ cause: v });
          }}
          rows={3}
          className="w-full rounded border border-transparent bg-transparent px-1 py-0.5 hover:border-line focus:border-accent focus:bg-surface"
          placeholder="—"
        />
      </td>
      <td className="px-3 py-2">
        <textarea
          value={remedy}
          onChange={(e) => setRemedy(e.target.value)}
          onBlur={() => {
            const v = remedy.trim() || null;
            if (v !== (item.remedy ?? null)) void flush({ remedy: v });
          }}
          rows={3}
          className="w-full rounded border border-transparent bg-transparent px-1 py-0.5 hover:border-line focus:border-accent focus:bg-surface"
          placeholder="—"
        />
      </td>
      <td className="px-3 py-2">
        <Select
          value={item.documentId ?? ''}
          onChange={(e) => {
            const v = e.target.value || null;
            if (v !== (item.documentId ?? null)) void flush({ documentId: v });
          }}
        >
          <option value="">— None —</option>
          {docs.map((d) => (
            <option key={d.id} value={d.id}>
              {d.title}
            </option>
          ))}
        </Select>
      </td>
      <td className="px-3 py-2">
        <button
          type="button"
          onClick={onDelete}
          className="rounded p-1 text-ink-tertiary hover:bg-signal-fault/10 hover:text-signal-fault"
          aria-label="Delete row"
        >
          <Trash2 size={14} />
        </button>
      </td>
    </tr>
  );
}

function NewItemForm({
  guideId,
  docs,
  onAdded,
  onToast,
}: {
  guideId: string;
  docs: AdminPmProcedureDoc[];
  onAdded: () => Promise<void>;
  onToast: (tone: 'ok' | 'err', body: string) => void;
}) {
  const [symptom, setSymptom] = useState('');
  const [cause, setCause] = useState('');
  const [remedy, setRemedy] = useState('');
  const [documentId, setDocumentId] = useState<string>('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!symptom.trim()) return;
    setBusy(true);
    try {
      await createTroubleshootingItem(guideId, {
        symptom: symptom.trim(),
        cause: cause.trim() || null,
        remedy: remedy.trim() || null,
        documentId: documentId || null,
      });
      setSymptom('');
      setCause('');
      setRemedy('');
      setDocumentId('');
      await onAdded();
    } catch (e) {
      onToast('err', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-2 border-t border-line-subtle bg-surface-inset px-3 py-3"
    >
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-[14rem_1fr_1fr_11rem]">
        <textarea
          value={symptom}
          onChange={(e) => setSymptom(e.target.value)}
          placeholder="Symptom (e.g., Conveyor belt not moving)"
          rows={2}
          className="rounded border border-line bg-surface px-2 py-1.5 text-sm"
        />
        <textarea
          value={cause}
          onChange={(e) => setCause(e.target.value)}
          placeholder="Cause (optional)"
          rows={2}
          className="rounded border border-line bg-surface px-2 py-1.5 text-sm"
        />
        <textarea
          value={remedy}
          onChange={(e) => setRemedy(e.target.value)}
          placeholder="Remedy (optional)"
          rows={2}
          className="rounded border border-line bg-surface px-2 py-1.5 text-sm"
        />
        <Select
          value={documentId}
          onChange={(e) => setDocumentId(e.target.value)}
        >
          <option value="">Procedure: — None —</option>
          {docs.map((d) => (
            <option key={d.id} value={d.id}>
              Procedure: {d.title}
            </option>
          ))}
        </Select>
      </div>
      <button
        type="submit"
        disabled={busy || !symptom.trim()}
        className="group flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-line bg-surface px-3 py-2 text-xs font-medium text-ink-secondary transition hover:border-accent/40 hover:bg-accent/5 hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Plus size={14} strokeWidth={2} className="transition group-hover:rotate-90" />
        {busy ? 'Adding…' : 'Add row'}
      </button>
    </form>
  );
}
