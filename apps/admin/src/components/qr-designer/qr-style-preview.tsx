'use client';

// Imperative-to-declarative bridge for the `qr-code-styling` engine. The
// library mutates a DOM container in place; we mount one instance per
// component, then call `update()` whenever the QrStyleSpec changes. The
// preview is rendered inside an absolutely-positioned canvas wrapper so
// surrounding chrome (frame, ribbon) can be drawn around it via overlaid
// SVG/CSS without fighting the library's mutation.

import { useEffect, useImperativeHandle, useRef, forwardRef } from 'react';
import { toEngineOptions, type QrStyleSpec } from '@/lib/qr-style';

export interface QrStylePreviewHandle {
  /** Render the QR to a Blob in the requested format. */
  getBlob: (extension: 'svg' | 'png' | 'jpeg' | 'webp') => Promise<Blob>;
  /** Render the QR to a Data URL (mainly for inline previewing). */
  getDataUrl: (extension: 'svg' | 'png') => Promise<string>;
}

export interface QrStylePreviewProps {
  spec: QrStyleSpec;
  /** Pixel size of the QR canvas in the DOM. Independent of export size. */
  pixelSize: number;
  /** Optional className applied to the container. */
  className?: string;
}

export const QrStylePreview = forwardRef<QrStylePreviewHandle, QrStylePreviewProps>(
  function QrStylePreview({ spec, pixelSize, className }, ref) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    // We hold the library instance in a ref so React's render cycle never
    // recreates it — instead we call .update() with new options.
    const engineRef = useRef<unknown>(null);

    useEffect(() => {
      let cancelled = false;
      // Dynamically import to avoid SSR — the library reaches for `window` /
      // DOM APIs at top level in some code paths.
      (async () => {
        const mod = await import('qr-code-styling');
        if (cancelled) return;
        const QRCodeStyling = mod.default;
        const container = containerRef.current;
        if (!container) return;
        if (!engineRef.current) {
          const instance = new QRCodeStyling(toEngineOptions(spec, pixelSize));
          engineRef.current = instance;
          // Clear any stale children before appending — important when React
          // re-mounts the component after Fast Refresh.
          container.innerHTML = '';
          instance.append(container);
        } else {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (engineRef.current as any).update(toEngineOptions(spec, pixelSize));
        }
      })();
      return () => {
        cancelled = true;
      };
    }, [spec, pixelSize]);

    useImperativeHandle(
      ref,
      () => {
        const getBlob = async (extension: 'svg' | 'png' | 'jpeg' | 'webp'): Promise<Blob> => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const engine = engineRef.current as any;
          if (!engine) throw new Error('QR engine not initialized');
          const blob = await engine.getRawData(extension);
          if (!blob) throw new Error('QR engine returned no data');
          // The engine sometimes returns a Node Buffer when polyfills are
          // active; coerce to Blob explicitly for the browser path.
          if (blob instanceof Blob) return blob;
          return new Blob([blob], { type: mimeFor(extension) });
        };
        return {
          getBlob,
          async getDataUrl(extension) {
            const blob = await getBlob(extension);
            return await blobToDataUrl(blob);
          },
        };
      },
      [],
    );

    return (
      <div
        ref={containerRef}
        className={className}
        style={{ width: pixelSize, height: pixelSize, lineHeight: 0 }}
      />
    );
  },
);

function mimeFor(extension: 'svg' | 'png' | 'jpeg' | 'webp'): string {
  switch (extension) {
    case 'svg':
      return 'image/svg+xml';
    case 'png':
      return 'image/png';
    case 'jpeg':
      return 'image/jpeg';
    case 'webp':
      return 'image/webp';
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/**
 * One-shot export helper — instantiates an off-screen engine at the
 * requested pixel size and returns the Blob. Used for high-resolution PNG
 * downloads where the on-screen preview is too small to be the source.
 */
export async function renderStyledQrToBlob(
  spec: QrStyleSpec,
  pixelSize: number,
  extension: 'svg' | 'png' | 'jpeg' | 'webp',
): Promise<Blob> {
  const mod = await import('qr-code-styling');
  const QRCodeStyling = mod.default;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const instance = new QRCodeStyling(toEngineOptions(spec, pixelSize)) as any;
  const raw = await instance.getRawData(extension);
  if (!raw) throw new Error('QR engine returned no data');
  if (raw instanceof Blob) return raw;
  return new Blob([raw], { type: mimeFor(extension) });
}
