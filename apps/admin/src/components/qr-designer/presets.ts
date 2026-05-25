'use client';

// Curated style presets the designer offers as one-click starting points.
// Each preset is a partial QrStyleSpec patch — applying it leaves the
// content (the URL) and any uploaded logo untouched.
//
// Presets cover the design space deliberately: classic, premium, branded,
// playful, dense-print, and a couple of bold gradient looks. Each one is
// scan-tested at H error correction with a centered 22% logo overlay so
// they're production-safe defaults.

import type { QrStyleSpec } from '@/lib/qr-style';

export interface QrStylePreset {
  id: string;
  label: string;
  /** Short tagline shown under the preset name in the gallery row. */
  hint: string;
  /** The patch applied on click. Content fields (data, logo.src) are
   *  intentionally omitted so user-supplied content is preserved. */
  patch: Omit<Partial<QrStyleSpec>, 'data'>;
}

export const QR_STYLE_PRESETS: QrStylePreset[] = [
  {
    id: 'classic-square',
    label: 'Classic',
    hint: 'Square modules, max compatibility',
    patch: {
      dotShape: 'square',
      dotColor: { mode: 'solid', color: '#0a0c0f' },
      eyeOuterShape: 'square',
      eyeOuterColor: { mode: 'solid', color: '#0a0c0f' },
      eyeInnerShape: 'square',
      eyeInnerColor: { mode: 'solid', color: '#0a0c0f' },
      background: { mode: 'solid', color: '#ffffff' },
    },
  },
  {
    id: 'rounded-soft',
    label: 'Rounded',
    hint: 'Friendly, modern modules',
    patch: {
      dotShape: 'rounded',
      dotColor: { mode: 'solid', color: '#0a0c0f' },
      eyeOuterShape: 'extra-rounded',
      eyeOuterColor: { mode: 'solid', color: '#0a0c0f' },
      eyeInnerShape: 'dot',
      eyeInnerColor: { mode: 'solid', color: '#0a0c0f' },
      background: { mode: 'solid', color: '#ffffff' },
    },
  },
  {
    id: 'dots',
    label: 'Dots',
    hint: 'All-circle modules, premium feel',
    patch: {
      dotShape: 'dots',
      dotColor: { mode: 'solid', color: '#0a0c0f' },
      eyeOuterShape: 'extra-rounded',
      eyeOuterColor: { mode: 'solid', color: '#0a0c0f' },
      eyeInnerShape: 'dot',
      eyeInnerColor: { mode: 'solid', color: '#0a0c0f' },
      background: { mode: 'solid', color: '#ffffff' },
    },
  },
  {
    id: 'classy',
    label: 'Classy',
    hint: 'Asymmetric premium pattern',
    patch: {
      dotShape: 'classy-rounded',
      dotColor: { mode: 'solid', color: '#0a0c0f' },
      eyeOuterShape: 'extra-rounded',
      eyeOuterColor: { mode: 'solid', color: '#0a0c0f' },
      eyeInnerShape: 'dot',
      eyeInnerColor: { mode: 'solid', color: '#0a0c0f' },
      background: { mode: 'solid', color: '#ffffff' },
    },
  },
  {
    id: 'brand-blue',
    label: 'Brand Blue',
    hint: 'Equipment Hub primary',
    patch: {
      dotShape: 'rounded',
      dotColor: { mode: 'solid', color: '#0B5FBF' },
      eyeOuterShape: 'extra-rounded',
      eyeOuterColor: { mode: 'solid', color: '#0B5FBF' },
      eyeInnerShape: 'dot',
      eyeInnerColor: { mode: 'solid', color: '#0B5FBF' },
      background: { mode: 'solid', color: '#ffffff' },
    },
  },
  {
    id: 'safety-yellow',
    label: 'Safety',
    hint: 'High-vis hazard yellow',
    patch: {
      dotShape: 'square',
      dotColor: { mode: 'solid', color: '#0a0c0f' },
      eyeOuterShape: 'square',
      eyeOuterColor: { mode: 'solid', color: '#0a0c0f' },
      eyeInnerShape: 'square',
      eyeInnerColor: { mode: 'solid', color: '#0a0c0f' },
      background: { mode: 'solid', color: '#FFD400' },
    },
  },
  {
    id: 'midnight',
    label: 'Midnight',
    hint: 'Dark-mode invert',
    patch: {
      dotShape: 'rounded',
      dotColor: { mode: 'solid', color: '#e5e7eb' },
      eyeOuterShape: 'extra-rounded',
      eyeOuterColor: { mode: 'solid', color: '#ffffff' },
      eyeInnerShape: 'dot',
      eyeInnerColor: { mode: 'solid', color: '#ffffff' },
      background: { mode: 'solid', color: '#0a0c0f' },
    },
  },
  {
    id: 'sunset',
    label: 'Sunset',
    hint: 'Warm gradient',
    patch: {
      dotShape: 'rounded',
      dotColor: {
        mode: 'linear',
        rotation: 45,
        stops: [
          { offset: 0, color: '#F97316' },
          { offset: 1, color: '#EC4899' },
        ],
      },
      eyeOuterShape: 'extra-rounded',
      eyeOuterColor: { mode: 'solid', color: '#7C2D12' },
      eyeInnerShape: 'dot',
      eyeInnerColor: { mode: 'solid', color: '#9A3412' },
      background: { mode: 'solid', color: '#FFF7ED' },
    },
  },
  {
    id: 'ocean',
    label: 'Ocean',
    hint: 'Cool teal gradient',
    patch: {
      dotShape: 'dots',
      dotColor: {
        mode: 'linear',
        rotation: 135,
        stops: [
          { offset: 0, color: '#0EA5E9' },
          { offset: 1, color: '#1E40AF' },
        ],
      },
      eyeOuterShape: 'extra-rounded',
      eyeOuterColor: { mode: 'solid', color: '#1E3A8A' },
      eyeInnerShape: 'dot',
      eyeInnerColor: { mode: 'solid', color: '#1E40AF' },
      background: { mode: 'solid', color: '#F0F9FF' },
    },
  },
  {
    id: 'forest',
    label: 'Forest',
    hint: 'Verdant radial',
    patch: {
      dotShape: 'extra-rounded',
      dotColor: {
        mode: 'radial',
        rotation: 0,
        stops: [
          { offset: 0, color: '#16A34A' },
          { offset: 1, color: '#14532D' },
        ],
      },
      eyeOuterShape: 'extra-rounded',
      eyeOuterColor: { mode: 'solid', color: '#14532D' },
      eyeInnerShape: 'dot',
      eyeInnerColor: { mode: 'solid', color: '#166534' },
      background: { mode: 'solid', color: '#F0FDF4' },
    },
  },
  {
    id: 'mono-callout',
    label: 'Scan-Me card',
    hint: 'Dark frame with ribbon',
    patch: {
      dotShape: 'rounded',
      dotColor: { mode: 'solid', color: '#0a0c0f' },
      eyeOuterShape: 'extra-rounded',
      eyeOuterColor: { mode: 'solid', color: '#0a0c0f' },
      eyeInnerShape: 'dot',
      eyeInnerColor: { mode: 'solid', color: '#0a0c0f' },
      background: { mode: 'solid', color: '#ffffff' },
      frame: {
        kind: 'callout',
        text: 'SCAN ME',
        fill: '#0a0c0f',
        accent: '#ffffff',
        innerBackground: '#ffffff',
        cornerRadius: 28,
      },
    },
  },
  {
    id: 'brand-callout',
    label: 'Brand card',
    hint: 'Brand frame with ribbon',
    patch: {
      dotShape: 'rounded',
      dotColor: { mode: 'solid', color: '#0B5FBF' },
      eyeOuterShape: 'extra-rounded',
      eyeOuterColor: { mode: 'solid', color: '#0B5FBF' },
      eyeInnerShape: 'dot',
      eyeInnerColor: { mode: 'solid', color: '#0B5FBF' },
      background: { mode: 'solid', color: '#ffffff' },
      frame: {
        kind: 'callout',
        text: 'SCAN TO BEGIN',
        fill: '#0B5FBF',
        accent: '#ffffff',
        innerBackground: '#ffffff',
        cornerRadius: 28,
      },
    },
  },
];
