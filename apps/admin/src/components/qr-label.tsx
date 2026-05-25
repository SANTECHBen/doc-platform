'use client';

// Compatibility surface for the QR placard renderer. The real implementation
// is `qr-label-svg.tsx` — a single SVG-native renderer that drives the live
// preview, the print sheet, and the high-resolution download exports.
//
// This shim preserves the legacy `QrLabel` / `QR_LABEL_CSS` import names
// so existing call sites don't need to be touched.

export {
  QrLabelSvg as QrLabel,
  type QrLabelTemplate,
  type QrLabelData,
  type QrLabelFields,
  type QrLabelProps,
  type LabelLayout,
} from './qr-label-svg';

// Legacy CSS hook — the SVG renderer is self-contained, so no global CSS is
// required. Kept exported as an empty string for backwards compatibility with
// call sites that inject it via <style jsx global>.
export const QR_LABEL_CSS = '';
