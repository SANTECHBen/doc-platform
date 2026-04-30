'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  listPartsForDocument,
  setPartsForDocument,
  listAdminParts,
  type AdminPart,
  type LinkedPart,
} from '@/lib/api';
import { ErrorBanner, PrimaryButton, SecondaryButton, TextInput } from '@/components/form';
import { useToast } from '@/components/toast';

// "Linked Parts" tab — shows the parts directly linked to THE WHOLE DOCUMENT
// (legacy partDocuments link) + lets the admin manage that link set. Sections
// have their own per-section parts editor inside the section drawer; this is
// for the document-level link, which is what the PWA falls back to when the
// doc has no sections.
export function LinkedPartsTab({ documentId }: { documentId: string }) {
  const [linked, setLinked] = useState<LinkedPart[] | null>(null);
  const [allParts, setAllParts] = useState<AdminPart[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<Set<string>>(new Set());
  const toast = useToast();

  async function refresh() {
    try {
      const [parts, all] = await Promise.all([
        listPartsForDocument(documentId),
        listAdminParts(),
      ]);
      setLinked(parts);
      setAllParts(all);
      setDraft(new Set(parts.map((p) => p.partId)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId]);

  function toggle(partId: string) {
    setDraft((prev) => {
      const next = new Set(prev);
      if (next.has(partId)) next.delete(partId);
      else next.add(partId);
      return next;
    });
  }

  async function onSave() {
    setSaving(true);
    try {
      await setPartsForDocument(documentId, [...draft]);
      toast.success(`Linked ${draft.size} part${draft.size === 1 ? '' : 's'}`);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  if (!allParts || !linked) {
    return <p className="text-sm text-ink-tertiary">Loading…</p>;
  }

  const dirty =
    draft.size !== linked.length ||
    [...draft].some((id) => !linked.find((l) => l.partId === id));

  const visible = allParts.filter((p) => {
    if (!filter) return true;
    const q = filter.toLowerCase();
    return (
      p.oemPartNumber.toLowerCase().includes(q) ||
      p.displayName.toLowerCase().includes(q)
    );
  });

  return (
    <div className="space-y-4">
      <ErrorBanner error={error} />
      <p className="text-sm text-ink-secondary">
        Document-level part links. Used as the legacy fallback when the document has no
        sections — for section-aware authoring, link parts to individual sections instead.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <TextInput
          placeholder="Filter parts…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="max-w-sm"
        />
        <span className="text-xs text-ink-tertiary">
          {draft.size} selected of {allParts.length}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <SecondaryButton
            type="button"
            onClick={() => setDraft(new Set(linked.map((l) => l.partId)))}
            disabled={!dirty}
          >
            Reset
          </SecondaryButton>
          <PrimaryButton type="button" onClick={onSave} disabled={!dirty || saving}>
            {saving ? 'Saving…' : 'Save changes'}
          </PrimaryButton>
        </div>
      </div>

      <div className="overflow-hidden rounded-md border border-line-subtle bg-surface-raised">
        <table className="w-full text-sm">
          <thead className="bg-surface text-left text-xs uppercase tracking-wide text-ink-tertiary">
            <tr>
              <th className="w-10 px-3 py-2"></th>
              <th className="px-3 py-2">OEM #</th>
              <th className="px-3 py-2">Display name</th>
              <th className="px-3 py-2 text-right">BOM uses</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line-subtle">
            {visible.map((p) => (
              <tr key={p.id} className="hover:bg-surface">
                <td className="px-3 py-2">
                  <input
                    type="checkbox"
                    checked={draft.has(p.id)}
                    onChange={() => toggle(p.id)}
                    aria-label={`Link ${p.displayName}`}
                  />
                </td>
                <td className="px-3 py-2 font-mono text-xs">{p.oemPartNumber}</td>
                <td className="px-3 py-2">
                  <Link
                    href={`/parts?focus=${encodeURIComponent(p.id)}`}
                    className="hover:text-accent hover:underline"
                  >
                    {p.displayName}
                  </Link>
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-ink-tertiary">
                  {p.bomCount}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
