'use client';

// CategoryManagerModal — manage the org's procedure step categories.
// Surfaces built-ins (read-only) and the org's custom categories with
// inline rename, color, icon, and delete. Built-ins (Safety, Verification)
// are owned by the migration; the modal renders them with a 🔒 lock chip
// and disables the controls.
//
// Why this lives in procedure-cms: the categories drive both the section
// header picker and the per-step badge — both authoring surfaces. Keeping
// the manager local to the authoring flow lets an author add a new
// category mid-edit without breaking concentration.

import { useEffect, useId, useMemo, useState } from 'react';
import { Lock, Plus, Trash2, X } from 'lucide-react';
import {
  createProcedureStepCategory,
  deleteProcedureStepCategory,
  listProcedureStepCategories,
  updateProcedureStepCategory,
  type AdminProcedureStepCategory,
} from '@/lib/api';
import { useToast } from '@/components/toast';
import { CATEGORY_ICON_OPTIONS, CategoryIcon } from './category-icon';

interface Props {
  open: boolean;
  onClose: () => void;
  organizationId: string;
  /** Called whenever the list changes — lets the parent refresh its own
   *  copy of the categories list. */
  onChanged?: (cats: AdminProcedureStepCategory[]) => void;
}

// Safe default palette — keys readable on light + dark backgrounds.
// Authors can also type a custom hex.
const PALETTE: ReadonlyArray<{ name: string; color: string }> = [
  { name: 'Yellow', color: '#EAB308' },
  { name: 'Amber', color: '#F59E0B' },
  { name: 'Orange', color: '#F97316' },
  { name: 'Red', color: '#DC2626' },
  { name: 'Rose', color: '#E11D48' },
  { name: 'Pink', color: '#DB2777' },
  { name: 'Purple', color: '#9333EA' },
  { name: 'Indigo', color: '#4F46E5' },
  { name: 'Blue', color: '#2563EB' },
  { name: 'Sky', color: '#0284C7' },
  { name: 'Teal', color: '#0D9488' },
  { name: 'Green', color: '#16A34A' },
  { name: 'Emerald', color: '#059669' },
  { name: 'Lime', color: '#65A30D' },
  { name: 'Slate', color: '#64748B' },
  { name: 'Zinc', color: '#52525B' },
];

export function CategoryManagerModal({
  open,
  onClose,
  organizationId,
  onChanged,
}: Props) {
  const [cats, setCats] = useState<AdminProcedureStepCategory[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState('#2563EB');
  const [newIcon, setNewIcon] = useState<string | null>(null);
  const [savingNew, setSavingNew] = useState(false);
  const toast = useToast();

  // Initial + reload on open.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const rows = await listProcedureStepCategories(organizationId);
        if (!cancelled) {
          setCats(rows);
          setErr(null);
        }
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, organizationId]);

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  function pushChange(next: AdminProcedureStepCategory[]) {
    setCats(next);
    onChanged?.(next);
  }

  async function addNew() {
    const name = newName.trim();
    if (!name) {
      toast.error('Name required', 'Give the category a short label like "Calibration".');
      return;
    }
    if (!/^#[0-9a-fA-F]{6}$/.test(newColor)) {
      toast.error(
        'Invalid color',
        'Color must be a 6-digit hex like "#EAB308". Pick from the palette or paste a custom hex.',
      );
      return;
    }
    setSavingNew(true);
    try {
      const created = await createProcedureStepCategory(organizationId, {
        name,
        color: newColor,
        icon: newIcon,
      });
      pushChange([...(cats ?? []), created]);
      setNewName('');
      setNewColor('#2563EB');
      setNewIcon(null);
      setAdding(false);
    } catch (e) {
      toast.error(
        'Could not create category',
        e instanceof Error ? e.message : String(e),
      );
    } finally {
      setSavingNew(false);
    }
  }

  async function patchCat(id: string, patch: Partial<AdminProcedureStepCategory>) {
    if (!cats) return;
    // Optimistic update — roll back on error.
    const prev = cats;
    const next = cats.map((c) => (c.id === id ? { ...c, ...patch } : c));
    setCats(next);
    try {
      const updated = await updateProcedureStepCategory(id, {
        name: patch.name,
        color: patch.color,
        icon: patch.icon,
      });
      const reconciled = next.map((c) => (c.id === id ? updated : c));
      pushChange(reconciled);
    } catch (e) {
      setCats(prev);
      toast.error(
        'Could not update category',
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  async function deleteCat(id: string) {
    if (!cats) return;
    const cat = cats.find((c) => c.id === id);
    if (!cat) return;
    if (
      !confirm(
        `Delete category "${cat.name}"? Any sections or steps using it will fall back to neutral coloring.`,
      )
    ) {
      return;
    }
    const prev = cats;
    pushChange(cats.filter((c) => c.id !== id));
    try {
      await deleteProcedureStepCategory(id);
    } catch (e) {
      setCats(prev);
      toast.error(
        'Could not delete category',
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-line bg-surface-raised shadow-xl">
        <header className="flex items-center justify-between border-b border-line px-5 py-3">
          <div>
            <h2 className="text-lg font-semibold">Step categories</h2>
            <p className="text-sm text-ink-tertiary">
              Categories color-code your phase-progress strip and per-step
              badges. Built-ins are managed by the platform.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1.5 text-ink-tertiary hover:bg-surface-elevated hover:text-ink-primary"
            aria-label="Close"
          >
            <X className="size-5" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {loading && (
            <p className="text-sm text-ink-tertiary">Loading categories…</p>
          )}
          {err && (
            <p className="rounded-md border border-signal-fault/40 bg-signal-fault/10 p-3 text-sm text-signal-fault">
              {err}
            </p>
          )}
          {cats && cats.length === 0 && !loading && (
            <p className="text-sm text-ink-tertiary">
              No categories yet. Built-ins are seeded by the platform —
              this org list will appear here once you add a custom one.
            </p>
          )}
          {cats && cats.length > 0 && (
            <ul className="flex flex-col gap-2">
              {cats.map((c) => (
                <CategoryRow
                  key={c.id}
                  cat={c}
                  onPatch={(p) => patchCat(c.id, p)}
                  onDelete={() => deleteCat(c.id)}
                />
              ))}
            </ul>
          )}

          {adding ? (
            <div className="mt-4 rounded-md border border-accent/40 bg-accent/5 p-3">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-accent">
                New category
              </p>
              <label className="mb-2 block text-xs text-ink-tertiary">
                Name
                <input
                  autoFocus
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="e.g. Calibration, Sign-off, Customer present"
                  className="mt-1 w-full rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-ink-primary outline-none focus:border-accent"
                />
              </label>
              <div className="mb-2">
                <p className="mb-1 text-xs text-ink-tertiary">Color</p>
                <ColorSwatchPicker value={newColor} onChange={setNewColor} />
              </div>
              <div className="mb-3">
                <p className="mb-1 text-xs text-ink-tertiary">Icon (optional)</p>
                <IconPicker value={newIcon} onChange={setNewIcon} color={newColor} />
              </div>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setAdding(false);
                    setNewName('');
                    setNewColor('#2563EB');
                    setNewIcon(null);
                  }}
                  className="rounded-md border border-line bg-surface px-3 py-1.5 text-sm text-ink-secondary hover:border-ink-primary"
                  disabled={savingNew}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={addNew}
                  disabled={savingNew || !newName.trim()}
                  className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-accent/90 disabled:opacity-50"
                >
                  {savingNew ? 'Saving…' : 'Add category'}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="mt-4 inline-flex items-center gap-2 rounded-md border border-dashed border-line bg-surface px-3 py-2 text-sm font-medium text-ink-secondary transition hover:border-accent/40 hover:text-accent"
            >
              <Plus className="size-4" />
              Add custom category
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// One row in the manager list. Built-ins are read-only.
function CategoryRow({
  cat,
  onPatch,
  onDelete,
}: {
  cat: AdminProcedureStepCategory;
  onPatch: (p: Partial<AdminProcedureStepCategory>) => void;
  onDelete: () => void;
}) {
  const readOnly = cat.isBuiltIn;
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(cat.name);
  const [color, setColor] = useState(cat.color);
  const [icon, setIcon] = useState<string | null>(cat.icon);

  useEffect(() => {
    setName(cat.name);
    setColor(cat.color);
    setIcon(cat.icon);
  }, [cat]);

  function commit() {
    const patch: Partial<AdminProcedureStepCategory> = {};
    if (name.trim() && name !== cat.name) patch.name = name.trim();
    if (color !== cat.color && /^#[0-9a-fA-F]{6}$/.test(color)) patch.color = color;
    if (icon !== cat.icon) patch.icon = icon;
    if (Object.keys(patch).length > 0) onPatch(patch);
    setEditing(false);
  }

  return (
    <li className="rounded-md border border-line bg-surface px-3 py-2">
      <div className="flex items-center gap-3">
        <span
          aria-hidden
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-white"
          style={{ backgroundColor: cat.color }}
          title={cat.color}
        >
          <CategoryIcon name={cat.icon} size={14} />
        </span>
        <div className="flex-1 min-w-0">
          <p className="truncate text-sm font-medium text-ink-primary">
            {cat.name}
            {readOnly && (
              <span className="ml-2 inline-flex items-center gap-1 rounded bg-surface-elevated px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-ink-tertiary">
                <Lock className="size-2.5" /> Built-in
              </span>
            )}
          </p>
          <p className="truncate text-xs text-ink-tertiary">
            {cat.color}
            {cat.icon ? ` · ${cat.icon}` : ''}
          </p>
        </div>
        {!readOnly && (
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setEditing((v) => !v)}
              className="rounded border border-line bg-surface px-2 py-1 text-xs text-ink-secondary hover:border-ink-primary"
            >
              {editing ? 'Cancel' : 'Edit'}
            </button>
            <button
              type="button"
              onClick={onDelete}
              className="rounded p-1 text-ink-tertiary hover:bg-signal-fault/10 hover:text-signal-fault"
              aria-label="Delete category"
            >
              <Trash2 className="size-4" />
            </button>
          </div>
        )}
      </div>
      {editing && !readOnly && (
        <div className="mt-2 flex flex-col gap-2 rounded bg-surface-elevated p-2">
          <label className="block text-xs text-ink-tertiary">
            Name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1 w-full rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-ink-primary outline-none focus:border-accent"
            />
          </label>
          <div>
            <p className="mb-1 text-xs text-ink-tertiary">Color</p>
            <ColorSwatchPicker value={color} onChange={setColor} />
          </div>
          <div>
            <p className="mb-1 text-xs text-ink-tertiary">Icon</p>
            <IconPicker value={icon} onChange={setIcon} color={color} />
          </div>
          <div className="flex justify-end">
            <button
              type="button"
              onClick={commit}
              className="rounded-md bg-accent px-3 py-1 text-xs font-medium text-white shadow-sm hover:bg-accent/90"
            >
              Save
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

function ColorSwatchPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const customRef = useId();
  const isCustom = !PALETTE.find((p) => p.color.toLowerCase() === value.toLowerCase());
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {PALETTE.map((p) => {
        const selected = p.color.toLowerCase() === value.toLowerCase();
        return (
          <button
            key={p.color}
            type="button"
            onClick={() => onChange(p.color)}
            aria-pressed={selected}
            title={`${p.name} ${p.color}`}
            className={[
              'size-7 rounded-md transition',
              selected
                ? 'ring-2 ring-offset-1 ring-ink-primary ring-offset-surface'
                : 'ring-1 ring-line hover:ring-ink-tertiary',
            ].join(' ')}
            style={{ backgroundColor: p.color }}
          />
        );
      })}
      <label
        htmlFor={customRef}
        className={[
          'ml-2 inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs',
          isCustom
            ? 'border-accent text-accent'
            : 'border-line text-ink-tertiary',
        ].join(' ')}
      >
        Custom
        <input
          id={customRef}
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="#A1B2C3"
          maxLength={7}
          className="w-20 bg-transparent text-ink-primary outline-none"
        />
      </label>
    </div>
  );
}

function IconPicker({
  value,
  onChange,
  color,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
  color: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      <button
        type="button"
        onClick={() => onChange(null)}
        aria-pressed={value === null}
        title="No icon"
        className={[
          'inline-flex size-8 items-center justify-center rounded-md border text-[10px]',
          value === null
            ? 'border-accent bg-accent/10 text-accent'
            : 'border-line text-ink-tertiary hover:border-ink-tertiary',
        ].join(' ')}
      >
        none
      </button>
      {CATEGORY_ICON_OPTIONS.map((opt) => {
        const selected = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            aria-pressed={selected}
            title={`${opt.label} (${opt.value})`}
            className={[
              'inline-flex size-8 items-center justify-center rounded-md border transition',
              selected
                ? 'border-accent'
                : 'border-line hover:border-ink-tertiary',
            ].join(' ')}
            style={selected ? { backgroundColor: color, color: 'white' } : undefined}
          >
            <opt.Icon size={14} strokeWidth={2} />
          </button>
        );
      })}
    </div>
  );
}
