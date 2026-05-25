'use client';

// View/export modal for a single QR code. Opens from the QR codes list and
// the print page. Shows the placard at actual print size next to a bare QR,
// and gives the admin file downloads in either format and at print-grade
// resolutions. The same SVG used here is the one shipped to disk — there is
// no second render path.

import { useEffect, useMemo, useState } from 'react';
import {
  Check,
  Copy,
  Download,
  ExternalLink,
  Loader2,
  Printer,
  QrCode as QrCodeIcon,
  X,
} from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { QrLabel, type QrLabelTemplate } from '@/components/qr-label';
import { useToast } from '@/components/toast';
import {
  downloadBareQr,
  downloadPlacard,
  FORMAT_LABEL,
  safeFilename,
  type ExportFormat,
} from '@/lib/qr-export';
import {
  DEFAULT_LABEL_TEMPLATE_FIELDS,
  PUBLIC_PWA_ORIGIN,
  type AdminQrCode,
  type AdminQrLabelTemplate,
} from '@/lib/api';

export interface ViewQrModalProps {
  code: AdminQrCode;
  templates: AdminQrLabelTemplate[];
  /** Optional starting template id. Falls back to the code's preferred
   *  template, then the org default, then the built-in nameplate. */
  initialTemplateId?: string | null;
  onClose: () => void;
}

export function ViewQrModal({ code, templates, initialTemplateId, onClose }: ViewQrModalProps) {
  const toast = useToast();
  const url = `${PUBLIC_PWA_ORIGIN}/q/${code.code}`;

  // Choose the starting template: explicit prop → code's preference → org
  // default → first template → built-in fallback (null).
  const startingTemplate = useMemo(() => {
    if (initialTemplateId) {
      const t = templates.find((x) => x.id === initialTemplateId);
      if (t) return t.id;
    }
    if (code.preferredTemplate) {
      const t = templates.find((x) => x.id === code.preferredTemplate!.id);
      if (t) return t.id;
    }
    const def = templates.find((t) => t.isDefault);
    if (def) return def.id;
    return templates[0]?.id ?? '';
  }, [code, templates, initialTemplateId]);

  const [selectedTemplateId, setSelectedTemplateId] = useState<string>(startingTemplate);
  const [busyFormat, setBusyFormat] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Close on Escape — matches the rest of the admin dialog conventions.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const template: QrLabelTemplate = useMemo(() => {
    const tpl = templates.find((t) => t.id === selectedTemplateId) ?? null;
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
  }, [templates, selectedTemplateId]);

  const labelData = {
    qrUrl: url,
    code: code.code,
    model: code.assetInstance?.modelDisplayName ?? 'Unlinked',
    serial: code.assetInstance?.serialNumber ?? null,
    siteName: code.assetInstance?.siteName ?? null,
    locationLabel: code.label ?? null,
  };

  // Stable filename root: prefer asset model + serial when available, fall
  // back to the short code. Suffix tells the user which artifact at a glance.
  const filenameRoot = useMemo(() => {
    const parts: string[] = [];
    if (code.assetInstance?.modelDisplayName) parts.push(code.assetInstance.modelDisplayName);
    if (code.assetInstance?.serialNumber) parts.push(code.assetInstance.serialNumber);
    parts.push(code.code);
    return safeFilename(parts.join('-'));
  }, [code]);

  async function copyUrl() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API unavailable in some contexts; user can fall back to
      // selecting the link visually.
    }
  }

  async function exportPlacard(format: ExportFormat) {
    const key = `placard-${format}`;
    setBusyFormat(key);
    try {
      await downloadPlacard({
        template,
        data: labelData,
        format,
        filenameBase: `placard-${filenameRoot}`,
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyFormat(null);
    }
  }

  async function exportBareQr(format: ExportFormat) {
    const key = `bare-${format}`;
    setBusyFormat(key);
    try {
      await downloadBareQr({
        url,
        errorCorrection: template.qrErrorCorrection,
        format,
        filenameBase: `qr-${filenameRoot}`,
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyFormat(null);
    }
  }

  function printSingle() {
    const params = new URLSearchParams();
    params.append('id', code.id);
    if (selectedTemplateId) params.set('templateId', selectedTemplateId);
    window.open(`/qr-codes/print?${params.toString()}`, '_blank');
  }

  const allFormats: ExportFormat[] = ['svg', 'png-screen', 'png-print', 'png-ultra'];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-primary/40 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-line bg-surface-raised shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <header className="flex items-start justify-between gap-4 border-b border-line-subtle bg-surface-inset/40 px-6 py-4">
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <QrCodeIcon size={16} strokeWidth={2} className="text-brand" />
              <span className="font-mono text-sm font-semibold text-ink-primary">
                {code.code}
              </span>
              {!code.active && (
                <span className="rounded-full bg-signal-fault/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-signal-fault">
                  Inactive
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 text-xs text-ink-tertiary">
              <a
                href={url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 font-mono text-brand hover:underline"
                title="Open scan URL"
              >
                <ExternalLink size={10} strokeWidth={2} />
                {url}
              </a>
              <button
                type="button"
                onClick={copyUrl}
                className="inline-flex h-5 w-5 items-center justify-center rounded text-ink-tertiary transition hover:bg-surface-inset hover:text-ink-primary"
                aria-label="Copy URL"
                title={copied ? 'Copied' : 'Copy URL'}
              >
                {copied ? <Check size={11} strokeWidth={2.5} /> : <Copy size={11} strokeWidth={2} />}
              </button>
            </div>
            {code.assetInstance && (
              <div className="text-xs text-ink-secondary">
                <span className="font-medium text-ink-primary">{code.assetInstance.modelDisplayName}</span>
                {' · '}
                <span className="font-mono">{code.assetInstance.serialNumber}</span>
                {' · '}
                {code.assetInstance.siteName}
                {code.label && (
                  <>
                    {' · '}
                    <span className="text-ink-tertiary">{code.label}</span>
                  </>
                )}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-ink-tertiary transition hover:bg-surface-inset hover:text-ink-primary"
          >
            <X size={16} strokeWidth={2} />
          </button>
        </header>

        {/* Body: two preview columns with download actions beneath each. */}
        <div className="grid flex-1 grid-cols-1 gap-6 overflow-y-auto bg-surface-inset/30 p-6 lg:grid-cols-2">
          {/* Placard column */}
          <section className="flex flex-col gap-3">
            <div className="flex items-baseline justify-between">
              <h3 className="text-sm font-semibold text-ink-primary">Placard</h3>
              {templates.length > 0 && (
                <label className="flex items-center gap-2 text-xs text-ink-secondary">
                  <span>Template</span>
                  <select
                    value={selectedTemplateId}
                    onChange={(e) => setSelectedTemplateId(e.target.value)}
                    className="rounded border border-line bg-surface-raised px-2 py-1 text-xs"
                  >
                    {templates.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                        {t.isDefault ? ' (default)' : ''}
                      </option>
                    ))}
                    <option value="">Built-in nameplate</option>
                  </select>
                </label>
              )}
            </div>

            <div className="flex items-center justify-center rounded-lg border border-line-subtle bg-[linear-gradient(135deg,#f6f6f7_0%,#eef0f3_100%)] p-8 shadow-inner">
              <div className="rounded-sm bg-white shadow-[0_8px_30px_-12px_rgba(15,17,20,0.25)] ring-1 ring-line-subtle">
                <QrLabel template={template} data={labelData} size="320px" />
              </div>
            </div>
            <p className="text-[11px] leading-relaxed text-ink-tertiary">
              Vector preview — renders identically at any size. SVG is
              recommended for sign-shop print, vinyl cutters, or sticker
              services. PNG is provided for documents, presentations, and
              quick screen shares.
            </p>

            <div className="space-y-2">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-tertiary">
                Download placard
              </div>
              <div className="grid grid-cols-2 gap-2">
                {allFormats.map((fmt) => {
                  const key = `placard-${fmt}`;
                  return (
                    <button
                      key={fmt}
                      type="button"
                      onClick={() => exportPlacard(fmt)}
                      disabled={busyFormat !== null}
                      className="group flex items-center justify-between gap-2 rounded-md border border-line bg-surface-raised px-3 py-2 text-left text-xs text-ink-primary transition hover:border-brand/40 hover:bg-brand/5 disabled:cursor-wait disabled:opacity-50"
                    >
                      <span>{FORMAT_LABEL[fmt]}</span>
                      {busyFormat === key ? (
                        <Loader2 size={12} strokeWidth={2} className="animate-spin text-brand" />
                      ) : (
                        <Download size={12} strokeWidth={2} className="text-ink-tertiary group-hover:text-brand" />
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          </section>

          {/* Bare QR column */}
          <section className="flex flex-col gap-3">
            <h3 className="text-sm font-semibold text-ink-primary">Bare QR code</h3>

            <div className="flex items-center justify-center rounded-lg border border-line-subtle bg-[linear-gradient(135deg,#f6f6f7_0%,#eef0f3_100%)] p-8 shadow-inner">
              <div className="rounded-sm bg-white p-4 shadow-[0_8px_30px_-12px_rgba(15,17,20,0.25)] ring-1 ring-line-subtle">
                <QRCodeSVG
                  value={url}
                  size={256}
                  level={template.qrErrorCorrection}
                  marginSize={4}
                  bgColor="#ffffff"
                  fgColor="#0a0c0f"
                />
              </div>
            </div>
            <p className="text-[11px] leading-relaxed text-ink-tertiary">
              The QR symbol alone — no header, no caption, no border. Includes
              the 4-module quiet zone required for reliable scanning. Use this
              when you're embedding the code into your own design.
            </p>

            <div className="space-y-2">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-tertiary">
                Download QR
              </div>
              <div className="grid grid-cols-2 gap-2">
                {allFormats.map((fmt) => {
                  const key = `bare-${fmt}`;
                  return (
                    <button
                      key={fmt}
                      type="button"
                      onClick={() => exportBareQr(fmt)}
                      disabled={busyFormat !== null}
                      className="group flex items-center justify-between gap-2 rounded-md border border-line bg-surface-raised px-3 py-2 text-left text-xs text-ink-primary transition hover:border-brand/40 hover:bg-brand/5 disabled:cursor-wait disabled:opacity-50"
                    >
                      <span>{FORMAT_LABEL[fmt]}</span>
                      {busyFormat === key ? (
                        <Loader2 size={12} strokeWidth={2} className="animate-spin text-brand" />
                      ) : (
                        <Download size={12} strokeWidth={2} className="text-ink-tertiary group-hover:text-brand" />
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          </section>
        </div>

        {/* Footer actions */}
        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-line-subtle bg-surface-inset/40 px-6 py-3">
          <p className="text-[11px] text-ink-tertiary">
            QR error correction:{' '}
            <span className="font-mono text-ink-secondary">{template.qrErrorCorrection}</span>
            {' · '}
            Symbol margin: <span className="font-mono text-ink-secondary">4 modules</span>
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={printSingle}
              className="inline-flex items-center gap-1.5 rounded border border-line px-3 py-1.5 text-sm text-ink-secondary transition hover:bg-surface"
            >
              <Printer size={13} strokeWidth={2} />
              Print this sticker
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded btn-primary px-3 py-1.5 text-sm"
            >
              Done
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
