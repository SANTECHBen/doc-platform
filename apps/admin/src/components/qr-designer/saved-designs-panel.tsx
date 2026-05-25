'use client';

// Sidebar panel listing every QR design saved to the platform. Lists are
// org-scoped — anyone in the same organization shares the same library, so
// branded artwork created by one teammate is immediately available to the
// others. Each row shows a tiny dot-grid thumbnail tinted with the design's
// primary color, the name, who saved it (when it wasn't you), and the
// last-saved time. Click-row to load; pencil/trash on hover (own designs
// only) to rename or delete.

import { useState } from 'react';
import { BookmarkPlus, Folder, Loader2, Pencil, Trash2 } from 'lucide-react';
import { PanelSection } from './panels';
import {
  deleteSavedDesignFromServer,
  renameSavedDesignOnServer,
  type SavedDesign,
} from '@/lib/qr-designer-storage';
import type { ColorSpec, QrStyleSpec } from '@/lib/qr-style';

export interface SavedDesignsPanelProps {
  designs: SavedDesign[];
  /** True while the initial server fetch is in flight. */
  loading: boolean;
  /** Non-null when the initial server fetch failed. */
  loadError: string | null;
  activeId: string | null;
  onLoad: (design: SavedDesign) => void;
  /** Optimistic update path — caller swaps the list when one entry changes. */
  onChange: (designs: SavedDesign[]) => void;
  /** Surface server errors via the same toast layer as the rest of the
   *  designer instead of returning errors. */
  onError: (message: string) => void;
  onOpenSaveDialog: () => void;
  onRetry: () => void;
}

export function SavedDesignsPanel({
  designs,
  loading,
  loadError,
  activeId,
  onLoad,
  onChange,
  onError,
  onOpenSaveDialog,
  onRetry,
}: SavedDesignsPanelProps) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  function startRename(d: SavedDesign) {
    setRenamingId(d.id);
    setRenameValue(d.name);
  }

  async function commitRename(id: string) {
    setBusyId(id);
    try {
      const updated = await renameSavedDesignOnServer(id, renameValue);
      onChange(designs.map((d) => (d.id === id ? updated : d)));
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setRenamingId(null);
      setBusyId(null);
    }
  }

  async function onDelete(d: SavedDesign) {
    if (!confirm(`Delete "${d.name}"? This can't be undone.`)) return;
    setBusyId(d.id);
    try {
      await deleteSavedDesignFromServer(d.id);
      onChange(designs.filter((x) => x.id !== d.id));
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <PanelSection title="Saved designs" icon={Folder}>
      <button
        type="button"
        onClick={onOpenSaveDialog}
        className="flex w-full items-center justify-center gap-1.5 rounded border border-dashed border-line bg-surface px-2 py-2 text-xs font-medium text-ink-secondary transition hover:border-brand/40 hover:bg-brand/5 hover:text-brand"
      >
        <BookmarkPlus size={12} strokeWidth={2} />
        Save current design…
      </button>

      {loading ? (
        <p className="flex items-center justify-center gap-2 py-3 text-[11px] text-ink-tertiary">
          <Loader2 size={11} className="animate-spin" strokeWidth={2} />
          Loading designs…
        </p>
      ) : loadError ? (
        <div className="rounded border border-signal-fault/40 bg-signal-fault/10 p-2 text-[11px] text-signal-fault">
          <p>Couldn&rsquo;t load saved designs.</p>
          <p className="mt-1 text-ink-tertiary">{loadError}</p>
          <button
            type="button"
            onClick={onRetry}
            className="mt-2 rounded border border-line bg-surface px-2 py-1 text-[10px] text-ink-primary hover:bg-surface-inset"
          >
            Retry
          </button>
        </div>
      ) : designs.length === 0 ? (
        <p className="text-center text-[11px] leading-snug text-ink-tertiary">
          Nothing saved yet. Designs are stored on the server and shared with
          your organization, so anyone on the team can reuse them.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {designs.map((d) => {
            const isActive = d.id === activeId;
            const isRenaming = d.id === renamingId;
            const isBusy = d.id === busyId;
            return (
              <li
                key={d.id}
                className={`group flex items-center gap-2 rounded-md border px-2 py-1.5 transition ${
                  isActive
                    ? 'border-brand/40 bg-brand/5'
                    : 'border-line bg-surface hover:border-brand/40 hover:bg-brand/5'
                }`}
              >
                <button
                  type="button"
                  onClick={() => !isRenaming && onLoad(d)}
                  className="flex flex-1 items-center gap-2 text-left"
                  disabled={isBusy || isRenaming}
                  title={`Load "${d.name}"`}
                >
                  <DesignThumb spec={d.spec} />
                  <div className="min-w-0 flex-1">
                    {isRenaming ? (
                      <input
                        autoFocus
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onBlur={() => commitRename(d.id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitRename(d.id);
                          if (e.key === 'Escape') setRenamingId(null);
                        }}
                        maxLength={120}
                        className="w-full rounded border border-line bg-surface px-1.5 py-0.5 text-xs"
                      />
                    ) : (
                      <span className="block truncate text-xs font-medium text-ink-primary">
                        {d.name}
                      </span>
                    )}
                    <span className="block truncate text-[10px] text-ink-tertiary">
                      {formatWhen(d.savedAt)}
                      {!d.canEdit && d.ownerDisplayName && (
                        <> · saved by {d.ownerDisplayName}</>
                      )}
                    </span>
                  </div>
                </button>
                {!isRenaming && d.canEdit && (
                  <div className="hidden items-center gap-0.5 group-hover:flex">
                    <button
                      type="button"
                      onClick={() => startRename(d)}
                      title="Rename"
                      aria-label="Rename design"
                      className="rounded p-1 text-ink-tertiary hover:bg-surface-inset hover:text-ink-primary"
                      disabled={isBusy}
                    >
                      <Pencil size={11} strokeWidth={2} />
                    </button>
                    <button
                      type="button"
                      onClick={() => onDelete(d)}
                      title="Delete"
                      aria-label="Delete design"
                      className="rounded p-1 text-ink-tertiary hover:bg-signal-fault/10 hover:text-signal-fault"
                      disabled={isBusy}
                    >
                      <Trash2 size={11} strokeWidth={2} />
                    </button>
                  </div>
                )}
                {isBusy && (
                  <Loader2 size={11} strokeWidth={2} className="animate-spin text-ink-tertiary" />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </PanelSection>
  );
}

// Small static dot-grid that hints at the design's primary color + module
// shape. Pure SVG — never invokes the QR engine, keeping the list snappy.
function DesignThumb({ spec }: { spec: QrStyleSpec }) {
  const fg = colorOf(spec.dotColor);
  const bg =
    spec.background.mode === 'solid' && spec.background.color !== 'transparent'
      ? spec.background.color
      : '#ffffff';
  const pattern: number[][] = [
    [1, 1, 1, 0, 1],
    [1, 0, 1, 1, 0],
    [0, 1, 1, 0, 1],
    [1, 1, 0, 1, 1],
    [0, 1, 1, 1, 0],
  ];
  const cell = 100 / 5;
  const r =
    spec.dotShape === 'extra-rounded'
      ? cell * 0.4
      : spec.dotShape === 'rounded' || spec.dotShape.startsWith('classy')
        ? cell * 0.2
        : 0;
  return (
    <svg
      viewBox="0 0 100 100"
      className="h-7 w-7 shrink-0 rounded"
      style={{ backgroundColor: bg }}
    >
      {pattern.flatMap((row, ry) =>
        row.map((on, rx) => {
          if (!on) return null;
          const x = rx * cell + cell * 0.15;
          const y = ry * cell + cell * 0.15;
          const s = cell * 0.7;
          if (spec.dotShape === 'dots') {
            return (
              <circle
                key={`${rx}-${ry}`}
                cx={x + s / 2}
                cy={y + s / 2}
                r={s / 2}
                fill={fg}
              />
            );
          }
          return <rect key={`${rx}-${ry}`} x={x} y={y} width={s} height={s} rx={r} fill={fg} />;
        }),
      )}
    </svg>
  );
}

function colorOf(c: ColorSpec): string {
  if (c.mode === 'solid') return c.color;
  return c.stops[0]?.color ?? '#0a0c0f';
}

function formatWhen(iso: string): string {
  const then = new Date(iso);
  const now = new Date();
  const ms = now.getTime() - then.getTime();
  const mins = Math.round(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days}d ago`;
  return then.toLocaleDateString();
}
