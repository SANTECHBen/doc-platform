'use client';

import { useMemo, useState } from 'react';
import { TextInput } from '@/components/form';
import type { AdminPart } from '@/lib/api';

export function PartsPicker({
  allParts,
  selected,
  onChange,
}: {
  allParts: AdminPart[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
}) {
  const [filter, setFilter] = useState('');
  const visible = useMemo(() => {
    if (!filter) return allParts;
    const q = filter.toLowerCase();
    return allParts.filter(
      (p) =>
        p.oemPartNumber.toLowerCase().includes(q) ||
        p.displayName.toLowerCase().includes(q),
    );
  }, [allParts, filter]);

  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next);
  }

  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <TextInput
          placeholder="Filter parts…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <span className="shrink-0 text-xs text-ink-tertiary">
          {selected.size} selected
        </span>
      </div>
      <div className="max-h-64 overflow-y-auto rounded border border-line-subtle bg-surface">
        <ul className="divide-y divide-line-subtle">
          {visible.length === 0 && (
            <li className="px-3 py-4 text-center text-xs text-ink-tertiary">
              No parts match.
            </li>
          )}
          {visible.map((p) => (
            <li key={p.id}>
              <label className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-surface-raised">
                <input
                  type="checkbox"
                  checked={selected.has(p.id)}
                  onChange={() => toggle(p.id)}
                />
                <span className="font-mono text-xs text-ink-tertiary">
                  {p.oemPartNumber}
                </span>
                <span className="truncate text-sm text-ink-primary">{p.displayName}</span>
              </label>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
