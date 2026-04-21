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
// Template selection precedence:
//   1. Explicit ?templateId=<id> query param (from the picker)
//   2. Org's default template (isDefault=true)
//   3. Built-in nameplate fallback so the page still renders in orgs with
//      no saved templates.
export default function PrintSheetPage() {
  return (
    <Suspense fallback={<p className="p-6 text-ink-tertiary">Loading…</p>}>
      <PrintSheetInner />
    </Suspense>
  );
}

function PrintSheetInner() {
  const params = useSearchParams();
  const ids = params.getAll('id');
  const templateIdParam = params.get('templateId');

  const [codes, setCodes] = useState<AdminQrCode[] | null>(null);
  const [templates, setTemplates] = useState<AdminQrLabelTemplate[] | null>(null);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([listQrCodes(), listQrLabelTemplates()])
      .then(([allCodes, tpls]) => {
        const selected = allCodes.filter((c) => ids.includes(c.id));
        setCodes(selected);
        setTemplates(tpls);
        // Resolve initial template: query param wins, else org default, else
        // first available, else null (fallback design renders).
        const def =
          (templateIdParam && tpls.find((t) => t.id === templateIdParam)) ||
          tpls.find((t) => t.isDefault) ||
          tpls[0];
        setSelectedTemplateId(def?.id ?? null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    // ids.join makes the array comparable as a string for dep tracking.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids.join(','), templateIdParam]);

  useEffect(() => {
    if (codes && codes.length > 0) {
      const t = setTimeout(() => window.print(), 400);
      return () => clearTimeout(t);
    }
  }, [codes]);

  const template: QrLabelTemplate = useMemo(() => {
    const t = templates?.find((x) => x.id === selectedTemplateId);
    if (t) {
      return {
        layout: t.layout,
        accentColor: t.accentColor,
        logoUrl: null, // logo upload wiring is a separate piece of work
        qrSize: t.qrSize,
        qrErrorCorrection: t.qrErrorCorrection,
        fields: t.fields,
      };
    }
    // Built-in fallback: current nameplate look so orgs without templates
    // still get a useful sheet.
    return {
      layout: 'nameplate',
      accentColor: '#0B5FBF',
      logoUrl: null,
      qrSize: 92,
      qrErrorCorrection: 'M',
      fields: DEFAULT_LABEL_TEMPLATE_FIELDS,
    };
  }, [templates, selectedTemplateId]);

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
              value={selectedTemplateId ?? ''}
              onChange={(e) => setSelectedTemplateId(e.target.value || null)}
              className="rounded border border-line bg-surface-raised px-2 py-1"
            >
              <option value="">Built-in nameplate</option>
              {(templates ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                  {t.isDefault ? ' (default)' : ''}
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
                <QrLabel template={template} data={data} />
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
