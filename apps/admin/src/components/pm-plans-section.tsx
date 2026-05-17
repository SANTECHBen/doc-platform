'use client';

// Author OEM-style PM checklists for an asset model. One Plan = one named
// table (e.g., "ARB Flow Splitter — Cleaning & Inspection"). Each row
// (item) is a single check with its own frequency. The PWA renders one
// card per (plan, frequency) so the tech sees "Daily checks (6 items)"
// instead of 6 individual cards.
//
// Distinct from PMSchedulesSection (which manages flat per-procedure
// schedules); the two coexist on the asset model page.

import { useEffect, useMemo, useState } from 'react';
import {
  CalendarRange,
  ChevronDown,
  ChevronUp,
  Pencil,
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
  createPmPlan,
  createPmPlanItem,
  deletePmPlan,
  deletePmPlanItem,
  listPmPlans,
  listPmProcedureDocs,
  updatePmPlan,
  updatePmPlanItem,
  type AdminPmPlan,
  type AdminPmPlanItem,
  type AdminPmProcedureDoc,
  type PmPlanFrequency,
} from '@/lib/api';

const FREQUENCY_OPTIONS: Array<{ value: PmPlanFrequency; label: string }> = [
  { value: 'D', label: 'D — Daily' },
  { value: 'W', label: 'W — Weekly' },
  { value: 'M', label: 'M — Monthly' },
  { value: 'Q', label: 'Q — Quarterly' },
  { value: 'S', label: 'S — Semi-annually' },
  { value: 'Y', label: 'Y — Yearly' },
];

export function PMPlansSection({ assetModelId }: { assetModelId: string }) {
  const [plans, setPlans] = useState<AdminPmPlan[] | null>(null);
  const [docs, setDocs] = useState<AdminPmProcedureDoc[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const toast = useToast();

  async function refresh() {
    try {
      const [p, d] = await Promise.all([
        listPmPlans(assetModelId),
        listPmProcedureDocs(assetModelId),
      ]);
      setPlans(p);
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
    <section id="pm-plans-section" className="mt-8 scroll-mt-24">
      <div className="mb-2 flex items-center justify-between">
        <div>
          <h2 className="text-xs font-medium uppercase tracking-wide text-ink-tertiary">
            PM Plans (checklist){plans ? ` (${plans.length})` : ''}
          </h2>
          <p className="text-xs text-ink-tertiary">
            OEM-style checklist with per-row frequency. The PWA shows one card per (plan, frequency) — e.g., "Daily checks (3 items)" — that expands to the per-row list.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          className="btn btn-primary btn-sm"
        >
          <Plus size={14} strokeWidth={2} /> New plan
        </button>
      </div>

      <ErrorBanner error={error} />

      {plans === null ? (
        <p className="rounded-md border border-line-subtle bg-surface-raised p-4 text-center text-sm text-ink-tertiary">
          Loading…
        </p>
      ) : plans.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-md border border-dashed border-line bg-surface-raised p-6 text-center">
          <CalendarRange size={28} strokeWidth={1.5} className="text-ink-tertiary" />
          <p className="text-sm text-ink-secondary">No PM plans yet for this model.</p>
          <SecondaryButton onClick={() => setCreateOpen(true)}>
            <Plus size={14} strokeWidth={2} /> Add the first plan
          </SecondaryButton>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {plans.map((p) => (
            <PlanCard
              key={p.id}
              plan={p}
              docs={docs}
              onChanged={refresh}
              onToast={(t, b) => (t === 'ok' ? toast.success(b) : toast.error(b))}
            />
          ))}
        </div>
      )}

      <Drawer
        title="New PM Plan"
        open={createOpen}
        onClose={() => setCreateOpen(false)}
      >
        {createOpen && (
          <CreatePlanForm
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

function CreatePlanForm({
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
      await createPmPlan(assetModelId, {
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
      <Field label="Plan name" required>
        <TextInput
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g., ARB Flow Splitter — Cleaning & Inspection"
          required
        />
      </Field>
      <Field label="Description" hint="Optional. Shown to techs.">
        <Textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
        />
      </Field>
      <div className="flex justify-end">
        <PrimaryButton type="submit" disabled={busy || !name.trim()}>
          {busy ? 'Creating…' : 'Create plan'}
        </PrimaryButton>
      </div>
    </form>
  );
}

// One plan card — header (name + delete) + items grid. Items add via a
// bottom row form; existing items edit inline (component/check/remarks/
// frequency/procedure each as their own input that PATCH-saves on blur).
function PlanCard({
  plan,
  docs,
  onChanged,
  onToast,
}: {
  plan: AdminPmPlan;
  docs: AdminPmProcedureDoc[];
  onChanged: () => Promise<void>;
  onToast: (tone: 'ok' | 'err', body: string) => void;
}) {
  const [editingName, setEditingName] = useState(false);
  const [name, setName] = useState(plan.name);
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => setName(plan.name), [plan.name]);

  // Frequency-grouped summary for the header — "3 daily · 2 weekly · 1 monthly".
  const freqCounts = useMemo(() => {
    const c: Record<PmPlanFrequency, number> = { D: 0, W: 0, M: 0, Q: 0, S: 0, Y: 0 };
    for (const it of plan.items) c[it.frequency] += 1;
    return c;
  }, [plan.items]);
  const summary = (['D', 'W', 'M', 'Q', 'S', 'Y'] as PmPlanFrequency[])
    .filter((f) => freqCounts[f] > 0)
    .map(
      (f) =>
        `${freqCounts[f]} ${({ D: 'daily', W: 'weekly', M: 'monthly', Q: 'quarterly', S: 'semi-annual', Y: 'yearly' } as Record<PmPlanFrequency, string>)[f]}`,
    )
    .join(' · ');

  async function saveName() {
    const v = name.trim();
    if (!v || v === plan.name) {
      setEditingName(false);
      setName(plan.name);
      return;
    }
    try {
      await updatePmPlan(plan.id, { name: v });
      onToast('ok', 'Plan renamed');
      setEditingName(false);
      await onChanged();
    } catch (e) {
      onToast('err', e instanceof Error ? e.message : String(e));
    }
  }

  async function onDelete() {
    if (
      !confirm(
        `Delete plan "${plan.name}"? Its ${plan.items.length} item${plan.items.length === 1 ? '' : 's'} will be removed too. Service records survive as historical.`,
      )
    ) {
      return;
    }
    try {
      await deletePmPlan(plan.id);
      onToast('ok', 'Plan deleted');
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
                  setName(plan.name);
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
            {plan.name}
          </button>
        )}
        <span className="text-xs text-ink-tertiary">
          {plan.items.length === 0 ? 'empty' : summary}
        </span>
        <button
          type="button"
          onClick={onDelete}
          className="rounded p-1 text-ink-tertiary hover:bg-signal-fault/10 hover:text-signal-fault"
          title="Delete plan"
        >
          <Trash2 size={14} />
        </button>
      </header>

      {!collapsed && (
        <div className="overflow-hidden">
          {plan.items.length === 0 ? (
            <p className="px-4 py-3 text-sm text-ink-tertiary">
              No checks yet. Use the row below to add the first one.
            </p>
          ) : (
            <table className="data-table w-full text-sm">
              <thead className="bg-surface-inset text-left text-[10px] uppercase tracking-wider text-ink-tertiary">
                <tr>
                  <th className="w-44 px-3 py-2">Component</th>
                  <th className="px-3 py-2">Check</th>
                  <th className="px-3 py-2">Remarks</th>
                  <th className="w-32 px-3 py-2">Frequency</th>
                  <th className="w-48 px-3 py-2">Procedure</th>
                  <th className="w-8 px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {plan.items.map((it) => (
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
          <NewItemRow planId={plan.id} docs={docs} onAdded={onChanged} onToast={onToast} />
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
  item: AdminPmPlanItem;
  docs: AdminPmProcedureDoc[];
  onChanged: () => Promise<void>;
  onToast: (tone: 'ok' | 'err', body: string) => void;
}) {
  const [component, setComponent] = useState(item.component);
  const [checkText, setCheckText] = useState(item.checkText);
  const [remarks, setRemarks] = useState(item.remarks ?? '');
  useEffect(() => setComponent(item.component), [item.component]);
  useEffect(() => setCheckText(item.checkText), [item.checkText]);
  useEffect(() => setRemarks(item.remarks ?? ''), [item.remarks]);

  async function flush(patch: Parameters<typeof updatePmPlanItem>[1]) {
    try {
      await updatePmPlanItem(item.id, patch);
      await onChanged();
    } catch (e) {
      onToast('err', e instanceof Error ? e.message : String(e));
    }
  }

  async function onDelete() {
    if (!confirm(`Delete row "${item.checkText}"?`)) return;
    try {
      await deletePmPlanItem(item.id);
      await onChanged();
    } catch (e) {
      onToast('err', e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <tr className="border-t border-line-subtle align-top">
      <td className="px-3 py-2">
        <input
          value={component}
          onChange={(e) => setComponent(e.target.value)}
          onBlur={() => {
            const v = component.trim();
            if (v && v !== item.component) void flush({ component: v });
          }}
          className="w-full rounded border border-transparent bg-transparent px-1 py-0.5 hover:border-line focus:border-accent focus:bg-surface"
        />
      </td>
      <td className="px-3 py-2">
        <input
          value={checkText}
          onChange={(e) => setCheckText(e.target.value)}
          onBlur={() => {
            const v = checkText.trim();
            if (v && v !== item.checkText) void flush({ checkText: v });
          }}
          className="w-full rounded border border-transparent bg-transparent px-1 py-0.5 hover:border-line focus:border-accent focus:bg-surface"
        />
      </td>
      <td className="px-3 py-2">
        <input
          value={remarks}
          onChange={(e) => setRemarks(e.target.value)}
          onBlur={() => {
            const v = remarks.trim() || null;
            if (v !== (item.remarks ?? null)) void flush({ remarks: v });
          }}
          className="w-full rounded border border-transparent bg-transparent px-1 py-0.5 hover:border-line focus:border-accent focus:bg-surface"
          placeholder="—"
        />
      </td>
      <td className="px-3 py-2">
        <Select
          value={item.frequency}
          onChange={(e) => {
            const v = e.target.value as PmPlanFrequency;
            if (v !== item.frequency) void flush({ frequency: v });
          }}
        >
          {FREQUENCY_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
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

function NewItemRow({
  planId,
  docs,
  onAdded,
  onToast,
}: {
  planId: string;
  docs: AdminPmProcedureDoc[];
  onAdded: () => Promise<void>;
  onToast: (tone: 'ok' | 'err', body: string) => void;
}) {
  const [component, setComponent] = useState('');
  const [checkText, setCheckText] = useState('');
  const [remarks, setRemarks] = useState('');
  const [frequency, setFrequency] = useState<PmPlanFrequency>('M');
  const [documentId, setDocumentId] = useState<string>('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!component.trim() || !checkText.trim()) return;
    setBusy(true);
    try {
      await createPmPlanItem(planId, {
        component: component.trim(),
        checkText: checkText.trim(),
        remarks: remarks.trim() || null,
        frequency,
        documentId: documentId || null,
      });
      setComponent('');
      setCheckText('');
      setRemarks('');
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
      className="grid grid-cols-[11rem_1fr_1fr_8rem_12rem_2rem] items-center gap-2 border-t border-line-subtle bg-surface-inset px-3 py-2"
    >
      <input
        value={component}
        onChange={(e) => setComponent(e.target.value)}
        placeholder="Component"
        className="rounded border border-line bg-surface px-2 py-1 text-sm"
      />
      <input
        value={checkText}
        onChange={(e) => setCheckText(e.target.value)}
        placeholder="Check (e.g., Check for plastic dust)"
        className="rounded border border-line bg-surface px-2 py-1 text-sm"
      />
      <input
        value={remarks}
        onChange={(e) => setRemarks(e.target.value)}
        placeholder="Remarks (optional)"
        className="rounded border border-line bg-surface px-2 py-1 text-sm"
      />
      <Select
        value={frequency}
        onChange={(e) => setFrequency(e.target.value as PmPlanFrequency)}
      >
        {FREQUENCY_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </Select>
      <Select
        value={documentId}
        onChange={(e) => setDocumentId(e.target.value)}
      >
        <option value="">— None —</option>
        {docs.map((d) => (
          <option key={d.id} value={d.id}>
            {d.title}
          </option>
        ))}
      </Select>
      <button
        type="submit"
        disabled={busy || !component.trim() || !checkText.trim()}
        className="rounded bg-accent p-1 text-white disabled:opacity-40"
        title="Add row"
        aria-label="Add row"
      >
        <Plus size={14} />
      </button>
    </form>
  );
}
