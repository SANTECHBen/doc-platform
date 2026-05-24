'use client';

// CategoryPicker — compact picker button + popover used in both the
// section header (to color the phase strip) and the step kebab menu
// (to set a per-step badge override). Receives a pre-loaded categories
// list from the parent — the editor fetches once and shares the list
// across pickers to avoid an N+1 per section.

import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Settings2, Tag } from 'lucide-react';
import type { AdminProcedureStepCategory } from '@/lib/api';
import { CategoryIcon } from './category-icon';

interface Props {
  /** Currently selected category id (or null for "none"). */
  value: string | null;
  /** Full list of categories visible to the caller (built-ins + this
   *  org's). Order is preserved in the popover. */
  options: AdminProcedureStepCategory[];
  /** Persist the new selection. `null` clears the category. */
  onChange: (next: string | null) => void;
  /** Label for the empty state (e.g. "No category", "Inherit"). */
  emptyLabel?: string;
  /** Width hint for the trigger. Defaults to a sensible inline width. */
  size?: 'sm' | 'md';
  /** Optional "Manage…" handler — shown as a footer link in the popover.
   *  Omit to hide the link. */
  onManage?: () => void;
  /** Aria label override for the trigger. */
  ariaLabel?: string;
}

export function CategoryPicker({
  value,
  options,
  onChange,
  emptyLabel = 'No category',
  size = 'sm',
  onManage,
  ariaLabel,
}: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const selected = options.find((o) => o.id === value) ?? null;

  // Close on outside click + Escape.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Render the trigger as a colored chip when something is selected, or
  // a neutral "Add category" pill otherwise. Keeps the section header
  // scannable — the color itself communicates the choice.
  const trigger = selected ? (
    <span
      className={[
        'inline-flex items-center gap-1.5 rounded-md text-xs font-medium text-white shadow-sm',
        size === 'md' ? 'px-2.5 py-1.5' : 'px-2 py-1',
      ].join(' ')}
      style={{ backgroundColor: selected.color }}
    >
      <CategoryIcon name={selected.icon} size={12} strokeWidth={2.25} />
      {selected.name}
      <ChevronDown size={12} strokeWidth={2} className="opacity-80" />
    </span>
  ) : (
    <span
      className={[
        'inline-flex items-center gap-1.5 rounded-md border border-dashed border-line bg-surface text-xs text-ink-tertiary hover:border-accent/40 hover:text-accent',
        size === 'md' ? 'px-2.5 py-1.5' : 'px-2 py-1',
      ].join(' ')}
    >
      <Tag size={12} strokeWidth={2} />
      {emptyLabel}
      <ChevronDown size={12} strokeWidth={2} />
    </span>
  );

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel ?? (selected ? `Category: ${selected.name}` : 'Pick category')}
      >
        {trigger}
      </button>
      {open && (
        <div
          role="listbox"
          className="absolute left-0 z-30 mt-1 max-h-80 w-60 overflow-y-auto rounded-md border border-line bg-surface-raised shadow-lg"
        >
          <button
            type="button"
            role="option"
            aria-selected={value === null}
            onClick={() => {
              setOpen(false);
              onChange(null);
            }}
            className={[
              'flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition hover:bg-surface-elevated',
              value === null ? 'font-semibold text-accent' : 'text-ink-primary',
            ].join(' ')}
          >
            <span className="inline-flex size-5 items-center justify-center rounded border border-dashed border-line text-[10px] text-ink-tertiary">
              ∅
            </span>
            <span className="flex-1 truncate">{emptyLabel}</span>
            {value === null && <Check size={14} className="text-accent" />}
          </button>
          {options.length === 0 && (
            <p className="px-3 py-2 text-xs text-ink-tertiary">
              No categories yet. Add one from "Manage…" below.
            </p>
          )}
          {options.map((c) => (
            <button
              key={c.id}
              type="button"
              role="option"
              aria-selected={value === c.id}
              onClick={() => {
                setOpen(false);
                onChange(c.id);
              }}
              className={[
                'flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition hover:bg-surface-elevated',
                value === c.id ? 'font-semibold' : 'text-ink-primary',
              ].join(' ')}
            >
              <span
                aria-hidden
                className="inline-flex size-5 shrink-0 items-center justify-center rounded text-white"
                style={{ backgroundColor: c.color }}
              >
                <CategoryIcon name={c.icon} size={11} />
              </span>
              <span className="flex-1 truncate">{c.name}</span>
              {c.isBuiltIn && (
                <span className="text-[10px] uppercase tracking-wider text-ink-tertiary">
                  Built-in
                </span>
              )}
              {value === c.id && <Check size={14} className="text-accent" />}
            </button>
          ))}
          {onManage && (
            <>
              <hr className="my-1 border-line-subtle" />
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  onManage();
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-ink-secondary transition hover:bg-surface-elevated"
              >
                <Settings2 size={12} />
                Manage categories…
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
