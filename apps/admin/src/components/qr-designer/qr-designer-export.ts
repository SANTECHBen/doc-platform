'use client';

// Export pipeline for the QR Code Designer. Given a QrStyleSpec, produces
// a single artifact (SVG or PNG) at a chosen pixel size. When the spec
// includes a frame, the frame chrome is composited around the QR.

import { renderStyledQrToBlob } from './qr-style-preview';
import { composeFramedSvg, computeFrameGeometry } from './qr-frame';
import type { QrStyleSpec } from '@/lib/qr-style';

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

/** Build the final SVG document — frame composited if present. */
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

/**
 * Build a PNG at the requested pixel size. We rasterize the composite SVG
 * to canvas — this gives the cleanest result because the frame chrome stays
 * vector until the final paint, and the QR engine's anti-aliasing is
 * preserved.
 */
async function buildPng(spec: QrStyleSpec, outerSize: number): Promise<Blob> {
  if (typeof document !== 'undefined' && document.fonts) {
    try {
      await document.fonts.ready;
    } catch {
      // best-effort
    }
  }
  if (spec.frame.kind === 'none') {
    // Direct PNG render is sharper than SVG→canvas for the bare QR case
    // because the engine's canvas backend draws modules pixel-aligned.
    return await renderStyledQrToBlob(spec, outerSize, 'png');
  }
  const svg = await buildSvg(spec, outerSize);
  return await svgStringToPng(svg, outerSize);
}

async function svgStringToPng(svg: string, pixels: number): Promise<Blob> {
  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImage(url);
    const canvas = document.createElement('canvas');
    canvas.width = pixels;
    canvas.height = pixels;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, pixels, pixels);
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
