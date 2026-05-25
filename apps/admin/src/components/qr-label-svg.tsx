'use client';

import { QRCodeSVG } from 'qrcode.react';

// SVG-native renderer for a single QR placard. Single source of truth for:
//   - the live preview in the template editor
//   - the printed sticker sheet
//   - the high-resolution download (SVG vector + PNG raster)
//
// Everything is drawn in points (1pt = 1/72in) inside a 180×180 viewBox so
// the placard scales to any size without quality loss. Print sheets simply
// render this SVG at 2.5" x 2.5" via CSS width/height; PNG export rasterizes
// the same SVG at the requested pixel resolution.
//
// Three layouts:
//   - "nameplate" — industrial equipment placard. Brand-accent header band,
//     two-column meta/QR body, footer rule with ID code.
//   - "minimal"   — premium quiet design. Centered hero QR with hairline
//     frame, tracked uppercase headline, restrained metadata below.
//   - "safety"    — ANSI Z535-inspired hazard look. Black banner with
//     alert glyph, yellow body, corner hazard chevrons, framed QR.
//
// The renderer is intentionally pure: no React hooks, no DOM measurement.
// Layout decisions are computed from inputs only so the output is
// deterministic and serializable.

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
  /**
   * Outer pixel/CSS size for the placard. Defaults to "2.5in" — actual print
   * size. The SVG itself uses a 180×180 viewBox regardless, so passing any
   * size just scales the same vector output.
   */
  size?: string | number;
  /** Optional className applied to the root SVG. */
  className?: string;
}

// Default caption labels when no override is set. Kept short — every slot
// has to live alongside others on a 2.5" face.
const DEFAULT_LABELS = {
  serial: 'S/N',
  site: 'SITE',
  location: 'LOC',
  idCode: 'ID',
};

// Brand-safe font stacks. The admin app loads IBM Plex Sans + Mono via
// next/font; system fallbacks keep the SVG readable even outside the app
// (e.g. if a user opens the downloaded file in another viewer).
const FONT_SANS = `'IBM Plex Sans', 'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif`;
const FONT_MONO = `'IBM Plex Mono', ui-monospace, 'SF Mono', 'Consolas', monospace`;

// Canvas constants (180 pt = 2.5 in at 72dpi).
const W = 180;
const H = 180;

export function QrLabelSvg({ template, data, size = '2.5in', className }: QrLabelProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${W} ${H}`}
      width={size}
      height={size}
      role="img"
      aria-label={`QR placard ${data.code}`}
      className={className}
      style={{ display: 'block' }}
    >
      <defs>
        {/* Soft inset shadow for the QR card on minimal/nameplate layouts.
            Subtle — only adds dimension; never compromises print contrast. */}
        <filter id="qr-soft-shadow" x="-5%" y="-5%" width="110%" height="110%">
          <feGaussianBlur in="SourceAlpha" stdDeviation="0.4" />
          <feOffset dx="0" dy="0.3" result="offsetblur" />
          <feComponentTransfer>
            <feFuncA type="linear" slope="0.18" />
          </feComponentTransfer>
          <feMerge>
            <feMergeNode />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      {template.layout === 'minimal' ? (
        <MinimalLayout template={template} data={data} />
      ) : template.layout === 'safety' ? (
        <SafetyLayout template={template} data={data} />
      ) : (
        <NameplateLayout template={template} data={data} />
      )}
    </svg>
  );
}

// -----------------------------------------------------------------------------
// QR cell — keeps the QR rendering uniform across layouts. The QRCodeSVG
// component produces its own <svg> with a viewBox sized to module count; we
// place it inside a transform group at the desired pixel size and add a
// quiet zone of at least 4 modules via the marginSize prop.
// -----------------------------------------------------------------------------
function QrCell({
  url,
  size,
  level,
  cx,
  cy,
}: {
  url: string;
  size: number;
  level: 'L' | 'M' | 'Q' | 'H';
  cx: number;
  cy: number;
}) {
  const x = cx - size / 2;
  const y = cy - size / 2;
  return (
    <g transform={`translate(${x}, ${y})`}>
      <QRCodeSVG
        value={url}
        size={size}
        level={level}
        marginSize={2}
        bgColor="#ffffff"
        fgColor="#0a0c0f"
      />
    </g>
  );
}

// -----------------------------------------------------------------------------
// NAMEPLATE — industrial equipment placard.
//
// Layout (180×180):
//   [0,0..180,16]   optional header band (accent fill, white tracked caption)
//   [0,16..3,180]   accent rail (left edge)
//   [4,20..96,170]  ident block (left ~52% of width)
//   [96,20..176,170]QR cell with hairline frame, centered in right column
//   [4,168..176,168] hairline rule above footer
//   [4,170..176,178] footer row: ID caption + code in accent
// -----------------------------------------------------------------------------
function NameplateLayout({ template, data }: { template: QrLabelTemplate; data: QrLabelData }) {
  const { fields, accentColor } = template;
  const showHeader = fields.header.enabled && fields.header.text.trim().length > 0;
  const showFooter = fields.idCode.enabled;
  const headerH = showHeader ? 16 : 0;
  const accentStripeY = showHeader ? headerH : 0;
  // QR sits centered in the right column. The right column starts at x=92.
  const qrColX = 92;
  const qrColW = W - qrColX - 6; // leave 6pt right margin
  const qrAreaTop = accentStripeY + 6;
  const qrAreaBottom = showFooter ? 162 : H - 6;
  const qrAreaCenterY = (qrAreaTop + qrAreaBottom) / 2;
  // Clamp QR size to the right column with breathing room.
  const maxQr = Math.min(qrColW - 8, qrAreaBottom - qrAreaTop - 4);
  const qrSize = Math.min(template.qrSize, maxQr);

  // Ident block bounds (left column)
  const identX = 10;
  const identTop = accentStripeY + 10;
  const identMaxW = qrColX - identX - 4;

  return (
    <g>
      {/* White background */}
      <rect x={0} y={0} width={W} height={H} fill="#ffffff" />

      {/* Outer hairline frame */}
      <rect
        x={0.4}
        y={0.4}
        width={W - 0.8}
        height={H - 0.8}
        fill="none"
        stroke="#0a0c0f"
        strokeWidth={0.8}
        rx={3}
        ry={3}
      />

      {/* Header band or top stripe */}
      {showHeader ? (
        <>
          <rect x={0.8} y={0.8} width={W - 1.6} height={headerH} fill={accentColor} />
          <text
            x={8}
            y={headerH * 0.7 + 1.5}
            fontFamily={FONT_SANS}
            fontSize={6.8}
            fontWeight={700}
            fill="#ffffff"
            letterSpacing="0.16em"
            textRendering="geometricPrecision"
          >
            {fields.header.text.toUpperCase()}
          </text>
          {/* Hairline divider beneath header */}
          <line
            x1={0.8}
            y1={headerH + 0.8}
            x2={W - 0.8}
            y2={headerH + 0.8}
            stroke="#0a0c0f"
            strokeWidth={0.4}
          />
        </>
      ) : (
        <rect x={0.8} y={0.8} width={W - 1.6} height={3} fill={accentColor} />
      )}

      {/* Left accent rail */}
      <rect
        x={0.8}
        y={accentStripeY + (showHeader ? 1 : 3)}
        width={3}
        height={H - accentStripeY - (showHeader ? 1.6 : 3.6) - (showFooter ? 0 : 0)}
        fill={accentColor}
        opacity={0.85}
      />

      {/* Corner registration ticks (industrial detail) */}
      <CornerTicks color="#0a0c0f" />

      {/* QR cell with subtle frame */}
      <rect
        x={qrColX + (qrColW - qrSize) / 2 - 3}
        y={qrAreaCenterY - qrSize / 2 - 3}
        width={qrSize + 6}
        height={qrSize + 6}
        fill="#ffffff"
        stroke="#0a0c0f"
        strokeWidth={0.5}
        rx={1.5}
      />
      <QrCell
        url={data.qrUrl}
        size={qrSize}
        level={template.qrErrorCorrection}
        cx={qrColX + qrColW / 2}
        cy={qrAreaCenterY}
      />

      {/* Ident block */}
      <NameplateIdent
        x={identX}
        y={identTop}
        maxW={identMaxW}
        accent={accentColor}
        fields={fields}
        data={data}
      />

      {/* Footer */}
      {showFooter && (
        <>
          <line
            x1={6}
            y1={168}
            x2={W - 6}
            y2={168}
            stroke="#0a0c0f"
            strokeWidth={0.4}
            strokeOpacity={0.45}
          />
          <text
            x={10}
            y={175}
            fontFamily={FONT_MONO}
            fontSize={5.4}
            fontWeight={500}
            fill="#6b7280"
            letterSpacing="0.16em"
            textRendering="geometricPrecision"
          >
            {(fields.idCode.labelOverride ?? DEFAULT_LABELS.idCode).toUpperCase()}
          </text>
          <text
            x={W - 10}
            y={175}
            fontFamily={FONT_MONO}
            fontSize={6.2}
            fontWeight={600}
            fill={accentColor}
            letterSpacing="0.10em"
            textAnchor="end"
            textRendering="geometricPrecision"
          >
            {data.code}
          </text>
        </>
      )}
    </g>
  );
}

function NameplateIdent({
  x,
  y,
  maxW,
  accent,
  fields,
  data,
}: {
  x: number;
  y: number;
  maxW: number;
  accent: string;
  fields: QrLabelFields;
  data: QrLabelData;
}) {
  let cursor = y + 2;
  const lines: React.ReactNode[] = [];

  if (fields.model.enabled && data.model) {
    cursor += 9;
    lines.push(
      <text
        key="model"
        x={x}
        y={cursor}
        fontFamily={FONT_SANS}
        fontSize={11}
        fontWeight={600}
        fill="#0a0c0f"
        letterSpacing="-0.012em"
        textRendering="geometricPrecision"
      >
        {clip(data.model, 18)}
      </text>,
    );
    cursor += 2;
  }

  // Thin accent underline beneath the model
  if (fields.model.enabled && data.model) {
    lines.push(
      <line
        key="model-rule"
        x1={x}
        y1={cursor + 1}
        x2={x + Math.min(maxW - 4, 36)}
        y2={cursor + 1}
        stroke={accent}
        strokeWidth={0.9}
      />,
    );
    cursor += 4;
  }

  if (fields.serial.enabled && data.serial) {
    cursor += 7;
    const labelText = (fields.serial.labelOverride ?? DEFAULT_LABELS.serial).toUpperCase();
    lines.push(
      <g key="serial">
        <text
          x={x}
          y={cursor}
          fontFamily={FONT_MONO}
          fontSize={5.2}
          fontWeight={600}
          fill="#6b7280"
          letterSpacing="0.18em"
        >
          {labelText}
        </text>
        <text
          x={x}
          y={cursor + 7}
          fontFamily={FONT_MONO}
          fontSize={8.4}
          fontWeight={600}
          fill="#0a0c0f"
          letterSpacing="0.02em"
        >
          {clip(data.serial, 16)}
        </text>
      </g>,
    );
    cursor += 10;
  }

  if (fields.site.enabled && data.siteName) {
    cursor += 7;
    const labelText = (fields.site.labelOverride ?? DEFAULT_LABELS.site).toUpperCase();
    lines.push(
      <g key="site">
        <text
          x={x}
          y={cursor}
          fontFamily={FONT_MONO}
          fontSize={5}
          fontWeight={600}
          fill="#6b7280"
          letterSpacing="0.18em"
        >
          {labelText}
        </text>
        <text
          x={x}
          y={cursor + 6}
          fontFamily={FONT_SANS}
          fontSize={7}
          fontWeight={500}
          fill="#1f2937"
        >
          {clip(data.siteName, 22)}
        </text>
      </g>,
    );
    cursor += 9;
  }

  if (fields.location.enabled && data.locationLabel) {
    cursor += 6;
    const labelText = (fields.location.labelOverride ?? DEFAULT_LABELS.location).toUpperCase();
    lines.push(
      <g key="loc">
        <text
          x={x}
          y={cursor}
          fontFamily={FONT_MONO}
          fontSize={5}
          fontWeight={600}
          fill="#6b7280"
          letterSpacing="0.18em"
        >
          {labelText}
        </text>
        <text
          x={x}
          y={cursor + 6}
          fontFamily={FONT_SANS}
          fontSize={7}
          fontWeight={500}
          fill="#1f2937"
        >
          {clip(data.locationLabel, 22)}
        </text>
      </g>,
    );
    cursor += 9;
  }

  if (fields.description.enabled && fields.description.text.trim()) {
    cursor += 6;
    // Wrap to two lines max.
    const wrapped = wrapToLines(fields.description.text, 28, 2);
    wrapped.forEach((line, i) => {
      lines.push(
        <text
          key={`desc-${i}`}
          x={x}
          y={cursor + i * 6}
          fontFamily={FONT_SANS}
          fontSize={5.4}
          fontStyle="italic"
          fontWeight={400}
          fill="#374151"
        >
          {line}
        </text>,
      );
    });
  }

  return <g>{lines}</g>;
}

// -----------------------------------------------------------------------------
// MINIMAL — premium quiet design.
//
// Layout (180×180):
//   - Centered hero QR ~120pt with hairline ring
//   - Optional tiny tracked uppercase headline above the QR
//   - Below QR: model bold, then mono code in micro-caps with letter-spacing
//   - No outer border; the whole face reads as a piece of fine print
// -----------------------------------------------------------------------------
function MinimalLayout({ template, data }: { template: QrLabelTemplate; data: QrLabelData }) {
  const { fields } = template;
  const showHeader = fields.header.enabled && fields.header.text.trim().length > 0;
  const showModel = fields.model.enabled && !!data.model;
  const showSerial = fields.serial.enabled && !!data.serial;
  const showCode = fields.idCode.enabled;

  // Compute QR vertical center so the composition stays balanced no matter
  // how many bits of metadata are present.
  const topPad = showHeader ? 18 : 14;
  const bottomItems = (showModel ? 1 : 0) + (showSerial ? 1 : 0) + (showCode ? 1 : 0);
  const bottomBlockH = bottomItems > 0 ? 6 + bottomItems * 9 : 0;
  const availableH = H - topPad - bottomBlockH - 12;
  const qrSize = Math.min(template.qrSize + 16, Math.max(60, availableH - 4));
  const qrCx = W / 2;
  const qrCy = topPad + qrSize / 2 + 4;

  return (
    <g>
      {/* White background */}
      <rect x={0} y={0} width={W} height={H} fill="#ffffff" />

      {/* Hairline outer frame */}
      <rect
        x={0.4}
        y={0.4}
        width={W - 0.8}
        height={H - 0.8}
        fill="none"
        stroke="#e5e7eb"
        strokeWidth={0.5}
        rx={4}
        ry={4}
      />

      {/* Top headline (optional) — flanked by hairline rules */}
      {showHeader && (
        <g>
          <line
            x1={14}
            y1={12}
            x2={(W - measureCaption(fields.header.text)) / 2 - 6}
            y2={12}
            stroke="#9ca3af"
            strokeWidth={0.3}
          />
          <line
            x1={(W + measureCaption(fields.header.text)) / 2 + 6}
            y1={12}
            x2={W - 14}
            y2={12}
            stroke="#9ca3af"
            strokeWidth={0.3}
          />
          <text
            x={W / 2}
            y={14}
            fontFamily={FONT_SANS}
            fontSize={6.4}
            fontWeight={600}
            fill="#374151"
            textAnchor="middle"
            letterSpacing="0.24em"
            textRendering="geometricPrecision"
          >
            {fields.header.text.toUpperCase()}
          </text>
        </g>
      )}

      {/* Hero QR — hairline ring */}
      <rect
        x={qrCx - qrSize / 2 - 4}
        y={qrCy - qrSize / 2 - 4}
        width={qrSize + 8}
        height={qrSize + 8}
        fill="#ffffff"
        stroke="#d1d5db"
        strokeWidth={0.4}
        rx={2}
      />
      <QrCell
        url={data.qrUrl}
        size={qrSize}
        level={template.qrErrorCorrection}
        cx={qrCx}
        cy={qrCy}
      />

      {/* Lower metadata block, centered */}
      <g>
        {(() => {
          let row = H - bottomBlockH - 4;
          const items: React.ReactNode[] = [];
          if (showModel) {
            row += 9;
            items.push(
              <text
                key="m"
                x={W / 2}
                y={row}
                fontFamily={FONT_SANS}
                fontSize={9.6}
                fontWeight={600}
                fill="#0a0c0f"
                textAnchor="middle"
                letterSpacing="-0.01em"
              >
                {clip(data.model!, 28)}
              </text>,
            );
          }
          if (showSerial) {
            row += 9;
            items.push(
              <text
                key="s"
                x={W / 2}
                y={row}
                fontFamily={FONT_MONO}
                fontSize={7}
                fontWeight={500}
                fill="#4b5563"
                textAnchor="middle"
                letterSpacing="0.06em"
              >
                {clip(data.serial!, 26)}
              </text>,
            );
          }
          if (showCode) {
            row += 8;
            items.push(
              <text
                key="c"
                x={W / 2}
                y={row}
                fontFamily={FONT_MONO}
                fontSize={5.4}
                fontWeight={500}
                fill="#9ca3af"
                textAnchor="middle"
                letterSpacing="0.22em"
              >
                {data.code}
              </text>,
            );
          }
          return items;
        })()}
      </g>
    </g>
  );
}

// -----------------------------------------------------------------------------
// SAFETY — ANSI Z535-inspired hazard placard.
//
// Layout (180×180):
//   [0,0..180,20]   black banner with alert glyph + uppercase headline
//   [0,20..180,180] yellow body (#FFD400)
//   Corner hazard chevrons in two opposite corners
//   Framed white QR cell in center
//   Ident block in black under QR
//   Footer code right-aligned in black mono
// -----------------------------------------------------------------------------
function SafetyLayout({ template, data }: { template: QrLabelTemplate; data: QrLabelData }) {
  const { fields } = template;
  const headerText =
    fields.header.enabled && fields.header.text.trim()
      ? fields.header.text.toUpperCase()
      : 'EQUIPMENT';
  const showFooter = fields.idCode.enabled;
  const bannerH = 20;
  const qrSize = Math.min(template.qrSize, 84);
  const qrCx = W / 2;
  const qrCy = bannerH + 8 + qrSize / 2;

  return (
    <g>
      {/* Yellow body */}
      <rect x={0} y={0} width={W} height={H} fill="#FFD400" />

      {/* Outer black frame */}
      <rect
        x={0.6}
        y={0.6}
        width={W - 1.2}
        height={H - 1.2}
        fill="none"
        stroke="#0a0c0f"
        strokeWidth={1.0}
        rx={2}
      />

      {/* Black header banner */}
      <rect x={0.6} y={0.6} width={W - 1.2} height={bannerH} fill="#0a0c0f" />

      {/* ANSI-style alert triangle */}
      <g transform="translate(10, 4.5)">
        <polygon
          points="0,11 5.5,0 11,11"
          fill="#FFD400"
          stroke="#FFD400"
          strokeWidth={0.5}
          strokeLinejoin="round"
        />
        <text
          x={5.5}
          y={9.2}
          fontFamily={FONT_SANS}
          fontSize={6.5}
          fontWeight={800}
          fill="#0a0c0f"
          textAnchor="middle"
        >
          !
        </text>
      </g>

      {/* Headline */}
      <text
        x={W / 2 + 6}
        y={bannerH * 0.65 + 1}
        fontFamily={FONT_SANS}
        fontSize={8.4}
        fontWeight={800}
        fill="#FFD400"
        textAnchor="middle"
        letterSpacing="0.22em"
        textRendering="geometricPrecision"
      >
        {clip(headerText, 18)}
      </text>

      {/* Corner hazard chevrons (top-right + bottom-left) */}
      <HazardChevron x={W - 18} y={bannerH + 4} />
      <HazardChevron x={4} y={H - 18} />

      {/* Diagonal hazard stripes accent band (subtle, low on the card) */}
      <DiagonalStripes
        x={6}
        y={H - 14}
        width={W - 12}
        height={6}
        stripeAngle={-45}
        stripeColor="#0a0c0f"
      />

      {/* White QR card with thick black frame */}
      <rect
        x={qrCx - qrSize / 2 - 5}
        y={qrCy - qrSize / 2 - 5}
        width={qrSize + 10}
        height={qrSize + 10}
        fill="#ffffff"
        stroke="#0a0c0f"
        strokeWidth={1.0}
        rx={1.5}
      />
      <QrCell
        url={data.qrUrl}
        size={qrSize}
        level={template.qrErrorCorrection}
        cx={qrCx}
        cy={qrCy}
      />

      {/* Ident block beneath QR */}
      <SafetyIdent y={qrCy + qrSize / 2 + 10} fields={fields} data={data} />

      {/* Footer */}
      {showFooter && (
        <text
          x={W - 10}
          y={H - 16}
          fontFamily={FONT_MONO}
          fontSize={6.6}
          fontWeight={700}
          fill="#0a0c0f"
          textAnchor="end"
          letterSpacing="0.10em"
        >
          {(fields.idCode.labelOverride ?? DEFAULT_LABELS.idCode).toUpperCase()} · {data.code}
        </text>
      )}
    </g>
  );
}

function SafetyIdent({
  y,
  fields,
  data,
}: {
  y: number;
  fields: QrLabelFields;
  data: QrLabelData;
}) {
  const items: React.ReactNode[] = [];
  let cursor = y;
  if (fields.model.enabled && data.model) {
    items.push(
      <text
        key="m"
        x={W / 2}
        y={cursor}
        fontFamily={FONT_SANS}
        fontSize={9.4}
        fontWeight={700}
        fill="#0a0c0f"
        textAnchor="middle"
        letterSpacing="-0.012em"
      >
        {clip(data.model, 22)}
      </text>,
    );
    cursor += 7;
  }
  if (fields.serial.enabled && data.serial) {
    items.push(
      <text
        key="s"
        x={W / 2}
        y={cursor}
        fontFamily={FONT_MONO}
        fontSize={6.6}
        fontWeight={600}
        fill="#0a0c0f"
        textAnchor="middle"
        letterSpacing="0.06em"
      >
        {clip(data.serial, 26)}
      </text>,
    );
    cursor += 6;
  }
  if (fields.site.enabled && data.siteName) {
    items.push(
      <text
        key="site"
        x={W / 2}
        y={cursor}
        fontFamily={FONT_SANS}
        fontSize={5.6}
        fontWeight={500}
        fill="#1f2937"
        textAnchor="middle"
      >
        {clip(data.siteName, 30)}
      </text>,
    );
  }
  return <g>{items}</g>;
}

// -----------------------------------------------------------------------------
// Decorative pieces
// -----------------------------------------------------------------------------

function CornerTicks({ color }: { color: string }) {
  // Small L-shaped ticks at each corner of the inner panel — registration mark
  // aesthetic borrowed from industrial nameplates.
  const T = 4;
  const M = 5; // inset from edge
  const lines: React.ReactNode[] = [];
  const corners: Array<[number, number, number, number]> = [
    [M, M, T, T], // top-left
    [W - M - T, M, T, T], // top-right
    [M, H - M - T, T, T], // bottom-left
    [W - M - T, H - M - T, T, T], // bottom-right
  ];
  corners.forEach(([x, y, w, h], i) => {
    // horizontal arm
    const horizX1 = i === 1 || i === 3 ? x + w : x;
    const horizX2 = i === 1 || i === 3 ? x : x + w;
    const horizY = i < 2 ? y : y + h;
    // vertical arm
    const vertX = i === 1 || i === 3 ? x + w : x;
    const vertY1 = i < 2 ? y : y + h;
    const vertY2 = i < 2 ? y + h : y;
    lines.push(
      <g key={i} opacity={0.55}>
        <line x1={horizX1} y1={horizY} x2={horizX2} y2={horizY} stroke={color} strokeWidth={0.4} />
        <line x1={vertX} y1={vertY1} x2={vertX} y2={vertY2} stroke={color} strokeWidth={0.4} />
      </g>,
    );
  });
  return <g>{lines}</g>;
}

function HazardChevron({ x, y }: { x: number; y: number }) {
  // 14×14 black triangle pointing outward — corner accent for safety layout.
  return (
    <g transform={`translate(${x}, ${y})`}>
      <polygon points="0,0 14,0 14,14" fill="#0a0c0f" />
    </g>
  );
}

function DiagonalStripes({
  x,
  y,
  width,
  height,
  stripeAngle,
  stripeColor,
}: {
  x: number;
  y: number;
  width: number;
  height: number;
  stripeAngle: number;
  stripeColor: string;
}) {
  // Draw a hazard-stripe band by clipping a series of diagonal rects.
  const patternId = `stripes-${stripeAngle}`;
  return (
    <g>
      <defs>
        <pattern
          id={patternId}
          patternUnits="userSpaceOnUse"
          width={6}
          height={6}
          patternTransform={`rotate(${stripeAngle})`}
        >
          <rect width={3} height={6} fill={stripeColor} />
          <rect x={3} width={3} height={6} fill="#FFD400" />
        </pattern>
      </defs>
      <rect x={x} y={y} width={width} height={height} fill={`url(#${patternId})`} />
    </g>
  );
}

// -----------------------------------------------------------------------------
// Text helpers
// -----------------------------------------------------------------------------

function clip(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

function wrapToLines(text: string, perLine: number, maxLines: number): string[] {
  const words = text.trim().split(/\s+/);
  const lines: string[] = [];
  let current = '';
  for (const w of words) {
    if (lines.length === maxLines) break;
    const next = current ? `${current} ${w}` : w;
    if (next.length <= perLine) {
      current = next;
    } else {
      if (current) lines.push(current);
      current = w;
      if (lines.length === maxLines) {
        current = '';
        break;
      }
    }
  }
  if (current && lines.length < maxLines) lines.push(current);
  // Truncate the last line if there's overflow we couldn't fit.
  if (lines.length === maxLines) {
    const joined = lines.join(' ');
    const original = text.trim();
    if (joined.length < original.length) {
      lines[lines.length - 1] = clip(lines[lines.length - 1]!, perLine);
    }
  }
  return lines;
}

function measureCaption(text: string): number {
  // Rough px estimate at 6.4pt tracked 0.24em — used only to size rule
  // segments around the centered caption text.
  return text.length * 4.8;
}
