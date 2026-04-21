'use client';

import { QRCodeSVG } from 'qrcode.react';

// Shared renderer for a single printed QR sticker. Drives both the live
// preview in the template editor and the printed sheet on /qr-codes/print.
// Keeping one implementation means a change to the sticker design is a
// one-file edit — editor preview, print output, and exported PDFs stay
// in sync automatically.
//
// The component is styled at print-ready sizes (points, 2.5" sticker).
// CSS-in-JS isn't used here — styles live inline so the print-page global
// styles can still override container-level concerns (grid, page size).

export type LabelLayout = 'nameplate' | 'minimal' | 'safety';

export interface QrLabelFields {
  header: { enabled: boolean; text: string };
  model: { enabled: boolean; labelOverride: string | null };
  serial: { enabled: boolean; labelOverride: string | null };
  site: { enabled: boolean; labelOverride: string | null };
  location: { enabled: boolean; labelOverride: string | null };
  description: { enabled: boolean; text: string };
  idCode: { enabled: boolean; labelOverride: string | null };
}

export interface QrLabelTemplate {
  layout: LabelLayout;
  accentColor: string;
  logoUrl: string | null;
  qrSize: number;
  qrErrorCorrection: 'L' | 'M' | 'Q' | 'H';
  fields: QrLabelFields;
}

export interface QrLabelData {
  qrUrl: string;
  code: string;
  model: string | null;
  serial: string | null;
  siteName: string | null;
  locationLabel: string | null;
}

export interface QrLabelProps {
  template: QrLabelTemplate;
  data: QrLabelData;
}

// Default label texts when no override is set. Kept short — every slot
// needs to fit on a 2.5" sticker alongside other slots.
const DEFAULT_LABELS = {
  model: '',
  serial: 'S/N',
  site: 'Site',
  location: 'Loc',
  idCode: 'ID',
};

export function QrLabel({ template, data }: QrLabelProps) {
  if (template.layout === 'minimal') return <MinimalLayout template={template} data={data} />;
  if (template.layout === 'safety') return <SafetyLayout template={template} data={data} />;
  return <NameplateLayout template={template} data={data} />;
}

// ---- Nameplate -------------------------------------------------------------
// The original industrial look — brand rail on the left, compact ident
// block above a centered QR, thin footer rule with the short ID code.

function NameplateLayout({ template, data }: { template: QrLabelTemplate; data: QrLabelData }) {
  const { fields, accentColor } = template;
  return (
    <div className="qr-sticker qr-nameplate" style={{ '--accent': accentColor } as React.CSSProperties}>
      {fields.header.enabled && fields.header.text && (
        <div className="qr-sticker-header">
          {template.logoUrl ? (
            <img src={template.logoUrl} alt="" className="qr-sticker-logo" />
          ) : null}
          <span className="qr-sticker-header-text">{fields.header.text}</span>
        </div>
      )}
      <div className="qr-sticker-main">
        <div className="qr-sticker-ident">
          {fields.model.enabled && data.model && (
            <div className="qr-sticker-model">{data.model}</div>
          )}
          {fields.serial.enabled && data.serial && (
            <div className="qr-sticker-row qr-sticker-serial">
              {fields.serial.labelOverride !== '' && (
                <span className="qr-sticker-label">
                  {fields.serial.labelOverride ?? DEFAULT_LABELS.serial}
                </span>
              )}
              <span className="qr-sticker-value">{data.serial}</span>
            </div>
          )}
          {(fields.site.enabled || fields.location.enabled) &&
            (data.siteName || data.locationLabel) && (
              <div className="qr-sticker-row qr-sticker-meta">
                {fields.site.enabled && data.siteName && (
                  <>
                    <span className="qr-sticker-label">
                      {fields.site.labelOverride ?? DEFAULT_LABELS.site}
                    </span>
                    {data.siteName}
                  </>
                )}
                {fields.site.enabled && fields.location.enabled && data.siteName && data.locationLabel && ' · '}
                {fields.location.enabled && data.locationLabel && (
                  <>
                    {!fields.site.enabled && (
                      <span className="qr-sticker-label">
                        {fields.location.labelOverride ?? DEFAULT_LABELS.location}
                      </span>
                    )}
                    {data.locationLabel}
                  </>
                )}
              </div>
            )}
          {fields.description.enabled && fields.description.text && (
            <div className="qr-sticker-description">{fields.description.text}</div>
          )}
        </div>
        <div className="qr-sticker-qr-col">
          <div className="qr-sticker-qr">
            <QRCodeSVG
              value={data.qrUrl}
              size={template.qrSize}
              level={template.qrErrorCorrection}
              includeMargin={false}
            />
          </div>
        </div>
      </div>
      {fields.idCode.enabled && (
        <div className="qr-sticker-footer">
          <span>
            {fields.idCode.labelOverride ?? DEFAULT_LABELS.idCode} ·{' '}
            <span className="qr-sticker-footer-code">{data.code}</span>
          </span>
        </div>
      )}
    </div>
  );
}

// ---- Minimal ---------------------------------------------------------------
// QR-dominant. Small centered ident under the code. No border rail, no
// footer — good for premium/quiet aesthetic.

function MinimalLayout({ template, data }: { template: QrLabelTemplate; data: QrLabelData }) {
  const { fields } = template;
  return (
    <div className="qr-sticker qr-minimal">
      {fields.header.enabled && fields.header.text && (
        <div className="qr-sticker-header qr-sticker-header-center">
          <span className="qr-sticker-header-text">{fields.header.text}</span>
        </div>
      )}
      <div className="qr-sticker-qr qr-sticker-qr-center">
        <QRCodeSVG
          value={data.qrUrl}
          size={template.qrSize}
          level={template.qrErrorCorrection}
          includeMargin={false}
        />
      </div>
      <div className="qr-sticker-ident qr-sticker-ident-center">
        {fields.model.enabled && data.model && (
          <div className="qr-sticker-model">{data.model}</div>
        )}
        {fields.serial.enabled && data.serial && (
          <div className="qr-sticker-serial-minimal">{data.serial}</div>
        )}
        {fields.idCode.enabled && (
          <div className="qr-sticker-minimal-code">{data.code}</div>
        )}
      </div>
    </div>
  );
}

// ---- Safety ----------------------------------------------------------------
// Yellow/black hazard-class look. The accent color is ignored here — safety
// always reads yellow in a factory setting; swapping it fights the visual
// convention.

function SafetyLayout({ template, data }: { template: QrLabelTemplate; data: QrLabelData }) {
  const { fields } = template;
  return (
    <div className="qr-sticker qr-safety">
      <div className="qr-sticker-safety-header">
        {fields.header.enabled && fields.header.text
          ? fields.header.text.toUpperCase()
          : 'EQUIPMENT'}
      </div>
      <div className="qr-sticker-main">
        <div className="qr-sticker-ident">
          {fields.model.enabled && data.model && (
            <div className="qr-sticker-model">{data.model}</div>
          )}
          {fields.serial.enabled && data.serial && (
            <div className="qr-sticker-row qr-sticker-serial">
              {fields.serial.labelOverride !== '' && (
                <span className="qr-sticker-label">
                  {fields.serial.labelOverride ?? DEFAULT_LABELS.serial}
                </span>
              )}
              <span className="qr-sticker-value">{data.serial}</span>
            </div>
          )}
          {fields.site.enabled && data.siteName && (
            <div className="qr-sticker-row qr-sticker-meta">
              <span className="qr-sticker-label">
                {fields.site.labelOverride ?? DEFAULT_LABELS.site}
              </span>
              {data.siteName}
            </div>
          )}
          {fields.description.enabled && fields.description.text && (
            <div className="qr-sticker-description">{fields.description.text}</div>
          )}
        </div>
        <div className="qr-sticker-qr-col">
          <div className="qr-sticker-qr">
            <QRCodeSVG
              value={data.qrUrl}
              size={template.qrSize}
              level={template.qrErrorCorrection}
              includeMargin={false}
            />
          </div>
        </div>
      </div>
      {fields.idCode.enabled && (
        <div className="qr-sticker-footer">
          <span>
            {fields.idCode.labelOverride ?? DEFAULT_LABELS.idCode} ·{' '}
            <span className="qr-sticker-footer-code">{data.code}</span>
          </span>
        </div>
      )}
    </div>
  );
}

// Exported CSS string — consumers inject it once via `<style>` at the root
// of the print or preview area. Centralized so all three layouts share
// typography + spacing conventions and the 2.5" size budget.
export const QR_LABEL_CSS = `
.qr-sticker {
  position: relative;
  display: flex;
  flex-direction: column;
  padding: 0.11in 0.13in 0.09in 0.13in;
  background: white;
  color: #0f1114;
  break-inside: avoid;
  overflow: hidden;
  font-family: 'IBM Plex Sans', system-ui, sans-serif;
  border-radius: 3pt;
}

/* --- Nameplate ------------------------------------------------------------ */
.qr-nameplate {
  border: 0.8pt solid #0f1114;
  box-shadow: inset 0 0 0 3pt white, inset 0 0 0 3.6pt #0f1114;
}
.qr-nameplate::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 5pt;
  background: var(--accent, #0B5FBF);
}

/* --- Minimal -------------------------------------------------------------- */
.qr-minimal {
  border: 0.5pt solid #d4d4d4;
}

/* --- Safety --------------------------------------------------------------- */
.qr-safety {
  border: 0.8pt solid #0f1114;
  background: #FFD400;
}
.qr-sticker-safety-header {
  background: #0f1114;
  color: #FFD400;
  font-size: 7.5pt;
  font-weight: 700;
  letter-spacing: 0.18em;
  text-align: center;
  padding: 2pt 4pt 2.5pt 4pt;
  margin: -0.04in -0.05in 4pt -0.05in;
}
.qr-safety .qr-sticker-qr {
  border: 0.5pt solid #0f1114;
  background: white;
}
.qr-safety .qr-sticker-footer {
  border-top: 0.5pt solid #0f1114;
  color: #0f1114;
}

/* --- Shared interior ------------------------------------------------------ */
.qr-sticker-header {
  display: flex;
  align-items: center;
  gap: 5pt;
  padding-left: 4pt;
  padding-bottom: 3pt;
  border-bottom: 0.5pt solid #d4d4d4;
  margin-bottom: 4pt;
  flex-shrink: 0;
}
.qr-sticker-header-center {
  justify-content: center;
  padding-left: 0;
}
.qr-sticker-logo {
  height: 12pt;
  width: auto;
  object-fit: contain;
}
.qr-sticker-header-text {
  font-size: 6.5pt;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: #0f1114;
}

.qr-sticker-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4pt;
  padding-left: 4pt;
  padding-right: 2pt;
  min-height: 0;
  overflow: hidden;
}
.qr-sticker-ident {
  display: flex;
  flex-direction: column;
  gap: 2pt;
  flex-shrink: 0;
}
.qr-sticker-ident-center {
  align-items: center;
  text-align: center;
}
.qr-sticker-model {
  font-size: 11pt;
  font-weight: 600;
  line-height: 1.1;
  letter-spacing: -0.012em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #0f1114;
}
.qr-sticker-row {
  display: flex;
  align-items: baseline;
  gap: 4pt;
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
}
.qr-sticker-label {
  font-size: 5.5pt;
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: #6b6b6b;
}
.qr-sticker-value {
  font-size: 10pt;
  font-weight: 600;
  color: var(--accent, #0B5FBF);
  letter-spacing: 0.02em;
}
.qr-sticker-meta {
  font-size: 7pt;
  color: #424242;
  line-height: 1.2;
}
.qr-sticker-description {
  font-size: 6.5pt;
  line-height: 1.25;
  color: #2f2f2f;
  margin-top: 2pt;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.qr-sticker-qr-col {
  display: flex;
  flex-direction: column;
  align-items: center;
  margin-top: auto;
  flex-shrink: 0;
}
/* When the ID-code footer is toggled off, the QR otherwise sits flush with
   the sticker's bottom padding and visually kisses the border. Add a small
   extra gap in that case. */
.qr-sticker:not(:has(.qr-sticker-footer)) .qr-sticker-qr-col {
  padding-bottom: 5pt;
}
.qr-sticker-qr {
  padding: 2.5pt;
  background: white;
  border: 0.5pt solid #0f1114;
  border-radius: 2pt;
}
.qr-sticker-qr-center {
  margin: 4pt auto 6pt auto;
}

.qr-sticker-serial-minimal {
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  font-size: 9pt;
  font-weight: 600;
  color: #0f1114;
}
.qr-sticker-minimal-code {
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  font-size: 5.5pt;
  color: #6b6b6b;
  letter-spacing: 0.06em;
  margin-top: 2pt;
}

.qr-sticker-footer {
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
.qr-sticker-footer-code {
  font-weight: 600;
  color: #0f1114;
}
`;
