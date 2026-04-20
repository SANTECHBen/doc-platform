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
          .sticker {
            /* Keep ink thin on the heavy elements — thermal/laser printers
               blow up dense blacks. Slightly reduce the rail weight at
               print time to stay crisp. */
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
        .sticker {
          position: relative;
          display: flex;
          flex-direction: column;
          padding: 0.11in 0.13in 0.09in 0.13in;
          background: white;
          color: #0f1114;
          break-inside: avoid;
          overflow: hidden;
          font-family: 'IBM Plex Sans', system-ui, sans-serif;
          /* Two-layer border: outer fine hairline, inner brand accent rule
             at top/bottom. Mimics a milled aluminum ID plate. */
          border: 0.8pt solid #0f1114;
          box-shadow: inset 0 0 0 3pt white, inset 0 0 0 3.6pt #0f1114;
          border-radius: 3pt;
        }
        /* Brand rail on the left — thicker and more confident than before. */
        .sticker::before {
          content: '';
          position: absolute;
          left: 0;
          top: 0;
          bottom: 0;
          width: 5pt;
          background: linear-gradient(180deg, #0B5FBF 0%, #0a4da0 100%);
        }
        /* Vertical main: ident block on top, QR pinned to bottom, footer
           below. Budget for a 2.5" sticker (180pt): 14pt padding + ident
           ~44pt + QR ~98pt (92pt + pad/border) + footer ~13pt fits with
           a small buffer. */
        .sticker-main {
          flex: 1;
          display: flex;
          flex-direction: column;
          gap: 4pt;
          padding-left: 4pt;
          padding-right: 2pt;
          min-height: 0;
          overflow: hidden;
        }
        .sticker-ident {
          display: flex;
          flex-direction: column;
          gap: 2pt;
          flex-shrink: 0;
        }
        .sticker-model {
          font-size: 11pt;
          font-weight: 600;
          line-height: 1.1;
          letter-spacing: -0.012em;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          color: #0f1114;
        }
        .sticker-serial {
          font-family: 'IBM Plex Mono', ui-monospace, monospace;
        }
        .sticker-serial-value {
          font-size: 10pt;
          font-weight: 600;
          color: #0B5FBF;
          letter-spacing: 0.02em;
        }
        .sticker-meta {
          font-family: 'IBM Plex Mono', ui-monospace, monospace;
          font-size: 7pt;
          line-height: 1.2;
          color: #424242;
          overflow: hidden;
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
        }
        .sticker-meta-label {
          font-size: 5.5pt;
          font-weight: 700;
          letter-spacing: 0.14em;
          text-transform: uppercase;
          color: #6b6b6b;
          margin-right: 3pt;
        }

        /* QR sits at the bottom of main. The QR visual pattern is universally
           recognized — no textual "scan" hint needed, saves vertical space. */
        .sticker-qr-col {
          display: flex;
          flex-direction: column;
          align-items: center;
          margin-top: auto;
          flex-shrink: 0;
        }
        .sticker-qr {
          position: relative;
          padding: 2.5pt;
          background: white;
          border: 0.5pt solid #0f1114;
          border-radius: 2pt;
        }

        /* Footer — unique code + URL. Thin top rule reads as "manufacturer
           plate bottom stamp". */
        .sticker-footer {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 6pt;
          padding-top: 3pt;
          padding-left: 4pt;
          margin-top: 4pt;
          border-top: 0.5pt solid #d4d4d4;
          font-family: 'IBM Plex Mono', ui-monospace, monospace;
          font-size: 5.5pt;
          color: #6b6b6b;
          letter-spacing: 0.06em;
          flex-shrink: 0;
        }
        .sticker-footer-code {
          font-weight: 600;
          color: #0f1114;
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
                <div className="sticker-main">
                  <div className="sticker-ident">
                    <div className="sticker-model">
                      {c.assetInstance?.modelDisplayName ?? 'Unlinked'}
                    </div>
                    <div className="sticker-serial">
                      <span className="sticker-serial-value">
                        {c.assetInstance?.serialNumber ?? '—'}
                      </span>
                    </div>
                    {(c.assetInstance?.siteName || c.label) && (
                      <div className="sticker-meta">
                        <span className="sticker-meta-label">
                          {c.assetInstance?.siteName ? 'Site' : 'Loc'}
                        </span>
                        {c.assetInstance?.siteName
                          ? c.label
                            ? `${c.assetInstance.siteName} · ${c.label}`
                            : c.assetInstance.siteName
                          : c.label}
                      </div>
                    )}
                  </div>

                  <div className="sticker-qr-col">
                    <div className="sticker-qr">
                      <QRCodeSVG value={url} size={92} level="M" includeMargin={false} />
                    </div>
                  </div>
                </div>

                <div className="sticker-footer">
                  <span>
                    ID · <span className="sticker-footer-code">{c.code}</span>
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
