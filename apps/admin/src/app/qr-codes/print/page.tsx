'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { QRCodeSVG } from 'qrcode.react';
import { listQrCodes, PUBLIC_PWA_ORIGIN, type AdminQrCode } from '@/lib/api';

// Printable sticker sheet — 3×4 grid on US Letter at 0.5" margin. Each sticker
// is laid out like a factory equipment nameplate: QR on one side, asset
// identification block on the other, with the short code at the bottom as a
// fallback for operators reading it aloud.
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
  const [codes, setCodes] = useState<AdminQrCode[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listQrCodes()
      .then((all) => {
        const selected = all.filter((c) => ids.includes(c.id));
        setCodes(selected);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [ids.join(',')]);

  useEffect(() => {
    if (codes && codes.length > 0) {
      const t = setTimeout(() => window.print(), 400);
      return () => clearTimeout(t);
    }
  }, [codes]);

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
        }
        .sticker-sheet {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          grid-auto-rows: 2.5in;
          gap: 0.08in;
        }
        .sticker {
          position: relative;
          display: flex;
          gap: 0.12in;
          padding: 0.12in;
          border: 1px solid #1a1a1a;
          border-radius: 2px;
          background: white;
          color: #0f1114;
          break-inside: avoid;
          overflow: hidden;
          font-family: 'IBM Plex Sans', system-ui, sans-serif;
        }
        .sticker::before {
          content: '';
          position: absolute;
          left: 0;
          top: 0;
          bottom: 0;
          width: 4px;
          background: #0B5FBF;
        }
        .sticker-qr {
          flex-shrink: 0;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .sticker-body {
          flex: 1;
          min-width: 0;
          display: flex;
          flex-direction: column;
          gap: 0.04in;
          padding-left: 0.04in;
        }
        .sticker-caption {
          font-size: 7pt;
          font-weight: 600;
          letter-spacing: 0.1em;
          text-transform: uppercase;
          color: #6b6b6b;
        }
        .sticker-model {
          font-size: 11pt;
          font-weight: 600;
          line-height: 1.1;
          overflow: hidden;
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
        }
        .sticker-serial {
          font-family: 'IBM Plex Mono', ui-monospace, monospace;
          font-size: 9pt;
          font-weight: 600;
          color: #0f1114;
        }
        .sticker-meta {
          font-size: 8pt;
          color: #424242;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .sticker-code {
          margin-top: auto;
          padding-top: 0.04in;
          border-top: 1px solid #e0e0e0;
          font-family: 'IBM Plex Mono', ui-monospace, monospace;
          font-size: 7pt;
          color: #6b6b6b;
          letter-spacing: 0.05em;
        }
        .sticker-scan-hint {
          font-size: 6pt;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          color: #6b6b6b;
        }
      `}</style>

      <div className="no-print sticky top-0 z-10 flex items-center justify-between border-b border-line bg-surface-raised px-6 py-3 text-sm">
        <div className="flex items-center gap-3">
          <span className="caption">Print sheet</span>
          <span className="text-ink-secondary">
            {codes.length} sticker{codes.length === 1 ? '' : 's'} ·{' '}
            {Math.ceil(codes.length / 12)} page{codes.length > 12 ? 's' : ''}
          </span>
        </div>
        <button onClick={() => window.print()} className="btn-primary">
          Print again
        </button>
      </div>

      <div className="p-4">
        <div className="sticker-sheet">
          {codes.map((c) => {
            const url = `${PUBLIC_PWA_ORIGIN}/q/${c.code}`;
            return (
              <div key={c.id} className="sticker">
                <div className="sticker-qr">
                  <QRCodeSVG value={url} size={140} level="M" includeMargin={false} />
                </div>
                <div className="sticker-body">
                  <div className="sticker-scan-hint">Scan for docs · parts · AI</div>
                  <div className="sticker-caption">
                    {c.assetInstance?.modelCategory?.toUpperCase() ?? 'ASSET'}
                  </div>
                  <div className="sticker-model">
                    {c.assetInstance?.modelDisplayName ?? 'Unlinked'}
                  </div>
                  <div className="sticker-serial">
                    S/N {c.assetInstance?.serialNumber ?? '—'}
                  </div>
                  {c.assetInstance?.siteName && (
                    <div className="sticker-meta">{c.assetInstance.siteName}</div>
                  )}
                  {c.label && <div className="sticker-meta">{c.label}</div>}
                  <div className="sticker-code">ID · {c.code}</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
