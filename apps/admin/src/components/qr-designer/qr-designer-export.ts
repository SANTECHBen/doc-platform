'use client';

// Export pipeline for the QR Code Designer. Given a QrStyleSpec, produces
// a single artifact (SVG or PNG) at a chosen pixel size. When the spec
// includes a frame, the frame chrome is composited around the QR.
//
// Two composition paths, chosen by output format:
//   - SVG: pure-string composition — the engine emits the inner QR as SVG
//     and we wrap it with a frame SVG via composeFramedSvg().
//   - PNG: pure canvas-2D composition — the engine renders the inner QR
//     into a PNG blob, we load that as an Image, then draw it into a
//     larger canvas alongside frame chrome drawn with ctx.fill/text/etc.
//     This sidesteps the SVG→Image→canvas rasterization path, which is
//     unreliable when the SVG embeds large data: URIs (e.g. a logo).

import { renderStyledQrToBlob } from './qr-style-preview';
import { composeFramedSvg, computeFrameGeometry } from './qr-frame';
import type { FrameSpec, QrStyleSpec } from '@/lib/qr-style';

export type QrExportFormat = 'svg' | 'png-512' | 'png-1024' | 'png-2048' | 'png-4096';

export const QR_EXPORT_PRESETS: Record<QrExportFormat, { label: string; pixels: number }> = {
  svg: { label: 'SVG (vector)', pixels: 1024 },
  'png-512': { label: 'PNG · 512 px', pixels: 512 },
  'png-1024': { label: 'PNG · 1024 px', pixels: 1024 },
  'png-2048': { label: 'PNG · 2048 px', pixels: 2048 },
  'png-4096': { label: 'PNG · 4096 px (ultra)', pixels: 4096 },
};

export interface ExportArgs {
  spec: QrStyleSpec;
  format: QrExportFormat;
  filename: string; // without extension
}

export async function exportDesignedQr(args: ExportArgs): Promise<void> {
  const { spec, format, filename } = args;
  const preset = QR_EXPORT_PRESETS[format];
  if (format === 'svg') {
    const svg = await buildSvg(spec, preset.pixels);
    downloadBlob(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }), `${filename}.svg`);
    return;
  }
  const blob = await buildPng(spec, preset.pixels);
  downloadBlob(blob, `${filename}.png`);
}

// -----------------------------------------------------------------------------
// SVG path — string composition only.
// -----------------------------------------------------------------------------

async function buildSvg(spec: QrStyleSpec, outerSize: number): Promise<string> {
  if (spec.frame.kind === 'none') {
    const qrBlob = await renderStyledQrToBlob(spec, outerSize, 'svg');
    return await qrBlob.text();
  }
  const geo = computeFrameGeometry(spec, outerSize);
  const qrBlob = await renderStyledQrToBlob(spec, geo.qrPixel, 'svg');
  const innerSvg = await qrBlob.text();
  return composeFramedSvg({ spec, outerSize, qrSvg: innerSvg });
}

// -----------------------------------------------------------------------------
// PNG path — canvas-2D composition.
// -----------------------------------------------------------------------------

async function buildPng(spec: QrStyleSpec, outerSize: number): Promise<Blob> {
  await waitForFonts();
  if (spec.frame.kind === 'none') {
    // No frame → use the engine's native canvas backend directly. Sharpest
    // possible result because modules render pixel-aligned.
    return await renderStyledQrToBlob(spec, outerSize, 'png');
  }
  const geo = computeFrameGeometry(spec, outerSize);

  // Render the inner QR to a PNG blob, then bring it onto the composite
  // canvas as an Image. The engine takes care of the logo embedding.
  const qrBlob = await renderStyledQrToBlob(spec, geo.qrPixel, 'png');
  const qrImg = await blobToImage(qrBlob);

  const canvas = document.createElement('canvas');
  canvas.width = outerSize;
  canvas.height = outerSize;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  // Card background (callout only). For ribbon kind there's no card — the
  // QR sits on whatever the page is, and the ribbon hangs underneath.
  if (geo.card) {
    drawRoundedRect(ctx, geo.card.x, geo.card.y, geo.card.width, geo.card.height, geo.card.r);
    ctx.fillStyle = spec.frame.fill;
    ctx.fill();
    // Inner background plate beneath the QR — gives the QR its own light
    // surface even when the card is dark.
    const plateInset = Math.round(outerSize * 0.015);
    drawRoundedRect(
      ctx,
      geo.qrX - plateInset,
      geo.qrY - plateInset,
      geo.qrPixel + plateInset * 2,
      geo.qrPixel + plateInset * 2,
      Math.max(plateInset, geo.card.r * 0.4),
    );
    ctx.fillStyle = spec.frame.innerBackground;
    ctx.fill();
  }

  // The QR itself.
  ctx.drawImage(qrImg, geo.qrX, geo.qrY, geo.qrPixel, geo.qrPixel);

  // Ribbon.
  if (geo.ribbon) {
    drawRibbon(ctx, geo.ribbon, spec.frame);
  }

  return await canvasToBlob(canvas);
}

// -----------------------------------------------------------------------------
// Canvas drawing helpers
// -----------------------------------------------------------------------------

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  // Quadratic-curve corners. We avoid the native `roundRect` because TS lib
  // types narrow ctx to `never` on the fallback branch in some versions,
  // and a manual path costs effectively nothing for a single-shot draw.
  const radius = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function drawRibbon(
  ctx: CanvasRenderingContext2D,
  ribbon: { x: number; y: number; width: number; height: number },
  frame: FrameSpec,
): void {
  const fill = frame.kind === 'callout' ? frame.accent : frame.fill;
  const color = frame.kind === 'callout' ? frame.fill : frame.accent;
  drawRoundedRect(ctx, ribbon.x, ribbon.y, ribbon.width, ribbon.height, ribbon.height * 0.18);
  ctx.fillStyle = fill;
  ctx.fill();

  // Text — IBM Plex Sans loaded on the page, tracked uppercase.
  const fontSize = ribbon.height * 0.42;
  ctx.font = `700 ${fontSize}px "IBM Plex Sans", system-ui, sans-serif`;
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // letterSpacing on CanvasRenderingContext2D is supported in Chrome 99+ and
  // Safari 16.4+. Where unsupported, the text just renders without the
  // tracked look — content is still legible.
  const ctxAny = ctx as CanvasRenderingContext2D & { letterSpacing?: string };
  const prevSpacing = ctxAny.letterSpacing;
  try {
    ctxAny.letterSpacing = `${fontSize * 0.22}px`;
    ctx.fillText(
      frame.text.toUpperCase(),
      ribbon.x + ribbon.width / 2,
      ribbon.y + ribbon.height / 2 + ribbon.height * 0.06,
    );
  } finally {
    if (prevSpacing !== undefined) ctxAny.letterSpacing = prevSpacing;
  }
}

async function waitForFonts(): Promise<void> {
  if (typeof document === 'undefined' || !document.fonts) return;
  try {
    await document.fonts.ready;
  } catch {
    // best-effort
  }
}

function blobToImage(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      // Hold the URL alive long enough for the image to be drawn at least
      // once. The caller revokes via finally — we don't here because we
      // don't know when the caller is done with the image.
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not load QR image for compositing'));
    };
    img.src = url;
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

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
