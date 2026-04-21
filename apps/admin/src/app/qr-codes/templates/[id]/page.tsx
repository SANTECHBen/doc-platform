'use client';

import { use, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ChevronLeft, Save, Star } from 'lucide-react';
import { PageHeader, PageShell } from '@/components/page-shell';
import { useToast } from '@/components/toast';
import { QrLabel, QR_LABEL_CSS, type QrLabelTemplate } from '@/components/qr-label';
import {
  getQrLabelTemplate,
  updateQrLabelTemplate,
  PUBLIC_PWA_ORIGIN,
  type AdminQrLabelTemplate,
  type QrLabelFieldsPayload,
} from '@/lib/api';

type Draft = Pick<
  AdminQrLabelTemplate,
  | 'name'
  | 'isDefault'
  | 'layout'
  | 'accentColor'
  | 'logoStorageKey'
  | 'qrSize'
  | 'qrErrorCorrection'
  | 'fields'
>;

export default function TemplateEditorPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const toast = useToast();
  const [original, setOriginal] = useState<AdminQrLabelTemplate | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getQrLabelTemplate(id)
      .then((tpl) => {
        setOriginal(tpl);
        setDraft({
          name: tpl.name,
          isDefault: tpl.isDefault,
          layout: tpl.layout,
          accentColor: tpl.accentColor,
          logoStorageKey: tpl.logoStorageKey,
          qrSize: tpl.qrSize,
          qrErrorCorrection: tpl.qrErrorCorrection,
          fields: tpl.fields,
        });
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [id]);

  const dirty = useMemo(() => {
    if (!original || !draft) return false;
    return JSON.stringify(draft) !== JSON.stringify(toDraft(original));
  }, [original, draft]);

  async function onSave() {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await updateQrLabelTemplate(id, draft);
      setOriginal(updated);
      setDraft(toDraft(updated));
      toast.success('Saved');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  function updateField<K extends keyof QrLabelFieldsPayload>(
    key: K,
    patch: Partial<QrLabelFieldsPayload[K]>,
  ) {
    setDraft((d) =>
      d
        ? {
            ...d,
            fields: {
              ...d.fields,
              [key]: { ...d.fields[key], ...patch },
            } as QrLabelFieldsPayload,
          }
        : d,
    );
  }

  if (error && !draft) {
    return (
      <PageShell crumbs={[{ label: 'QR codes', href: '/qr-codes' }, { label: 'Templates', href: '/qr-codes/templates' }, { label: 'Edit' }]}>
        <p className="p-6 text-signal-fault">{error}</p>
      </PageShell>
    );
  }
  if (!draft || !original) {
    return (
      <PageShell crumbs={[{ label: 'QR codes', href: '/qr-codes' }, { label: 'Templates', href: '/qr-codes/templates' }, { label: 'Edit' }]}>
        <p className="p-6 text-ink-tertiary">Loading…</p>
      </PageShell>
    );
  }

  // Preview data — fake-but-representative so the admin sees the slots in
  // realistic proportions. Using "Square-Turn" matches the existing
  // sticker design iteration; swap later with a real asset picker if the
  // admin wants to preview against a specific instance.
  const previewData = {
    qrUrl: `${PUBLIC_PWA_ORIGIN}/q/DEMO${draft.qrSize.toString().padStart(3, '0')}`,
    code: 'DEMO123ABCD',
    model: 'Square-Turn',
    serial: 'FLOW-TURN-0142',
    siteName: 'Secondary 25',
    locationLabel: 'PF-23',
  };

  const templateForPreview: QrLabelTemplate = {
    layout: draft.layout,
    accentColor: draft.accentColor,
    logoUrl: null, // logo upload flow can wire in later; null renders without
    qrSize: draft.qrSize,
    qrErrorCorrection: draft.qrErrorCorrection,
    fields: draft.fields,
  };

  return (
    <PageShell crumbs={[{ label: 'QR codes', href: '/qr-codes' }, { label: 'Templates', href: '/qr-codes/templates' }, { label: draft.name }]}>
      <PageHeader
        title={draft.name || 'Untitled template'}
        description="Changes preview live on the right. Save when you're happy — the print page picks this template up by ID."
        actions={
          <div className="flex items-center gap-2">
            <Link
              href="/qr-codes/templates"
              className="inline-flex items-center gap-1.5 rounded border border-line px-3 py-1.5 text-sm text-ink-secondary hover:bg-surface-inset"
            >
              <ChevronLeft size={14} strokeWidth={2} />
              All templates
            </Link>
            <button
              onClick={onSave}
              disabled={!dirty || saving}
              className="inline-flex items-center gap-1.5 rounded btn-primary px-3 py-1.5 disabled:opacity-50"
            >
              <Save size={14} strokeWidth={2} />
              {saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}
            </button>
          </div>
        }
      />

      {error && (
        <div className="mb-4 rounded-md border border-signal-fault/40 bg-signal-fault/10 p-3 text-sm text-signal-fault">
          {error}
        </div>
      )}

      <style jsx global>
        {QR_LABEL_CSS}
      </style>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_320px]">
        {/* Controls */}
        <div className="space-y-6">
          {/* Identity + scope */}
          <section className="space-y-3 rounded-md border border-line-subtle bg-surface-raised p-4">
            <h2 className="caption text-ink-tertiary">Identity</h2>
            <label className="block text-sm">
              <span className="text-ink-secondary">Name</span>
              <input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                maxLength={120}
                className="mt-1 w-full rounded border border-line bg-surface-raised px-2 py-1.5"
              />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={draft.isDefault}
                onChange={(e) => setDraft({ ...draft, isDefault: e.target.checked })}
              />
              <Star size={12} strokeWidth={2} className="text-brand" />
              <span>Use as default template for this organization</span>
            </label>
          </section>

          {/* Layout + styling */}
          <section className="space-y-3 rounded-md border border-line-subtle bg-surface-raised p-4">
            <h2 className="caption text-ink-tertiary">Layout &amp; style</h2>
            <div className="grid grid-cols-3 gap-2">
              {(['nameplate', 'minimal', 'safety'] as const).map((layout) => (
                <button
                  key={layout}
                  onClick={() => setDraft({ ...draft, layout })}
                  className={`rounded border px-3 py-2 text-sm capitalize transition ${
                    draft.layout === layout
                      ? 'border-brand bg-brand/10 text-ink-primary'
                      : 'border-line text-ink-secondary hover:bg-surface-inset'
                  }`}
                >
                  {layout}
                </button>
              ))}
            </div>
            <label className="flex items-center gap-3 text-sm">
              <span className="w-24 text-ink-secondary">Accent color</span>
              <input
                type="color"
                value={draft.accentColor}
                onChange={(e) => setDraft({ ...draft, accentColor: e.target.value })}
                className="h-8 w-14 cursor-pointer rounded border border-line"
              />
              <input
                value={draft.accentColor}
                onChange={(e) => setDraft({ ...draft, accentColor: e.target.value })}
                pattern="^#[0-9A-Fa-f]{6}$"
                className="w-24 rounded border border-line bg-surface-raised px-2 py-1.5 font-mono text-xs"
              />
              {draft.layout === 'safety' && (
                <span className="text-xs text-ink-tertiary">
                  (ignored — safety layout uses fixed yellow/black)
                </span>
              )}
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block text-sm">
                <span className="text-ink-secondary">QR size (pt)</span>
                <input
                  type="number"
                  min={40}
                  max={200}
                  value={draft.qrSize}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      qrSize: Math.max(40, Math.min(200, Number(e.target.value) || 92)),
                    })
                  }
                  className="mt-1 w-full rounded border border-line bg-surface-raised px-2 py-1.5"
                />
              </label>
              <label className="block text-sm">
                <span className="text-ink-secondary">Error correction</span>
                <select
                  value={draft.qrErrorCorrection}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      qrErrorCorrection: e.target.value as Draft['qrErrorCorrection'],
                    })
                  }
                  className="mt-1 w-full rounded border border-line bg-surface-raised px-2 py-1.5"
                >
                  <option value="L">L — ~7% (smallest)</option>
                  <option value="M">M — ~15% (default)</option>
                  <option value="Q">Q — ~25%</option>
                  <option value="H">H — ~30% (overlay-safe)</option>
                </select>
              </label>
            </div>
          </section>

          {/* Fields */}
          <section className="space-y-4 rounded-md border border-line-subtle bg-surface-raised p-4">
            <div>
              <h2 className="caption text-ink-tertiary">Fields</h2>
              <p className="mt-1 text-xs text-ink-tertiary">
                Toggle any field on or off. For auto-filled fields, override the
                label text to match your naming (e.g. "S/N" → "Machine ID").
              </p>
            </div>

            <FieldTextRow
              label="Header text"
              helper="Shown at the top of the sticker. Leave off for a cleaner look."
              enabled={draft.fields.header.enabled}
              onEnabled={(v) => updateField('header', { enabled: v })}
              value={draft.fields.header.text}
              onValue={(v) => updateField('header', { text: v })}
              placeholder="e.g. EQUIPMENT HUB"
              maxLength={60}
            />

            <FieldLabelRow
              label="Model (auto)"
              helper="Model display name from the asset."
              enabled={draft.fields.model.enabled}
              onEnabled={(v) => updateField('model', { enabled: v })}
              labelOverride={draft.fields.model.labelOverride}
              onLabel={(v) => updateField('model', { labelOverride: v })}
              defaultHint="(no label)"
            />

            <FieldLabelRow
              label="Serial number (auto)"
              helper="From asset instance."
              enabled={draft.fields.serial.enabled}
              onEnabled={(v) => updateField('serial', { enabled: v })}
              labelOverride={draft.fields.serial.labelOverride}
              onLabel={(v) => updateField('serial', { labelOverride: v })}
              defaultHint="S/N"
            />

            <FieldLabelRow
              label="Site name (auto)"
              helper="Where this instance lives."
              enabled={draft.fields.site.enabled}
              onEnabled={(v) => updateField('site', { enabled: v })}
              labelOverride={draft.fields.site.labelOverride}
              onLabel={(v) => updateField('site', { labelOverride: v })}
              defaultHint="Site"
            />

            <FieldLabelRow
              label="Location tag (auto)"
              helper="Per-sticker caption you set when generating the code."
              enabled={draft.fields.location.enabled}
              onEnabled={(v) => updateField('location', { enabled: v })}
              labelOverride={draft.fields.location.labelOverride}
              onLabel={(v) => updateField('location', { labelOverride: v })}
              defaultHint="Loc"
            />

            <FieldTextRow
              label="Description"
              helper="Free-form site note — lockout reminder, safety callout, etc."
              enabled={draft.fields.description.enabled}
              onEnabled={(v) => updateField('description', { enabled: v })}
              value={draft.fields.description.text}
              onValue={(v) => updateField('description', { text: v })}
              placeholder="e.g. Lockout before servicing"
              maxLength={200}
              multiline
            />

            <FieldLabelRow
              label="ID code (auto)"
              helper="The short, human-readable code shown at the bottom."
              enabled={draft.fields.idCode.enabled}
              onEnabled={(v) => updateField('idCode', { enabled: v })}
              labelOverride={draft.fields.idCode.labelOverride}
              onLabel={(v) => updateField('idCode', { labelOverride: v })}
              defaultHint="ID"
            />
          </section>
        </div>

        {/* Live preview */}
        <div className="lg:sticky lg:top-6 lg:self-start">
          <div className="rounded-md border border-line-subtle bg-surface-raised p-4">
            <h2 className="caption mb-3 text-ink-tertiary">Preview</h2>
            <div className="flex items-center justify-center rounded bg-[#e5e7eb] p-6">
              <div style={{ width: '2.5in', height: '2.5in' }}>
                <QrLabel template={templateForPreview} data={previewData} />
              </div>
            </div>
            <p className="mt-3 text-xs text-ink-tertiary">
              Rendered at actual print size (2.5"). Auto-filled values shown are
              placeholders.
            </p>
          </div>
        </div>
      </div>
    </PageShell>
  );
}

function toDraft(t: AdminQrLabelTemplate): Draft {
  return {
    name: t.name,
    isDefault: t.isDefault,
    layout: t.layout,
    accentColor: t.accentColor,
    logoStorageKey: t.logoStorageKey,
    qrSize: t.qrSize,
    qrErrorCorrection: t.qrErrorCorrection,
    fields: t.fields,
  };
}

// Row for fields whose value is auto-filled but whose label can be overridden.
function FieldLabelRow({
  label,
  helper,
  enabled,
  onEnabled,
  labelOverride,
  onLabel,
  defaultHint,
}: {
  label: string;
  helper: string;
  enabled: boolean;
  onEnabled: (v: boolean) => void;
  labelOverride: string | null;
  onLabel: (v: string | null) => void;
  defaultHint: string;
}) {
  return (
    <div className="flex flex-col gap-2 rounded border border-line-subtle bg-surface-inset/40 p-3">
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => onEnabled(e.target.checked)}
          className="mt-0.5"
        />
        <div className="flex-1">
          <span className="font-medium text-ink-primary">{label}</span>
          <p className="text-xs text-ink-tertiary">{helper}</p>
        </div>
      </label>
      {enabled && (
        <label className="ml-6 flex items-center gap-2 text-xs text-ink-secondary">
          <span className="w-24">Label override</span>
          <input
            value={labelOverride ?? ''}
            onChange={(e) => onLabel(e.target.value.length === 0 ? null : e.target.value)}
            placeholder={defaultHint}
            maxLength={60}
            className="flex-1 rounded border border-line bg-surface-raised px-2 py-1"
          />
        </label>
      )}
    </div>
  );
}

// Row for custom-text fields (header, description) — value is author-typed.
function FieldTextRow({
  label,
  helper,
  enabled,
  onEnabled,
  value,
  onValue,
  placeholder,
  maxLength,
  multiline = false,
}: {
  label: string;
  helper: string;
  enabled: boolean;
  onEnabled: (v: boolean) => void;
  value: string;
  onValue: (v: string) => void;
  placeholder: string;
  maxLength: number;
  multiline?: boolean;
}) {
  return (
    <div className="flex flex-col gap-2 rounded border border-line-subtle bg-surface-inset/40 p-3">
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => onEnabled(e.target.checked)}
          className="mt-0.5"
        />
        <div className="flex-1">
          <span className="font-medium text-ink-primary">{label}</span>
          <p className="text-xs text-ink-tertiary">{helper}</p>
        </div>
      </label>
      {enabled && (
        <div className="ml-6">
          {multiline ? (
            <textarea
              value={value}
              onChange={(e) => onValue(e.target.value)}
              placeholder={placeholder}
              maxLength={maxLength}
              rows={2}
              className="w-full resize-none rounded border border-line bg-surface-raised px-2 py-1 text-sm"
            />
          ) : (
            <input
              value={value}
              onChange={(e) => onValue(e.target.value)}
              placeholder={placeholder}
              maxLength={maxLength}
              className="w-full rounded border border-line bg-surface-raised px-2 py-1 text-sm"
            />
          )}
          <p className="mt-1 text-[10px] text-ink-tertiary">
            {value.length} / {maxLength}
          </p>
        </div>
      )}
    </div>
  );
}
