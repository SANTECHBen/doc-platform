'use client';

// QR export utilities. Two flavors of artifact, two file formats each:
//   - Bare QR    (just the scannable code, no card/typography)
//   - Placard    (the full sticker — header, ident block, framed QR, footer)
//
//   - SVG        true vector. Scales to any size without quality loss; ideal
//                for sign-shop print, vinyl cutters, vehicle wraps.
//   - PNG        rasterized via canvas at the requested pixel size. Choose
//                from preset DPI buckets — "screen" (web/share),
//                "print" (300dpi at actual size), or "ultra" (600dpi).
//
// All functions run in the browser. No server-side render dependency means
// the same code path produces files identical to what the admin sees in the
// preview modal.

import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { QrLabelSvg, type QrLabelTemplate, type QrLabelData } from '@/components/qr-label-svg';

// -----------------------------------------------------------------------------
// SVG strings — single source of truth used by both file download and PNG
// rasterization. Each returned string is a complete, self-contained SVG
// document with an explicit width/height in pixels and an `xmlns` attribute.
// -----------------------------------------------------------------------------

export interface BareQrOptions {
  url: string;
  errorCorrection: 'L' | 'M' | 'Q' | 'H';
  /** Pixel width/height for the SVG's outer attributes. SVG is vector, so
   *  this only affects default display size — scaling is lossless. */
  pixelSize?: number;
  /** Modules of quiet zone around the symbol. QR spec requires 4. */
  quietZoneModules?: number;
  /** Foreground (module) color. Defaults to ink black for max contrast. */
  fgColor?: string;
  /** Background color. Defaults to white. */
  bgColor?: string;
}

/** Render just the QR code as a standalone SVG document. */
export function bareQrSvgString(opts: BareQrOptions): string {
  const {
    url,
    errorCorrection,
    pixelSize = 1024,
    quietZoneModules = 4,
    fgColor = '#0a0c0f',
    bgColor = '#ffffff',
  } = opts;
  const el = createElement(QRCodeSVG, {
    value: url,
    size: pixelSize,
    level: errorCorrection,
    marginSize: quietZoneModules,
    bgColor,
    fgColor,
    xmlns: 'http://www.w3.org/2000/svg',
  });
  const inner = renderToStaticMarkup(el);
  // qrcode.react emits an <svg> root; we want to ensure it has the xmlns
  // attribute even if React stripped it. Inject if missing.
  return ensureXmlns(inner);
}

/** Render the full placard as a standalone SVG document. */
export function placardSvgString(template: QrLabelTemplate, data: QrLabelData): string {
  const el = createElement(QrLabelSvg, { template, data, size: '720' });
  const inner = renderToStaticMarkup(el);
  return ensureXmlns(inner);
}

function ensureXmlns(svg: string): string {
  if (/xmlns=/.test(svg.slice(0, 200))) return svg;
  return svg.replace(/^<svg/, '<svg xmlns="http://www.w3.org/2000/svg"');
}

// -----------------------------------------------------------------------------
// PNG rasterization. SVG → blob URL → HTMLImageElement → canvas → PNG blob.
// Works entirely client-side. Fonts must already be loaded in the page
// (the admin app loads IBM Plex Sans/Mono via next/font, and we call
// document.fonts.ready before drawing).
// -----------------------------------------------------------------------------

export interface PngOptions {
  /** Target output width in pixels. Height matches (placard is square). */
  pixels: number;
  /** Optional flat background fill — useful for transparent SVGs that need
   *  a solid background in the PNG (e.g. for use on dark sites). */
  background?: string;
}

/** Convert an SVG document string into a PNG Blob at the given pixel size. */
export async function svgToPngBlob(svg: string, opts: PngOptions): Promise<Blob> {
  await waitForFonts();
  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImage(url);
    const canvas = document.createElement('canvas');
    // Use devicePixelRatio-aware sizing: pixels is already the target output;
    // we draw 1:1 into a canvas of that size, which gives a crisp file.
    canvas.width = opts.pixels;
    canvas.height = opts.pixels;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    if (opts.background) {
      ctx.fillStyle = opts.background;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    // High-quality scaling for the QR modules and typography.
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await canvasToBlob(canvas);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to rasterize SVG'));
    img.src = src;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => {
        if (b) resolve(b);
        else reject(new Error('Canvas toBlob returned null'));
      },
      'image/png',
      1.0,
    );
  });
}

async function waitForFonts(): Promise<void> {
  if (typeof document === 'undefined' || !document.fonts) return;
  try {
    await document.fonts.ready;
  } catch {
    // Best-effort — proceed even if fonts didn't resolve.
  }
}

// -----------------------------------------------------------------------------
// File download helpers
// -----------------------------------------------------------------------------

/** Trigger a browser download of a string as a UTF-8 file. */
export function downloadString(text: string, mimeType: string, filename: string): void {
  const blob = new Blob([text], { type: `${mimeType};charset=utf-8` });
  downloadBlob(blob, filename);
}

/** Trigger a browser download of a binary Blob. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the browser a tick before revoking the URL so the download can finish.
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

// -----------------------------------------------------------------------------
// High-level "one-shot" download helpers
// -----------------------------------------------------------------------------

export type ExportFormat = 'svg' | 'png-screen' | 'png-print' | 'png-ultra';

/** Pixel size for each PNG preset. Placard at 2.5", QR at any size — both
 *  square. Bucketed for the picker; finer control isn't worth the UI cost. */
export const PNG_PRESET_PX: Record<Exclude<ExportFormat, 'svg'>, number> = {
  'png-screen': 1024,
  'png-print': 1800, // ~720dpi at 2.5"
  'png-ultra': 3600, // ~1440dpi at 2.5"
};

export const FORMAT_LABEL: Record<ExportFormat, string> = {
  svg: 'SVG (vector)',
  'png-screen': 'PNG · 1024 px',
  'png-print': 'PNG · 1800 px (print)',
  'png-ultra': 'PNG · 3600 px (ultra)',
};

export interface DownloadBareQrParams {
  url: string;
  errorCorrection: 'L' | 'M' | 'Q' | 'H';
  format: ExportFormat;
  filenameBase: string; // e.g. "qr-DEMO123ABCD"
}

export async function downloadBareQr(params: DownloadBareQrParams): Promise<void> {
  const { url, errorCorrection, format, filenameBase } = params;
  if (format === 'svg') {
    const svg = bareQrSvgString({ url, errorCorrection, pixelSize: 1024 });
    downloadString(svg, 'image/svg+xml', `${filenameBase}.svg`);
    return;
  }
  const px = PNG_PRESET_PX[format];
  // For bare QR PNGs, use a tighter SVG (px-sized) for accurate raster.
  const svg = bareQrSvgString({ url, errorCorrection, pixelSize: px });
  const blob = await svgToPngBlob(svg, { pixels: px, background: '#ffffff' });
  downloadBlob(blob, `${filenameBase}.png`);
}

export interface DownloadPlacardParams {
  template: QrLabelTemplate;
  data: QrLabelData;
  format: ExportFormat;
  filenameBase: string; // e.g. "placard-DEMO123ABCD"
}

export async function downloadPlacard(params: DownloadPlacardParams): Promise<void> {
  const { template, data, format, filenameBase } = params;
  const svg = placardSvgString(template, data);
  if (format === 'svg') {
    downloadString(svg, 'image/svg+xml', `${filenameBase}.svg`);
    return;
  }
  const px = PNG_PRESET_PX[format];
  const blob = await svgToPngBlob(svg, { pixels: px, background: '#ffffff' });
  downloadBlob(blob, `${filenameBase}.png`);
}

/** Sanitize a string for use as a filename — keep it conservative across
 *  Windows / macOS / Linux. */
export function safeFilename(input: string): string {
  return (
    input
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'qr-code'
  );
}
