'use client';

// Composes the styled QR with an optional surrounding "frame" — the Bitly /
// Canva-style callout cards and ribbons that wrap a bare QR with branded
// chrome. The frame is rendered as an SVG/CSS layer around the imperative
// QR canvas; the composite can be exported by drawing both into a single
// canvas at high resolution.
//
// Three kinds:
//   - none     → bare QR, no chrome
//   - callout  → solid card with QR inset, ribbon below with tagline
//   - ribbon   → no card, ribbon strip below the QR (transparent surround)

import type { FrameSpec, QrStyleSpec } from '@/lib/qr-style';

export interface FrameGeometry {
  /** Outer canvas size in CSS pixels — the export canvas size. */
  outer: number;
  /** Inner QR size in CSS pixels — what we tell the QR engine. */
  qrPixel: number;
  /** Top-left coordinate of the QR within the outer canvas. */
  qrX: number;
  qrY: number;
  /** Ribbon rectangle if the frame includes one. */
  ribbon: { x: number; y: number; width: number; height: number } | null;
  /** Outer card rectangle, if rendered. */
  card: { x: number; y: number; width: number; height: number; r: number } | null;
}

/**
 * Compute pixel-level layout for the chosen frame. The math is dialed in to
 * keep the QR's aspect square and to give the ribbon enough room for the
 * tagline at the rendered size.
 */
export function computeFrameGeometry(spec: QrStyleSpec, requestedOuter: number): FrameGeometry {
  const outer = requestedOuter;
  if (spec.frame.kind === 'none') {
    return { outer, qrPixel: outer, qrX: 0, qrY: 0, ribbon: null, card: null };
  }
  if (spec.frame.kind === 'ribbon') {
    const ribbonH = Math.round(outer * 0.12);
    const qrPixel = outer - ribbonH - Math.round(outer * 0.03);
    return {
      outer,
      qrPixel,
      qrX: Math.round((outer - qrPixel) / 2),
      qrY: 0,
      ribbon: {
        x: Math.round(outer * 0.08),
        y: qrPixel + Math.round(outer * 0.02),
        width: outer - Math.round(outer * 0.16),
        height: ribbonH,
      },
      card: null,
    };
  }
  // callout
  const pad = Math.round(outer * 0.06);
  const ribbonH = Math.round(outer * 0.13);
  const innerPad = Math.round(outer * 0.025);
  const cardX = 0;
  const cardY = 0;
  const cardW = outer;
  const cardH = outer;
  const qrAreaTop = pad;
  const qrAreaBottom = cardH - pad - ribbonH;
  const qrPixel = Math.min(cardW - pad * 2, qrAreaBottom - qrAreaTop) - innerPad * 2;
  const qrX = Math.round((outer - qrPixel) / 2);
  const qrY = qrAreaTop + innerPad;
  return {
    outer,
    qrPixel,
    qrX,
    qrY,
    ribbon: {
      x: pad,
      y: qrAreaBottom + innerPad,
      width: cardW - pad * 2,
      height: ribbonH - innerPad,
    },
    card: { x: cardX, y: cardY, width: cardW, height: cardH, r: spec.frame.cornerRadius },
  };
}

/**
 * Renders frame chrome as positioned absolute layers. The QR (rendered
 * imperatively by qr-code-styling) is positioned via inline style.
 */
export function FrameChrome({
  frame,
  geometry,
}: {
  frame: FrameSpec;
  geometry: FrameGeometry;
}) {
  if (frame.kind === 'none') return null;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={geometry.outer}
      height={geometry.outer}
      viewBox={`0 0 ${geometry.outer} ${geometry.outer}`}
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
      }}
    >
      {/* Card */}
      {geometry.card && (
        <rect
          x={geometry.card.x}
          y={geometry.card.y}
          width={geometry.card.width}
          height={geometry.card.height}
          rx={geometry.card.r}
          ry={geometry.card.r}
          fill={frame.fill}
        />
      )}
      {/* Inner QR background plate (only for callout — the engine draws
          its own background but for transparent-bg engines we want a clean
          plate). */}
      {geometry.card && (
        <rect
          x={geometry.qrX - 6}
          y={geometry.qrY - 6}
          width={geometry.qrPixel + 12}
          height={geometry.qrPixel + 12}
          rx={Math.max(4, geometry.card.r * 0.4)}
          fill={frame.innerBackground}
        />
      )}
      {/* Ribbon */}
      {geometry.ribbon && (
        <g>
          <rect
            x={geometry.ribbon.x}
            y={geometry.ribbon.y}
            width={geometry.ribbon.width}
            height={geometry.ribbon.height}
            rx={geometry.ribbon.height * 0.18}
            fill={
              frame.kind === 'callout' ? frame.accent : frame.fill
            }
          />
          <text
            x={geometry.ribbon.x + geometry.ribbon.width / 2}
            y={geometry.ribbon.y + geometry.ribbon.height / 2}
            textAnchor="middle"
            dominantBaseline="central"
            fontFamily="'IBM Plex Sans', system-ui, sans-serif"
            fontWeight={700}
            fontSize={fitRibbonFontSize(
              frame.text,
              geometry.ribbon.width,
              geometry.ribbon.height,
            )}
            letterSpacing="0.22em"
            fill={frame.kind === 'callout' ? frame.fill : frame.accent}
          >
            {frame.text.toUpperCase()}
          </text>
        </g>
      )}
    </svg>
  );
}

// -----------------------------------------------------------------------------
// Text fitting
//
// Compute a font size that keeps the (uppercase, tracked) tagline inside the
// ribbon. Uses a deterministic glyph-width estimator instead of DOM
// measurement so SVG preview, SVG export, and canvas export all produce the
// same result — the user never sees the preview disagree with the file.
//
// Empirically (IBM Plex Sans 700, tracked 0.22em):
//   - average uppercase glyph ≈ 0.62 × fontSize
//   - inter-letter gap        ≈ 0.22 × fontSize between each pair
//   - line width(F) ≈ F × (0.84·N − 0.22)
// We aim to fill ~88 % of the ribbon's interior width and never exceed the
// base size (0.42 × ribbon height), and never shrink below 5pt-equivalent
// regardless of length — at which point we just let it clip rather than
// produce illegible micro-type.
// -----------------------------------------------------------------------------

export function fitRibbonFontSize(text: string, ribbonWidth: number, ribbonHeight: number): number {
  const baseSize = ribbonHeight * 0.42;
  const trimmed = text.trim();
  if (!trimmed) return baseSize;
  const n = trimmed.length;
  const targetWidth = ribbonWidth * 0.88;
  const glyphFactor = Math.max(0.84 * n - 0.22, 0.1);
  const fitted = targetWidth / glyphFactor;
  return clamp(Math.min(baseSize, fitted), Math.min(baseSize, 5), baseSize);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Renders the frame chrome as a standalone SVG document string — used when
 * exporting a composite (frame + QR) to a single SVG/PNG file. The caller
 * supplies the inner QR as an SVG fragment that gets nested inside.
 */
export function composeFramedSvg(args: {
  spec: QrStyleSpec;
  outerSize: number;
  /** The inner styled QR rendered to an SVG string (full <svg>…</svg>). */
  qrSvg: string;
}): string {
  const { spec, outerSize, qrSvg } = args;
  const geo = computeFrameGeometry(spec, outerSize);
  const innerQrSvg = injectAttrs(qrSvg, {
    x: String(geo.qrX),
    y: String(geo.qrY),
    width: String(geo.qrPixel),
    height: String(geo.qrPixel),
    overflow: 'visible',
  });
  const card = geo.card
    ? `<rect x="${geo.card.x}" y="${geo.card.y}" width="${geo.card.width}" height="${geo.card.height}" rx="${geo.card.r}" ry="${geo.card.r}" fill="${spec.frame.fill}"/>` +
      `<rect x="${geo.qrX - 6}" y="${geo.qrY - 6}" width="${geo.qrPixel + 12}" height="${geo.qrPixel + 12}" rx="${Math.max(4, geo.card.r * 0.4)}" fill="${spec.frame.innerBackground}"/>`
    : '';
  const ribbon = geo.ribbon
    ? renderRibbon(geo.ribbon, spec.frame)
    : '';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${outerSize} ${outerSize}" width="${outerSize}" height="${outerSize}">` +
    card +
    innerQrSvg +
    ribbon +
    `</svg>`
  );
}

function renderRibbon(
  r: { x: number; y: number; width: number; height: number },
  f: FrameSpec,
): string {
  const fill = f.kind === 'callout' ? f.accent : f.fill;
  const color = f.kind === 'callout' ? f.fill : f.accent;
  const fontSize = fitRibbonFontSize(f.text, r.width, r.height);
  const cx = r.x + r.width / 2;
  const cy = r.y + r.height / 2;
  return (
    `<rect x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}" rx="${r.height * 0.18}" fill="${fill}"/>` +
    `<text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central" ` +
    `font-family="'IBM Plex Sans', system-ui, sans-serif" font-weight="700" ` +
    `font-size="${fontSize}" letter-spacing="0.22em" fill="${color}">` +
    escapeXml(f.text.toUpperCase()) +
    `</text>`
  );
}

function injectAttrs(svg: string, attrs: Record<string, string>): string {
  // Replace the root <svg ...> opening tag with one that has our attrs.
  // The library emits <svg width=… height=… viewBox=… xmlns=…> — we keep
  // viewBox/xmlns and add positioning attrs that nested svg-in-svg needs.
  const attrString = Object.entries(attrs)
    .map(([k, v]) => `${k}="${v}"`)
    .join(' ');
  return svg.replace(/<svg\s+([^>]*?)>/, (_, existing: string) => {
    // Strip any width/height on the inner SVG so our injected ones apply.
    const cleaned = existing
      .replace(/\s*width="[^"]*"/, '')
      .replace(/\s*height="[^"]*"/, '');
    return `<svg ${cleaned} ${attrString}>`;
  });
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
