'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  listQrCodes,
  listQrLabelTemplates,
  DEFAULT_LABEL_TEMPLATE_FIELDS,
  PUBLIC_PWA_ORIGIN,
  type AdminQrCode,
  type AdminQrLabelTemplate,
} from '@/lib/api';
import { QrLabel, QR_LABEL_CSS, type QrLabelTemplate } from '@/components/qr-label';

// Printable sticker sheet — 3×4 grid on US Letter at 0.5" margin. Each
// sticker renders via the shared <QrLabel> component using a chosen
// template, so the editor preview and the printed output stay in sync.
//
// Template selection precedence (per sticker):
//   1. URL ?templateId=<id>     — force-all override from the picker.
//   2. QR code's preferredTemplate — each sticker uses its own sticky choice.
//   3. Built-in nameplate fallback — when a code has no preference and no
//      override is set.
// The picker on this page has three modes: "Per-QR preference" (default),
// a named template (forces all), or "Built-in nameplate" (forces all).
export default function PrintSheetPage() {
  return (
    <Suspense fallback={<p className="p-6 text-ink-tertiary">Loading…</p>}>
      <PrintSheetInner />
    </Suspense>
  );
}

// Sentinel string for the "use each code's own template" choice. Empty
// string is already taken by the built-in fallback, so we use a distinct
// token that won't collide with any UUID.
const PER_QR = '__per_qr__';

function PrintSheetInner() {
  const params = useSearchParams();
  const ids = params.getAll('id');
  const templateIdParam = params.get('templateId');

  const [codes, setCodes] = useState<AdminQrCode[] | null>(null);
  const [templates, setTemplates] = useState<AdminQrLabelTemplate[] | null>(null);
  // Override mode: either PER_QR (use each code's own), '' (force built-in),
  // or a specific template UUID (force that template for all).
  const [overrideMode, setOverrideMode] = useState<string>(PER_QR);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([listQrCodes(), listQrLabelTemplates()])
      .then(([allCodes, tpls]) => {
        const selected = allCodes.filter((c) => ids.includes(c.id));
        setCodes(selected);
        setTemplates(tpls);
        // URL override wins if present; otherwise default to per-QR so the
        // sticky preference on each code takes effect out of the box.
        if (templateIdParam && tpls.find((t) => t.id === templateIdParam)) {
          setOverrideMode(templateIdParam);
        } else {
          setOverrideMode(PER_QR);
        }
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids.join(','), templateIdParam]);

  useEffect(() => {
    if (codes && codes.length > 0) {
      const t = setTimeout(() => window.print(), 400);
      return () => clearTimeout(t);
    }
  }, [codes]);

  // Resolve the effective template for a single code. In force modes the
  // override applies to every sticker; in PER_QR mode each code uses its
  // own preferredTemplate (or the built-in fallback if unset).
  const templateFor = useMemo(() => {
    return (c: AdminQrCode): QrLabelTemplate => {
      const tplId =
        overrideMode === PER_QR
          ? c.preferredTemplate?.id ?? null
          : overrideMode || null;
      const tpl = tplId ? templates?.find((x) => x.id === tplId) ?? null : null;
      if (tpl) {
        return {
          layout: tpl.layout,
          accentColor: tpl.accentColor,
          logoUrl: null,
          qrSize: tpl.qrSize,
          qrErrorCorrection: tpl.qrErrorCorrection,
          fields: tpl.fields,
        };
      }
      return {
        layout: 'nameplate',
        accentColor: '#0B5FBF',
        logoUrl: null,
        qrSize: 92,
        qrErrorCorrection: 'M',
        fields: DEFAULT_LABEL_TEMPLATE_FIELDS,
      };
    };
  }, [overrideMode, templates]);

  if (error) return <p className="p-6 text-signal-fault">{error}</p>;
  if (!codes) return <p className="p-6 text-ink-tertiary">Loading…</p>;
  if (codes.length === 0) return <p className="p-6 text-ink-tertiary">No codes selected.</p>;

  return (
    <>
      <style jsx global>{`
        @page {
          size: letter;
          margin: 0.5in;
        }
        @media print {
          body {
            background: white;
          }
          .no-print {
            display: none !important;
          }
          .qr-sticker {
            print-color-adjust: exact;
            -webkit-print-color-adjust: exact;
          }
        }
        .sticker-sheet {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          grid-auto-rows: 2.5in;
          gap: 0.08in;
        }
      `}</style>
      <style jsx global>
        {QR_LABEL_CSS}
      </style>

      <div className="no-print sticky top-0 z-10 flex items-center justify-between border-b border-line bg-surface-raised px-6 py-3 text-sm">
        <div className="flex items-center gap-3">
          <span className="caption">Print sheet</span>
          <span className="text-ink-secondary">
            {codes.length} sticker{codes.length === 1 ? '' : 's'} ·{' '}
            {Math.ceil(codes.length / 12)} page{codes.length > 12 ? 's' : ''}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-ink-secondary">
            <span>Template</span>
            <select
              value={overrideMode}
              onChange={(e) => setOverrideMode(e.target.value)}
              className="rounded border border-line bg-surface-raised px-2 py-1"
            >
              <option value={PER_QR}>Per-QR preference</option>
              <option value="">Built-in nameplate (force all)</option>
              {(templates ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                  {t.isDefault ? ' (default)' : ''} — force all
                </option>
              ))}
            </select>
          </label>
          <button onClick={() => window.print()} className="btn-primary">
            Print again
          </button>
        </div>
      </div>

      <div className="p-4">
        <div className="sticker-sheet">
          {codes.map((c) => {
            const data = {
              qrUrl: `${PUBLIC_PWA_ORIGIN}/q/${c.code}`,
              code: c.code,
              model: c.assetInstance?.modelDisplayName ?? 'Unlinked',
              serial: c.assetInstance?.serialNumber ?? null,
              siteName: c.assetInstance?.siteName ?? null,
              locationLabel: c.label ?? null,
            };
            return (
              <div key={c.id}>
                <QrLabel template={templateFor(c)} data={data} />
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
