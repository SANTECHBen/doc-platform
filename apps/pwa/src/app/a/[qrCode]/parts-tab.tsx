'use client';

import { useEffect, useMemo, useState } from 'react';
import { Package, Search } from 'lucide-react';
import { listParts, type BomEntry } from '@/lib/api';

export function PartsTab({ assetModelId }: { assetModelId: string }) {
  const [rows, setRows] = useState<BomEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    let cancelled = false;
    listParts(assetModelId)
      .then((r) => {
        if (!cancelled) setRows(r);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [assetModelId]);

  const filtered = useMemo(() => {
    if (!rows) return null;
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => {
      const hay = [
        r.displayName,
        r.oemPartNumber,
        r.positionRef,
        ...r.crossReferences,
        r.description,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  }, [rows, query]);

  if (error)
    return (
      <p
        className="rounded-md border p-3 text-sm"
        style={{
          borderColor: 'rgba(var(--signal-fault) / 0.4)',
          background: 'rgba(var(--signal-fault) / 0.1)',
          color: 'rgb(var(--signal-fault))',
        }}
      >
        {error}
      </p>
    );
  if (!rows) return <p className="py-8 text-center text-sm text-ink-tertiary">Loading…</p>;
  if (rows.length === 0)
    return (
      <p className="py-8 text-center text-sm text-ink-tertiary">
        No BOM entries for this asset model.
      </p>
    );

  return (
    <div className="flex flex-col gap-4">
      <label className="search-input">
        <Search size={16} strokeWidth={2} className="text-ink-tertiary" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by part #, name, position, or cross-ref"
        />
      </label>

      <ul className="flex flex-col gap-2">
        {(filtered ?? []).map((r) => (
          <li key={r.bomEntryId} className={`part-row ${r.discontinued ? 'opacity-70' : ''}`}>
            <div className="flex items-start gap-4">
              {r.imageUrl ? (
                <img
                  src={r.imageUrl}
                  alt=""
                  className="h-14 w-14 shrink-0 rounded object-cover"
                  style={{ border: '1px solid rgb(var(--line))' }}
                />
              ) : (
                <div
                  className="flex h-14 w-14 shrink-0 items-center justify-center rounded text-ink-tertiary"
                  style={{
                    background: 'rgb(var(--surface-inset))',
                    border: '1px solid rgb(var(--line-subtle))',
                  }}
                >
                  <Package size={20} strokeWidth={1.5} />
                </div>
              )}
              <div className="flex-1">
                <div className="mb-1.5 flex items-baseline gap-3">
                  <span className="part-num">{r.oemPartNumber}</span>
                  <span className="part-name">{r.displayName}</span>
                </div>
                {r.description && <p className="part-desc mb-2">{r.description}</p>}
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px]">
                  {r.positionRef && (
                    <span className="flex items-center gap-1.5">
                      <span className="cap" style={{ letterSpacing: '0.08em' }}>Pos</span>
                      <span className="text-ink-primary">{r.positionRef}</span>
                    </span>
                  )}
                  <span className="flex items-center gap-1.5">
                    <span className="cap" style={{ letterSpacing: '0.08em' }}>Qty</span>
                    <span className="text-ink-primary tabular-nums">{r.quantity}</span>
                  </span>
                  {r.crossReferences.length > 0 && (
                    <span className="flex items-center gap-1.5">
                      <span className="cap" style={{ letterSpacing: '0.08em' }}>Xref</span>
                      {r.crossReferences.map((xr) => (
                        <span key={xr} className="part-xref">
                          {xr}
                        </span>
                      ))}
                    </span>
                  )}
                </div>
              </div>
              {r.discontinued && <span className="pill pill-warn">Discontinued</span>}
            </div>
          </li>
        ))}
        {filtered && filtered.length === 0 && (
          <li className="py-8 text-center text-sm text-ink-tertiary">
            No parts match your search.
          </li>
        )}
      </ul>
    </div>
  );
}
