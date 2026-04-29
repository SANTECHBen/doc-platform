'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Check, Copy, ExternalLink, Layers, Plus, Printer, QrCode as QrCodeIcon, Trash2 } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { PageHeader, PageShell } from '@/components/page-shell';
import { EmptyState } from '@/components/empty-state';
import { NextStepHint } from '@/components/next-step-hint';
import { useToast } from '@/components/toast';
import {
  deleteQrCode,
  listAssetInstances,
  listQrCodes,
  listQrLabelTemplates,
  mintQrCode,
  updateQrCode,
  PUBLIC_PWA_ORIGIN,
  type AdminAssetInstance,
  type AdminQrCode,
  type AdminQrLabelTemplate,
} from '@/lib/api';

export default function QrCodesPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const continueOrgId = searchParams?.get('continue') ?? null;
  const [codes, setCodes] = useState<AdminQrCode[] | null>(null);
  const [instances, setInstances] = useState<AdminAssetInstance[] | null>(null);
  const [templates, setTemplates] = useState<AdminQrLabelTemplate[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('');
  const [newQrTemplateId, setNewQrTemplateId] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [minting, setMinting] = useState(false);
  const [selectedInstanceId, setSelectedInstanceId] = useState('');
  const [label, setLabel] = useState('');
  const [selectedCodeIds, setSelectedCodeIds] = useState<Set<string>>(new Set());
  const toast = useToast();

  // When walking through tenant setup, narrow the picker to that tenant's
  // instances so the admin can't accidentally mint a QR for the wrong org.
  const visibleInstances = useMemo(() => {
    if (!instances) return [];
    if (!continueOrgId) return instances;
    return instances.filter((i) => i.organization.id === continueOrgId);
  }, [instances, continueOrgId]);

  useEffect(() => {
    Promise.all([listQrCodes(), listAssetInstances(), listQrLabelTemplates()])
      .then(([c, i, tpls]) => {
        setCodes(c);
        setInstances(i);
        setTemplates(tpls);
        // Pre-select an instance from the continue org when present.
        const firstForOrg = continueOrgId
          ? i.find((x) => x.organization.id === continueOrgId)
          : null;
        if (firstForOrg) setSelectedInstanceId(firstForOrg.id);
        else if (i[0]) setSelectedInstanceId(i[0].id);
        // Pre-select the org default so printing picks it up without a
        // second click. Falls back to the first template, then empty.
        // Same default applies to the new-QR template picker so freshly
        // generated codes inherit the org's preferred design.
        const def = tpls.find((t) => t.isDefault) ?? tpls[0];
        if (def) {
          setSelectedTemplateId(def.id);
          setNewQrTemplateId(def.id);
        }
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  async function onMint(continueAfter = false) {
    if (!selectedInstanceId) return;
    setMinting(true);
    setError(null);
    try {
      await mintQrCode({
        assetInstanceId: selectedInstanceId,
        label: label.trim() || undefined,
        preferredTemplateId: newQrTemplateId || null,
      });
      setLabel('');
      const refreshed = await listQrCodes();
      setCodes(refreshed);
      if (continueAfter && continueOrgId) {
        toast.success('QR code minted', 'Tenant setup complete.');
        router.push(`/tenants/${continueOrgId}`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setMinting(false);
    }
  }

  async function onChangeTemplate(codeId: string, templateId: string) {
    try {
      await updateQrCode(codeId, { preferredTemplateId: templateId || null });
      setCodes((prev) =>
        (prev ?? []).map((c) =>
          c.id === codeId
            ? {
                ...c,
                preferredTemplate: templateId
                  ? {
                      id: templateId,
                      name: templates.find((t) => t.id === templateId)?.name ?? 'Unknown',
                    }
                  : null,
              }
            : c,
        ),
      );
      toast.success('Template updated');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  async function onDelete(codeId: string, code: string) {
    if (
      !confirm(
        `Delete QR code ${code}? Any printed sticker with this code will stop resolving (scans will 404). This cannot be undone.`,
      )
    ) {
      return;
    }
    try {
      await deleteQrCode(codeId);
      setCodes((prev) => (prev ?? []).filter((c) => c.id !== codeId));
      setSelectedCodeIds((prev) => {
        const next = new Set(prev);
        next.delete(codeId);
        return next;
      });
      toast.success(`Deleted ${code}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  function toggleSelected(id: string) {
    setSelectedCodeIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAll() {
    if (!codes) return;
    setSelectedCodeIds(new Set(codes.filter((c) => c.active).map((c) => c.id)));
  }

  function clearSelection() {
    setSelectedCodeIds(new Set());
  }

  const selectedCodes = useMemo(
    () => (codes ?? []).filter((c) => selectedCodeIds.has(c.id)),
    [codes, selectedCodeIds],
  );

  function openPrintSheet() {
    if (selectedCodes.length === 0) return;
    const params = new URLSearchParams();
    for (const c of selectedCodes) params.append('id', c.id);
    if (selectedTemplateId) params.set('templateId', selectedTemplateId);
    window.open(`/qr-codes/print?${params.toString()}`, '_blank');
  }

  return (
    <PageShell crumbs={[{ label: 'QR codes' }]}>
      <PageHeader
        title="QR codes"
        description={`Labels resolve via ${PUBLIC_PWA_ORIGIN}/q/<code>. Generate one per instance, then print a sheet to apply on equipment.`}
        actions={
          <Link
            href="/qr-codes/templates"
            className="inline-flex items-center gap-1.5 rounded border border-line px-3 py-1.5 text-sm text-ink-secondary hover:bg-surface-inset"
          >
            <Layers size={14} strokeWidth={2} />
            Label templates
          </Link>
        }
      />

      <NextStepHint page="qr-codes" />
      {error && (
        <div className="rounded-md border border-signal-fault/40 bg-signal-fault/10 p-3 text-sm text-signal-fault">
          {error}
        </div>
      )}

      <section className="rounded-md border border-line-subtle bg-surface-raised p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-tertiary">
          Generate new label
        </h2>
        <div className="mt-3 flex flex-col gap-3 md:flex-row md:items-end md:flex-wrap">
          <label className="flex flex-1 min-w-[240px] flex-col gap-1 text-sm">
            <span className="text-ink-secondary">Asset instance</span>
            <select
              value={selectedInstanceId}
              onChange={(e) => setSelectedInstanceId(e.target.value)}
              className="rounded border border-line bg-surface-raised px-2 py-1.5"
            >
              {visibleInstances.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.assetModel.displayName} · {i.serialNumber} · {i.site.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-1 min-w-[180px] flex-col gap-1 text-sm">
            <span className="text-ink-secondary">Caption (shown on label)</span>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Aisle 1 east"
              className="rounded border border-line bg-surface-raised px-2 py-1.5"
            />
          </label>
          <label className="flex flex-1 min-w-[180px] flex-col gap-1 text-sm">
            <span className="text-ink-secondary">Label template</span>
            <select
              value={newQrTemplateId}
              onChange={(e) => setNewQrTemplateId(e.target.value)}
              className="rounded border border-line bg-surface-raised px-2 py-1.5"
            >
              <option value="">No preference (use print-time picker)</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                  {t.isDefault ? ' (default)' : ''}
                </option>
              ))}
            </select>
          </label>
          <div className="flex shrink-0 gap-2">
            {continueOrgId && (
              <button
                onClick={() => onMint(true)}
                disabled={minting || !selectedInstanceId}
                className="h-[34px] shrink-0 rounded border border-line px-3 text-sm text-ink-secondary hover:bg-surface-inset disabled:opacity-50"
              >
                {minting ? 'Generating…' : 'Generate & finish setup'}
              </button>
            )}
            <button
              onClick={() => onMint(false)}
              disabled={minting || !selectedInstanceId}
              className="h-[34px] shrink-0 rounded btn-primary disabled:opacity-50"
            >
              {minting ? 'Generating…' : 'Generate'}
            </button>
          </div>
        </div>
      </section>

      <section className="rounded-md border border-line-subtle bg-surface-raised">
        <div className="flex items-center justify-between border-b border-line-subtle p-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-tertiary">
            Active labels
          </h2>
          <div className="flex items-center gap-2">
            <button
              onClick={selectAll}
              className="rounded border border-line px-3 py-1 text-sm text-ink-secondary hover:bg-surface-inset"
            >
              Select all
            </button>
            <button
              onClick={clearSelection}
              disabled={selectedCodeIds.size === 0}
              className="rounded border border-line px-3 py-1 text-sm text-ink-secondary hover:bg-surface-inset disabled:opacity-50"
            >
              Clear
            </button>
            {templates.length > 0 && (
              <label className="flex items-center gap-2 text-sm text-ink-secondary">
                <span className="hidden sm:inline">Template</span>
                <select
                  value={selectedTemplateId}
                  onChange={(e) => setSelectedTemplateId(e.target.value)}
                  className="rounded border border-line bg-surface-raised px-2 py-1 text-sm"
                >
                  <option value="">Built-in nameplate</option>
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                      {t.isDefault ? ' (default)' : ''}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <button
              onClick={openPrintSheet}
              disabled={selectedCodes.length === 0}
              className="rounded btn-primary px-3 min-h-0 py-1 disabled:opacity-50"
            >
              Print sheet ({selectedCodes.length})
            </button>
          </div>
        </div>
        {!codes ? (
          <p className="p-6 text-center text-sm text-ink-tertiary">Loading…</p>
        ) : codes.length === 0 ? (
          <p className="p-6 text-center text-sm text-ink-tertiary">No QR codes yet.</p>
        ) : (
          <table className="data-table">
            <thead className="bg-surface-inset text-left text-xs uppercase tracking-wide text-ink-tertiary">
              <tr>
                <th className="w-10 px-4 py-2"></th>
                <th className="w-24 px-4 py-2">Preview</th>
                <th className="px-4 py-2">Code &amp; URL</th>
                <th className="px-4 py-2">Asset</th>
                <th className="px-4 py-2">Site</th>
                <th className="px-4 py-2">Label</th>
                <th className="px-4 py-2">Template</th>
                <th className="w-10 px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {codes.map((c) => {
                const url = `${PUBLIC_PWA_ORIGIN}/q/${c.code}`;
                return (
                  <tr key={c.id} className="border-t border-line-subtle align-top">
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        checked={selectedCodeIds.has(c.id)}
                        onChange={() => toggleSelected(c.id)}
                        disabled={!c.active}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <QRCodeSVG value={url} size={56} level="M" />
                    </td>
                    <td className="px-4 py-3">
                      <CodeWithUrl code={c.code} url={url} />
                    </td>
                    <td className="px-4 py-3">
                      {c.assetInstance ? (
                        <>
                          <span className="block text-ink-primary">
                            {c.assetInstance.modelDisplayName}
                          </span>
                          <span className="block text-xs text-ink-tertiary">
                            {c.assetInstance.serialNumber}
                          </span>
                        </>
                      ) : (
                        <span className="text-ink-tertiary">Unlinked</span>
                      )}
                    </td>
                    <td className="px-4 py-3">{c.assetInstance?.siteName ?? '—'}</td>
                    <td className="px-4 py-3 text-ink-secondary">{c.label ?? '—'}</td>
                    <td className="px-4 py-3">
                      <select
                        value={c.preferredTemplate?.id ?? ''}
                        onChange={(e) => onChangeTemplate(c.id, e.target.value)}
                        className="w-full rounded border border-line bg-surface-raised px-2 py-1 text-xs"
                      >
                        <option value="">No preference</option>
                        {templates.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.name}
                            {t.isDefault ? ' (default)' : ''}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => onDelete(c.id, c.code)}
                        className="inline-flex h-7 w-7 items-center justify-center rounded text-ink-tertiary hover:bg-signal-fault/10 hover:text-signal-fault"
                        title="Delete QR code"
                        aria-label="Delete QR code"
                      >
                        <Trash2 size={13} strokeWidth={2} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </PageShell>
  );
}

// Shows the short code on top, full URL underneath with open + copy affordances.
function CodeWithUrl({ code, url }: { code: string; url: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard API can fail in insecure contexts; user can still click the link
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <span className="font-mono text-xs text-ink-primary">{code}</span>
      <div className="flex items-center gap-1.5">
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 font-mono text-[11px] text-brand hover:underline"
          title="Open scan URL in new tab"
        >
          <ExternalLink size={10} strokeWidth={2} />
          <span className="truncate">{url}</span>
        </a>
        <button
          type="button"
          onClick={copy}
          className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-ink-tertiary transition hover:bg-surface-inset hover:text-ink-primary"
          title={copied ? 'Copied' : 'Copy URL'}
          aria-label="Copy URL"
        >
          {copied ? <Check size={11} strokeWidth={2.5} /> : <Copy size={11} strokeWidth={2} />}
        </button>
      </div>
    </div>
  );
}
